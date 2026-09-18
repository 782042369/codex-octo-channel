/** Octo channel composition: inbound messages, Codex turns, and lifecycle.
 *
 * Mirrors the dsh-octo-channel channel layer (access policy, group mention
 * gating, per-conversation session ownership, typing presenters) with the
 * DSH owned-agent layer replaced by a Codex CLI driver: every conversation
 * key owns one persistent Codex thread plus one private workspace directory,
 * and turns run as bounded codex exec child processes.
 * @module codex-octo-channel/channel
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.js";
import { createTurnId, createTurnTarget, workspaceSlug, type ConversationKey, type TurnTarget } from "./conversation.js";
import type { CodexRunner, CodexRunOutcome, CodexRunRequest } from "./codex/runner.js";
import type { SessionStore } from "./codex/session-store.js";
import type { OctoMessage, OctoPort } from "./port.js";
import { createTurnPresenter, type TurnPresenter } from "./reply-presenter.js";

/** Dependencies injected by main (or by tests). */
export interface ChannelServices {
  readonly port: OctoPort;
  readonly runner: CodexRunner;
  readonly store: SessionStore;
  readonly config: ResolvedConfig;
  readonly notify: (line: string) => void;
}

/** Lifecycle handle returned to the process entry. */
export interface Channel {
  /** Stop accepting work, cancel queued turns, drain in-flight presenters. */
  close(): Promise<void>;
}

/** One queued agent turn with its immutable reply destination. */
interface TurnTask {
  readonly id: string;
  readonly target: TurnTarget;
  readonly prompt: string;
  readonly presenter: TurnPresenter;
}

/** Per-conversation FIFO state. */
interface ConversationState {
  queued: TurnTask[];
  running: boolean;
}

/** Banner shown for /help. */
const HELP_TEXT = [
  "我是 Codex 机器人，由本机 Codex CLI 驱动，直接发消息即可对话。",
  "命令：/new 开启全新会话；/status 查看会话状态；/help 查看帮助。",
].join("\n");

/**
 * Convert an unknown failure into a log-safe string.
 * @param error - thrown value from the driver or transport.
 * @returns A human-readable diagnostic string.
 */
function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Return whether one inbound message passes the configured sender/chat policy.
 * @param message - normalized inbound Octo message.
 * @param config - resolved access policy.
 * @param ownerUid - bot owner uid from registration, when known.
 * @returns True when the message is allowed to create or join a session.
 */
function isMessageAllowed(message: OctoMessage, config: ResolvedConfig, ownerUid: string | undefined): boolean {
  if (config.deniedUserIds.includes(message.senderId) || config.deniedChatIds.includes(message.chatId)) return false;
  if (config.accessMode === "open") return true;
  if (config.allowedUserIds.length > 0 || config.allowedChatIds.length > 0) {
    const userAllowed = config.allowedUserIds.length === 0 || config.allowedUserIds.includes(message.senderId);
    const chatAllowed = config.allowedChatIds.length === 0 || config.allowedChatIds.includes(message.chatId);
    return userAllowed && chatAllowed;
  }
  return config.accessMode === "owner" && ownerUid !== undefined && message.senderId === ownerUid;
}

/** Build the model-facing prompt text for one inbound message.
 * @param message - normalized inbound Octo message.
 * @returns Prompt text; group traffic carries the sender identity.
 */
function buildPrompt(message: OctoMessage): string {
  if (message.channelType === 1) return message.content;
  return "[群消息, 发送者 " + message.senderId + "] " + message.content;
}

/**
 * Count-based semaphore bounding concurrent codex processes across chats.
 */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  /**
   * @param limit - maximum concurrent holders.
   */
  constructor(private readonly limit: number) {}

  /** Acquire one slot, waiting when the limit is reached.
   * @returns A promise resolved once a slot is held.
   */
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active += 1;
  }

  /** Release one slot and wake the next waiter.
   * @returns void.
   */
  release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }
}

/**
 * Install the Octo channel over the injected services.
 * @param services - transport, driver, store, config, and log sink.
 * @returns The channel lifecycle handle.
 */
