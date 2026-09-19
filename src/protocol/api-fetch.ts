/**
 * Lightweight fetch-based Octo REST helpers.
 *
 * Ported (trimmed) from Mininglamp-OSS/openclaw-channel-octo (Apache-2.0);
 * see NOTICE. Kept: the 429-aware POST core, int64-safe JSON parsing,
 * client_msg_no idempotency, text send, typing, heartbeat, and register.
 */
import { randomUUID } from "node:crypto";
import { OctoApiError } from "./api-error.js";
import { ChannelType, MessageType, type BotEvent, type BotRegisterResp, type SendMessageResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POST_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
/** Absolute ceiling on one POST attempt, even with a caller-supplied signal. */
const POST_HARD_CEILING_MS = 60_000;
/** At most three attempts per call: the original plus two retries. */
export const MAX_429_RETRIES = 2;
/** A Retry-After longer than this means "go away", not "retry shortly". */
const MAX_RETRY_AFTER_MS = 10_000;
/** Cumulative backoff sleep budget for one call. */
const MAX_429_BACKOFF_WAIT_MS = 15_000;
/** Extra attempts for transient network/5xx failures on idempotent calls. */
export const MAX_TRANSIENT_RETRIES = 2;
/** Base delay of one transient retry; doubled per attempt, then jittered. */
const TRANSIENT_RETRY_BASE_MS = 400;
const DEFAULT_HEADERS = { "Content-Type": "application/json" };

/**
 * Client idempotency number for outbound messages. WuKongIM dedupes by
 * client_msg_no server-side, so retries never double-post a message.
 */
export function generateClientMsgNo(): string {
  return randomUUID();
}

/**
 * Parse JSON with int64 message_id protection: 16+ digit message_id values
 * are quoted before JSON.parse to avoid precision loss.
 */
function parseOctoJson<T>(text: string): T {
  const safeText = text.replace(/"message_id"\s*:\s*(\d{16,})/g, '"message_id":"$1"');
  return JSON.parse(safeText) as T;
}

function backoffSleep(ms: number, signal: AbortSignal | undefined, cause: unknown): Promise<void> {
  const aborted = (): Error =>
    new Error("aborted while backing off from a rate limit", { cause });
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Backoff for one transient retry attempt.
 * @param attempt - zero-based index of the attempt that just failed.
 * @returns Delay in milliseconds, jittered upward by up to 25%.
 */
function transientRetryDelay(attempt: number): number {
  const base = TRANSIENT_RETRY_BASE_MS * 2 ** attempt;
  return Math.round(base * (1 + Math.random() * 0.25));
}

/**
 * POST JSON to the Octo bot API with Bearer auth and bounded 429 retry.
 * Resolves undefined when the server answers 2xx with an empty body.
 */
export async function postJson<T>(
  apiUrl: string,
  botToken: string,
  path: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  opts?: { retryOn429?: boolean; retryOnTransient?: boolean },
): Promise<T | undefined> {
  const url = apiUrl.replace(/\/+$/, "") + path;
  const retryOn429 = opts?.retryOn429 ?? true;
  const retryOnTransient = opts?.retryOnTransient ?? false;
  let waited = 0;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason;

    // Rebuilt per attempt: a deadline shared across attempts would start a
    // retry with a budget the previous attempt already spent.
    const fetchSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(POST_HARD_CEILING_MS)])
      : AbortSignal.timeout(DEFAULT_POST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { ...DEFAULT_HEADERS, Authorization: "Bearer " + botToken },
        body: JSON.stringify(payload),
        signal: fetchSignal,
      });
    } catch (error) {
      // Safe to retry only for callers that opted in: every retried call either
      // carries a client_msg_no (deduplicated server-side) or is idempotent.
      if (!retryOnTransient || attempt >= MAX_TRANSIENT_RETRIES || signal?.aborted) throw error;
      await backoffSleep(transientRetryDelay(attempt), signal, error);
      continue;
    }

    if (response.ok) {
      const text = await response.text();
      if (!text) return undefined;
      try {
        return parseOctoJson<T>(text);
      } catch {
        throw new Error("Octo API " + path + " returned invalid JSON: " + text.slice(0, 200));
      }
    }

    const body = await response.text().catch(() => "");
    const err = OctoApiError.from(response, path, body);
    if (!err.isRateLimited) {
      if (retryOnTransient && err.status >= 500 && attempt < MAX_TRANSIENT_RETRIES) {
        await backoffSleep(transientRetryDelay(attempt), signal, err);
        continue;
      }
      throw err;
    }

    console.warn(
      "octo: rate limited on " + path + " (scope=" + (err.rateLimitScope ?? "?") + " "
        + "remaining=" + (err.rateLimitRemaining ?? "?") + " retry_after=" + err.retryAfterMs + "ms) "
        + "attempt=" + (attempt + 1) + "/" + (retryOn429 ? MAX_429_RETRIES + 1 : 1),
    );
    if (!retryOn429 || attempt >= MAX_429_RETRIES) throw err;
    if (err.retryAfterMs > MAX_RETRY_AFTER_MS) throw err;

    // Jitter only ever adds: Retry-After is the earliest acceptable retry time.
    const delay = Math.round(err.retryAfterMs * (1 + Math.random() * 0.25));
    if (waited + delay > MAX_429_BACKOFF_WAIT_MS) throw err;
    await backoffSleep(delay, signal, err);
    waited += delay;
  }
}

