/**
 * Octo transport: bot registration, the WuKongIM WebSocket, the online
 * heartbeat, and text send/typing. Emits normalized inbound messages.
 * @module codex-octo-channel/port
 */
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { WKSocket } from "./protocol/socket.js";
import {
  getPresignedUpload,
  pngSizeOf,
  registerBot,
  sendHeartbeat,
  sendMediaMessage,
  sendMessage as apiSendMessage,
  sendTyping,
  uploadToPresignedUrl,
} from "./protocol/api-fetch.js";
import { ChannelType, MessageType, type BotMessage, type MentionPayload } from "./protocol/types.js";

/** One normalized inbound Octo message ready for the channel layer. */
export interface OctoMessage {
  /** DM: the peer user UID; group/thread: the channel id verbatim. */
  readonly chatId: string;
  /** 1 = DM, 2 = group, 5 = thread. */
  readonly channelType: number;
  readonly senderId: string;
  readonly messageId: string;
  readonly content: string;
  /** True when this message @-mentions the bot. */
  readonly botMentioned: boolean;
  readonly timestamp: number;
}

/** One outbound text payload. markdown and text both ride payload.type=1. */
export interface OctoSendInput {
  readonly text?: string | undefined;
  readonly markdown?: string | undefined;
}

export interface OctoSendOptions {
  /** Reply in-thread to this message id. */
  readonly replyTo?: string | undefined;
  /** Channel type of the target; defaults to DM. */
  readonly channelType?: number | undefined;
  /** UIDs to @-mention in the reply (usually the sender in groups). */
  readonly mentionUids?: string[] | undefined;
}

export interface OctoSendResult {
  readonly messageId: string;
}

export interface OctoPortConfig {
  readonly botToken: string;
  readonly apiUrl: string;
  readonly wsUrl?: string | undefined;
  readonly heartbeatIntervalMs: number;
  readonly pluginVersion: string;
  /** Diagnostic sink for outbound sends (keeps ack/reply delivery observable). */
  readonly log?: ((line: string) => void) | undefined;
}

/** How many processed message ids to remember for dedupe. */
const SEEN_CAPACITY = 500;
/** Re-assert the typing indicator on this cadence while a turn is live. */
export const TYPING_INTERVAL_MS = 10_000;

function isFlag(value: boolean | number | undefined): boolean {
  return value === true || value === 1;
}

/** All uids a mention payload refers to (uids list plus structured entities). */
export function mentionUidsOf(mention: MentionPayload | undefined): string[] {
  if (mention === undefined) return [];
  const uids = new Set<string>(mention.uids ?? []);
  for (const entity of mention.entities ?? []) uids.add(entity.uid);
  return [...uids];
}

/** Extract the text a model should see from one inbound payload. */
export function extractText(message: BotMessage): string {
  const payload = message.payload;
  switch (payload.type) {
    case MessageType.Text:
      return typeof payload.content === "string" ? payload.content : "";
    case MessageType.RichText: {
      const plain = payload.plain;
      if (typeof plain === "string" && plain !== "") return plain;
      const blocks = payload.content;
      if (Array.isArray(blocks)) {
        return blocks
          .map((block) => (block as { text?: unknown })?.text)
          .filter((text): text is string => typeof text === "string" && text !== "")
          .join("");
      }
      return "";
    }
    case MessageType.InteractiveCard: {
      const plain = payload.plain;
      return typeof plain === "string" && plain !== "" ? plain : "[卡片]";
    }
    default:
      return "";
  }
}

/**
 * The Octo channel transport. One instance per bot account; the WuKongIM
 * socket owns its own reconnect loop, this class owns registration,
 * heartbeat, dedupe, and outbound calls.
 */
export class OctoPort extends EventEmitter {
  /** The bot uid in Octo: its robot_id (mention gating and self-filter). */
  robotId: string | undefined;
  /** The bot owner uid from the register response (DM target). */
  ownerUid: string | undefined;
  private readonly config: OctoPortConfig;
  private socket: WKSocket | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private seen = new Set<string>();
  private connecting: Promise<void> | undefined;
  private reconnectingRegistration: Promise<void> | undefined;
  private stopped = true;