export function installChannel(services: ChannelServices): Channel {
  const { port, runner, store, config, notify } = services;
  let active = true;
  const conversations = new Map<ConversationKey, ConversationState>();
  const runningTurns = new Set<Promise<void>>();
  const gate = new Semaphore(config.codex.maxConcurrentTurns);
  const workspacesRoot = join(config.stateRoot, "workspaces");

  /** Report an outbound send failure once.
   * @param error - transport failure.
   */
  const reportSendFailure = (error: unknown): void => {
    notify("codex-octo-channel: outbound send failed: " + detail(error));
  };

  /** State accessor that creates the entry on first use.
   * @param key - conversation identity.
   */
  const stateOf = (key: ConversationKey): ConversationState => {
    let state = conversations.get(key);
    if (state === undefined) {
      state = { queued: [], running: false };
      conversations.set(key, state);
    }
    return state;
  };

  /** Pending (queued + running) turn count for one conversation.
   * @param key - conversation identity.
   */
  const pendingCount = (key: ConversationKey): number => {
    const state = conversations.get(key);
    if (state === undefined) return 0;
    return state.queued.length + (state.running ? 1 : 0);
  };

  /** Send a short service message to the originating chat.
   * @param message - original inbound message and destination.
   * @param text - pre-sanitized user-facing text.
   */
  const sendNotice = async (message: OctoMessage, text: string): Promise<void> => {
    await port.send(message.chatId, { text }, { channelType: message.channelType }).catch(reportSendFailure);
  };

  /** Handle /new, /status, /help commands; returns true when consumed.
   * @param message - normalized inbound Octo message.
   * @param key - conversation identity for stateful commands.
   */
  const handleCommand = async (message: OctoMessage, key: ConversationKey): Promise<boolean> => {
    const text = message.content.trim();
    if (!text.startsWith("/")) return false;
    const command = text.split(/\s+/, 1)[0].toLowerCase();
    if (command === "/new") {
      store.reset(key);
      notify("codex-octo-channel: session reset for " + key);
      await sendNotice(message, "已开启新的 Codex 会话，下一条消息将从全新上下文开始。");
      return true;
    }
    if (command === "/status") {
      const stored = store.get(key);
      const state = conversations.get(key);
      const parts = [
        "会话： " + (stored === undefined ? "新会话（尚未开始）" : stored.threadId),
        "队列： " + pendingCount(key) + " 个等待中",
        "模型： " + (config.codex.model ?? "codex 默认"),
        "沙箱： " + config.codex.sandbox,
      ];
      if (state !== undefined && state.running) parts.push("当前有一轮正在处理");
      await sendNotice(message, parts.join("\n"));
      return true;
    }
    if (command === "/help") {
      await sendNotice(message, HELP_TEXT);
      return true;
    }
    return false;
  };

  /** Execute one turn against the codex driver and deliver the reply.
   * @param task - the dequeued turn.
   */
  const executeTurn = async (task: TurnTask): Promise<void> => {
    const key = task.target.conversationKey;
    const stored = store.get(key);
    const cwd = join(workspacesRoot, workspaceSlug(key));
    try {
      await mkdir(cwd, { recursive: true });
    } catch (error) {
      notify("codex-octo-channel: workspace mkdir failed: " + detail(error));
    }

    const request: CodexRunRequest = {
      prompt: task.prompt,
      cwd,
      ...(stored === undefined ? {} : { resumeThreadId: stored.threadId }),
      ...(Object.keys(config.codex.env).length === 0 ? {} : { env: config.codex.env }),
    };

    let outcome: CodexRunOutcome = await runner.run(request);

    // A resume can fail before the thread even starts (e.g. the stored
    // rollout was pruned). Retry exactly once with a fresh thread.
    if (!outcome.ok && outcome.failure.beforeThreadStart && request.resumeThreadId !== undefined) {
      notify("codex-octo-channel: resume " + request.resumeThreadId + " failed (" + outcome.failure.message + "), starting a fresh thread");
      store.reset(key);
      outcome = await runner.run({ ...request, resumeThreadId: undefined });
    }

    if (!active) return;

    if (outcome.ok) {
      if (outcome.result.threadId !== "") store.set(key, outcome.result.threadId);
      await task.presenter.deliver(outcome.result.text);
      return;
    }
    await task.presenter.fail(outcome.failure.message);
  };

  /** Serialize turns within one conversation, gated globally.
   * @param key - conversation identity.
   */
  const pump = (key: ConversationKey): void => {
    const state = stateOf(key);
    if (state.running || state.queued.length === 0) return;
    const task = state.queued.shift();
    if (task === undefined) return;
    state.running = true;
    const turn = (async (): Promise<void> => {
      if (!active) {
        await task.presenter.fail("服务正在关闭，请稍后重试。");
        return;
      }
      try {
        await gate.acquire();
        try {
          await executeTurn(task);
        } finally {
          gate.release();
        }
      } catch (error) {
        await task.presenter.fail(error).catch(reportSendFailure);
        notify("codex-octo-channel: turn failed for " + key + ": " + detail(error));
      }
    })().finally(() => {
      state.running = false;
      if (state.queued.length === 0 && !state.running) conversations.delete(key);
      else pump(key);
    });
    runningTurns.add(turn);
    turn.finally(() => runningTurns.delete(turn));
  };

  /** Inbound message handler: policy gates, commands, then enqueue.
   * @param message - normalized inbound Octo message.
   */
  const handleMessage = async (message: OctoMessage): Promise<void> => {
    if (!active) return;
    if (!isMessageAllowed(message, config, port.ownerUid)) return;
    if (message.content.trim() === "") return;
    const maxMessageChars = config.maxMessageChars;
    if (message.content.length > maxMessageChars) {
      await sendNotice(message, "消息过长，请拆分后重试。");
      return;
    }
    // Group/thread mention gate: DMs always pass; broadcast mentions count as a mention.
    if (message.channelType !== 1 && config.requireMention && !message.botMentioned) return;

    const target = createTurnTarget(config.sessionScope, {
      chatId: message.chatId,
      senderId: message.senderId,
      messageId: message.messageId,
      channelType: message.channelType,
    });

    if (await handleCommand(message, target.conversationKey)) return;

    if (pendingCount(target.conversationKey) >= config.maxQueuedTurns) {
      await sendNotice(message, "当前会话正在处理较多任务，请稍后重试。");
      return;
    }

    const presenter = createTurnPresenter(port, target, {
      onFailure: reportSendFailure,
      typing: true,
      ackDelayMs: config.ackDelayMs,
      maxReplyChars: config.maxReplyChars,
    });
    const state = stateOf(target.conversationKey);
    state.queued.push({
      id: createTurnId(),
      target,
      prompt: buildPrompt(message),
      presenter,
    });
    pump(target.conversationKey);
  };

  const unsubscribe = port.onMessage((message) => {
    void handleMessage(message);
  });

  return {
    async close(): Promise<void> {
      active = false;
      unsubscribe();
      runner.cancelAll();
      const closing: Promise<void>[] = [];
      for (const state of conversations.values()) {
        for (const task of state.queued) {
          state.queued = [];
          closing.push(task.presenter.fail("服务正在重启，请稍后重试。").catch(reportSendFailure));
        }
      }
      conversations.clear();
      closing.push(...[...runningTurns]);
      await Promise.allSettled(closing);
      store.close();
    },
  };
}