/** Register (or re-register) the bot against the Octo server. */
export async function registerBot(params: {
  apiUrl: string;
  botToken: string;
  forceRefresh?: boolean;
  agentPlatform?: string;
  agentVersion?: string;
  pluginVersion?: string;
  signal?: AbortSignal;
}): Promise<BotRegisterResp> {
  const path = params.forceRefresh ? "/v1/bot/register?force_refresh=true" : "/v1/bot/register";
  const body: Record<string, string> = {};
  if (params.agentPlatform) body.agent_platform = params.agentPlatform;
  if (params.agentVersion) body.agent_version = params.agentVersion;
  if (params.pluginVersion) body.plugin_version = params.pluginVersion;
  const result = await postJson<BotRegisterResp>(params.apiUrl, params.botToken, path, body, params.signal, { retryOnTransient: true });
  if (!result) throw new Error("Octo bot registration returned empty response");
  return result;
}

/**
 * Send one text message (payload.type=1).
 *
 * channel_type: 1 = DM (channel_id is the user UID), 2 = group (group_no),
 * 5 = thread (group_no____short_id). Reply targets come verbatim from the
 * inbound event; never split or rewrite channel_id.
 */
export async function sendMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  content: string;
  mentionUids?: string[];
  mentionAll?: boolean;
  replyMsgId?: string;
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  if (!params.channelId || !params.channelId.trim()) {
    throw new Error("octo: channelId is required to send a message");
  }
  const payload: Record<string, unknown> = {
    type: MessageType.Text,
    content: params.content,
  };
  if ((params.mentionUids && params.mentionUids.length > 0) || params.mentionAll) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) mention.uids = params.mentionUids;
    if (params.mentionAll) mention.all = 1;
    payload.mention = mention;
  }
  if (params.replyMsgId) payload.reply = { message_id: params.replyMsgId };
  return await postJson<SendMessageResult>(
    params.apiUrl,
    params.botToken,
    "/v1/bot/sendMessage",
    {
      channel_id: params.channelId,
      channel_type: params.channelType,
      payload,
      client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
    },
    params.signal,
    // A retried send reuses the same client_msg_no, so the server dedupes it.
    { retryOnTransient: true },
  );
}

/** Show "typing..." in the channel. Discardable hint - never retried. */
export async function sendTyping(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(
    params.apiUrl,
    params.botToken,
    "/v1/bot/typing",
    { channel_id: params.channelId, channel_type: params.channelType },
    params.signal,
    { retryOn429: false },
  );
}