  constructor(config: OctoPortConfig) {
    super();
    this.config = config;
  }

  /** Register the bot, await CONNACK, and start the heartbeat.
   * @returns A promise settled only after the transport is usable.
   */
  connect(): Promise<void> {
    this.stopped = false;
    if (this.connecting === undefined) {
      this.connecting = this.connectOnce(false).catch((error: unknown) => {
        this.connecting = undefined;
        throw error;
      });
    }
    return this.connecting;
  }

  /** Subscribe to normalized inbound messages; returns the unsubscriber. */
  onMessage(handler: (message: OctoMessage) => void | Promise<void>): () => void {
    this.on("message", handler);
    return () => {
      this.off("message", handler);
    };
  }

  /** Subscribe to one raw lifecycle event; returns the unsubscriber. */
  onLifecycle(
    event: "reconnecting" | "reconnected" | "error" | "heartbeat-failed",
    handler: (value?: Error) => void,
  ): () => void {
    this.on(event, handler);
    return () => {
      this.off(event, handler);
    };
  }

  /** Stop timers, cancel reconnect, and drain the current socket.
   * @returns A promise settled after transport teardown.
   */
  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    await socket?.disconnectAndWait();
    await this.connecting?.catch(() => undefined);
    await this.reconnectingRegistration?.catch(() => undefined);
    this.connecting = undefined;
  }

  /** Register once and wait for a real WuKongIM CONNACK.
   * @param forceRefresh - request a fresh server-side registration.
   * @returns A promise settled after registration and handshake.
   */
  private async connectOnce(forceRefresh: boolean): Promise<void> {
    const registered = await registerBot({
      apiUrl: this.config.apiUrl,
      botToken: this.config.botToken,
      forceRefresh,
      agentPlatform: "codex",
      pluginVersion: this.config.pluginVersion,
    });
    if (this.stopped) throw new Error("octo: port stopped during registration");
    this.robotId = registered.robot_id;
    this.ownerUid = registered.owner_uid;
    const wsUrl = this.config.wsUrl ?? registered.ws_url;
    if (wsUrl === undefined || wsUrl === "") throw new Error("octo: no WebSocket URL - the register response carries none and config.wsUrl is unset");
    const socket = new WKSocket({
      wsUrl,
      uid: registered.robot_id,
      token: registered.im_token,
      onMessage: (message) => this.handleSocketMessage(message),
      onConnected: () => this.emit("reconnected"),
      onDisconnected: () => this.emit("reconnecting"),
      onError: (error: Error) => {
        this.emit("error", error);
        void this.reregisterAfterFatal(error);
      },
    });
    this.socket = socket;
    await socket.connect();
    if (!this.stopped) this.startHeartbeat();
  }

  /** Re-register after a fatal handshake or authentication failure.
   * @param cause - fatal socket error for diagnostics.
   * @returns A promise settled after a replacement connection is ready.
   */
  private async reregisterAfterFatal(cause: Error): Promise<void> {
    if (this.stopped || this.reconnectingRegistration !== undefined) return;
    this.reconnectingRegistration = (async () => {
      this.emit("reconnecting", cause);
      if (this.heartbeatTimer !== undefined) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      }
      const previous = this.socket;
      this.socket = undefined;
      await previous?.disconnectAndWait();
      await this.connectOnce(true);
    })().catch((error: unknown) => {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      this.reconnectingRegistration = undefined;
    });
    await this.reconnectingRegistration;
  }

  /** Start one heartbeat loop, replacing any previous loop.
   * @returns void.
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    const beat = (): void => {
      void sendHeartbeat({ apiUrl: this.config.apiUrl, botToken: this.config.botToken }).catch((error: unknown) => {
        this.emit("heartbeat-failed", error);
      });
    };
    beat();
    this.heartbeatTimer = setInterval(beat, this.config.heartbeatIntervalMs);
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
  }

  /** Dedupe, filter self-traffic, normalize, and emit one inbound message. */
  private handleSocketMessage(message: BotMessage): void {
    if (message === null || typeof message !== "object") return;
    if (typeof message.message_id !== "string" || message.message_id === "") return;
    if (this.seen.has(message.message_id)) return;
    this.seen.add(message.message_id);
    if (this.seen.size > SEEN_CAPACITY) {
      for (const id of this.seen) {
        this.seen.delete(id);
        if (this.seen.size <= SEEN_CAPACITY / 2) break;
      }
    }
    if (this.robotId !== undefined && message.from_uid === this.robotId) return;

    const channelType = message.channel_type ?? ChannelType.DM;
    const chatId = channelType === ChannelType.DM
      ? message.from_uid
      : (message.channel_id ?? "");
    if (chatId === "") return; // a non-DM without a channel id has no reply target

    const content = extractText(message);
    if (content.trim() === "") return; // media-only messages are out of MVP scope

    const uids = mentionUidsOf(message.payload.mention);
    const mention = message.payload.mention;
    const botMentioned =
      (this.robotId !== undefined && uids.includes(this.robotId)) ||
      isFlag(mention?.all) ||
      isFlag(mention?.humans) ||
      isFlag(mention?.ais);

    const normalized: OctoMessage = Object.freeze({
      chatId,
      channelType,
      senderId: message.from_uid,
      messageId: message.message_id,
      content,
      botMentioned,
      timestamp: message.timestamp ?? Date.now(),
    });
    this.emit("message", normalized);
  }

  /** Send one text message to a chat. */
  async send(to: string, input: OctoSendInput, options?: OctoSendOptions): Promise<OctoSendResult> {
    const text = input.markdown ?? input.text ?? "";
    const result = await apiSendMessage({
      apiUrl: this.config.apiUrl,
      botToken: this.config.botToken,
      channelId: to,
      channelType: (options?.channelType ?? ChannelType.DM) as ChannelType,
      content: text,
      ...(options?.mentionUids && options.mentionUids.length > 0 ? { mentionUids: options.mentionUids } : {}),
      ...(options?.replyTo !== undefined ? { replyMsgId: options.replyTo } : {}),
    });
    const messageId = result?.message_id ?? "";
    this.config.log?.("octo-channel: outbound send completed (channel=" + to + ", messageId=" + messageId + ", chars=" + text.length + ")");
    return { messageId };
  }

  /** Send one image file to a chat via presigned direct upload.
   * @param to - channel id (DM uid, group_no, or thread channel id).
   * @param filePath - local image path (png dimensions are read automatically).
   * @param options - reply target and channel type.
   * @returns The send result carrying the message id.
   */
  async sendImage(to: string, filePath: string, options?: OctoSendOptions): Promise<OctoSendResult> {
    const bytes = new Uint8Array(await readFile(filePath));
    const filename = filePath.split("/").pop() ?? "image.png";
    const presigned = await getPresignedUpload({
      apiUrl: this.config.apiUrl,
      botToken: this.config.botToken,
      filename,
      fileSize: bytes.byteLength,
    });
    await uploadToPresignedUrl({ presigned, bytes });
    const result = await sendMediaMessage({
      apiUrl: this.config.apiUrl,
      botToken: this.config.botToken,
      channelId: to,
      channelType: (options?.channelType ?? ChannelType.DM) as ChannelType,
      messageType: 2,
      url: presigned.downloadUrl,
      meta: pngSizeOf(bytes),
      ...(options?.replyTo !== undefined ? { replyMsgId: options.replyTo } : {}),
    });
    const messageId = result?.message_id ?? "";
    this.config.log?.("octo-channel: outbound image completed (channel=" + to + ", messageId=" + messageId + ", bytes=" + bytes.byteLength + ")");
    return { messageId };
  }

  /** Best-effort typing indicator for one chat. */
  async typing(to: string, channelType: number): Promise<void> {
    await sendTyping({
      apiUrl: this.config.apiUrl,
      botToken: this.config.botToken,
      channelId: to,
      channelType: channelType as ChannelType,
    });
  }
}