/** Keep the bot "online" in the Octo client. A missed beat costs nothing. */
export async function sendHeartbeat(params: {
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/heartbeat", {}, params.signal, {
    retryOn429: false,
  });
}

// ── Events queue (long poll) ─────────────────────────────────────────────
// The WebSocket is the primary real-time transport. These helpers expose the
// REST events queue (POST /v1/bot/events) as the fallback / supplement — the
// same wire contract the upstream plugin's poller uses.

/** Server-side clamp on the `wait` parameter. */
export const MAX_EVENT_WAIT_SECONDS = 30;
/** Smallest useful hold: below this, holds issue more requests than they replace. */
export const MIN_EVENT_WAIT_SECONDS = 5;
/** Idle bound for a plain (non-holding) poll request. */
const EVENTS_POLL_TIMEOUT_MS = 10_000;
/** Slack added on top of a long-poll hold before the client gives up. */
const EVENTS_POLL_WAIT_MARGIN_MS = 10_000;

/** Client timeout for one /v1/bot/events request — always exceeds the requested hold. */
export function eventsPollTimeoutMs(waitSeconds?: number): number {
  if (!waitSeconds || waitSeconds <= 0) return EVENTS_POLL_TIMEOUT_MS;
  return waitSeconds * 1000 + EVENTS_POLL_WAIT_MARGIN_MS;
}

/**
 * Pull bot events strictly after the supplied cursor. With waitSeconds > 0 the
 * server holds an empty queue open for that long (long poll); an expired hold
 * is a normal empty batch. A non-zero wait below MIN_EVENT_WAIT_SECONDS is
 * raised to it.
 */
export async function fetchBotEvents(params: {
  apiUrl: string;
  botToken: string;
  sinceEventId?: number;
  limit?: number;
  waitSeconds?: number;
  signal?: AbortSignal;
}): Promise<BotEvent[]> {
  const waitSeconds =
    params.waitSeconds && params.waitSeconds > 0
      ? Math.min(MAX_EVENT_WAIT_SECONDS, Math.max(MIN_EVENT_WAIT_SECONDS, Math.floor(params.waitSeconds)))
      : 0;
  const response = await postJson<{ results?: BotEvent[] }>(
    params.apiUrl,
    params.botToken,
    "/v1/bot/events",
    {
      event_id: params.sinceEventId ?? 0,
      limit: Math.max(1, Math.min(100, Math.floor(params.limit ?? 20))),
      // Omitted entirely when not long-polling, so the request stays
      // byte-identical to what servers that predate the `wait` field accept.
      ...(waitSeconds > 0 ? { wait: waitSeconds } : {}),
    },
    params.signal ?? AbortSignal.timeout(eventsPollTimeoutMs(waitSeconds)),
    // The poll loop paces itself from the outcome of each request; a sleep
    // inside would inflate the "did the server hold?" measurement.
    { retryOn429: false },
  );
  return Array.isArray(response?.results) ? response.results : [];
}

// ── Media upload (presigned direct upload) and image/file messages ──────────

/** Response of GET /v1/bot/upload/presigned. */
export interface PresignedUpload {
  /** HTTP method for the upload request; the documented flow uses PUT. */
  method?: string;
  /** Presigned upload target; send the exact file bytes here. */
  uploadUrl: string;
  /** Public URL to reference in the message payload after uploading. */
  downloadUrl: string;
  /** Content-Type header value to echo on the upload request. */
  contentType?: string;
  /** Content-Disposition header value to echo exactly, when present. */
  contentDisposition?: string;
  /** Storage key of the uploaded object. */
  key?: string;
}

/** Image or file dimensions/size hints carried by the payload. */
export interface MediaMeta {
  /** Pixel width (images). */
  width?: number;
  /** Pixel height (images). */
  height?: number;
  /** Original file name (file messages). */
  name?: string;
  /** Byte size (file messages). */
  size?: number;
}

/**
 * Parse the IHDR chunk of a PNG buffer for its pixel dimensions.
 * @param bytes - raw PNG file bytes.
 * @returns Width/height when the buffer is a valid PNG, else undefined.
 */
export function pngSizeOf(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((b, i) => bytes[i] === b)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Request a presigned direct-upload slot from the Octo server.
 * @param params - apiUrl, botToken, filename, and exact byte size.
 * @returns The presigned upload descriptor.
 */
export async function getPresignedUpload(params: {
  apiUrl: string;
  botToken: string;
  filename: string;
  fileSize: number;
  signal?: AbortSignal;
}): Promise<PresignedUpload> {
  const url =
    params.apiUrl.replace(/\/+$/, "") +
    "/v1/bot/upload/presigned?filename=" + encodeURIComponent(params.filename) +
    "&fileSize=" + encodeURIComponent(String(params.fileSize));
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + params.botToken },
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw OctoApiError.from(response, "/v1/bot/upload/presigned", await response.text().catch(() => ""));
  const parsed = (await response.json()) as PresignedUpload;
  if (typeof parsed.uploadUrl !== "string" || parsed.uploadUrl === "" || typeof parsed.downloadUrl !== "string" || parsed.downloadUrl === "") {
    throw new Error("octo: presigned upload response missing uploadUrl/downloadUrl");
  }
  return parsed;
}

/**
 * Upload the exact file bytes to a presigned URL with method PUT, echoing the
 * returned Content-Type and Content-Disposition headers.
 * @param params - presigned descriptor and the raw bytes.
 * @returns void; throws on a non-2xx storage answer.
 */
export async function uploadToPresignedUrl(params: {
  presigned: PresignedUpload;
  bytes: Uint8Array;
  signal?: AbortSignal;
}): Promise<void> {
  const headers: Record<string, string> = {};
  if (params.presigned.contentType !== undefined) headers["Content-Type"] = params.presigned.contentType;
  if (params.presigned.contentDisposition !== undefined) headers["Content-Disposition"] = params.presigned.contentDisposition;
  const response = await fetch(params.presigned.uploadUrl, {
    method: (params.presigned.method ?? "PUT").toUpperCase(),
    headers,
    body: params.bytes,
    signal: params.signal ?? AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error("octo: presigned upload failed with status " + response.status);
  }
}

/**
 * Send one media message (payload.type=2 image or type=8 file) referencing an
 * already-uploaded URL.
 * @param params - target channel, media URL, and optional metadata.
 * @returns The send result carrying the message id.
 */
export async function sendMediaMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  /** 2 = image, 8 = file. */
  messageType: 2 | 8;
  url: string;
  meta?: MediaMeta;
  replyMsgId?: string;
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  const payload: Record<string, unknown> = { type: params.messageType, url: params.url };
  if (params.meta?.width !== undefined) payload.width = params.meta.width;
  if (params.meta?.height !== undefined) payload.height = params.meta.height;
  if (params.meta?.name !== undefined) payload.name = params.meta.name;
  if (params.meta?.size !== undefined) payload.size = params.meta.size;
  if (params.replyMsgId !== undefined) payload.reply = { message_id: params.replyMsgId };
  return await postJson<SendMessageResult>(
    params.apiUrl,
    params.botToken,
    "/v1/bot/sendMessage",
    {
      channel_id: params.channelId,
      channel_type: params.channelType,
      payload,
      client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
    },
    params.signal,
  );
}

/** Best-effort queue pruning after a recognized bot event has been accepted. */
export async function ackBotEvent(params: {
  apiUrl: string;
  botToken: string;
  eventId: number;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(
    params.apiUrl,
    params.botToken,
    "/v1/bot/events/" + params.eventId + "/ack",
    {},
    params.signal ?? AbortSignal.timeout(EVENTS_POLL_TIMEOUT_MS),
    // A lost ack costs at most one redelivery; never retry inside the loop.
    { retryOn429: false },
  );
}