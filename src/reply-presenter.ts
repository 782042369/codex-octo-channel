/** Turn-bound reply presenter: typing keep-alive, delayed ack, final send.
 *
 * Simpler than the dsh-octo-channel presenter because the codex driver
 * resolves one final message per turn instead of a host event stream: the
 * channel calls deliver() or fail() exactly once, close() drains.
 * @module codex-octo-channel/reply-presenter
 */
import type { OctoPort } from "./port.js";
import type { TurnTarget } from "./conversation.js";

/** Failure sink for outbound send errors. */
export type PresenterFailureSink = (error: unknown) => void;

/** Presenter tunables. */
export interface PresenterOptions {
  readonly onFailure: PresenterFailureSink;
  /** Keep the typing indicator warm while the turn is live. */
  readonly typing?: boolean | undefined;
  /** Send the ack note after this many milliseconds without a final reply. */
  readonly ackDelayMs?: number | undefined;
  /** Text of the ack note. */
  readonly ackText?: string | undefined;
  /** Outbound messages longer than this are split into multiple messages. */
  readonly maxReplyChars?: number | undefined;
}

/** One turn-bound presenter handle. */
export interface TurnPresenter {
  /** True once deliver() or fail() has run. */
  isFinalized(): boolean;
  /** Send the committed final answer (possibly chunked). */
  deliver(text: string): Promise<void>;
  /** Send a redacted user-facing failure note. */
  fail(error: unknown): Promise<void>;
  /** Stop timers; awaits the in-flight final send when already started. */
  close(): Promise<void>;
}

/** Cadence of the typing keep-alive while a turn is live. */
export const TYPING_INTERVAL_MS = 10_000;
/** Default text of the delayed ack note. */
const DEFAULT_ACK_TEXT = "\u6536\u5230\uff0c\u6b63\u5728\u5904\u7406\u2026";
/** Upper bound on redacted failure text length. */
const MAX_FAILURE_CHARS = 300;
/** Never split a reply into chunks smaller than this. */
const MIN_CHUNK_CHARS = 200;

/**
 * Remove common credential-shaped substrings before an error reaches chat.
 * @param value - raw driver or transport error text.
 * @returns A bounded, redacted user-facing diagnostic.
 */
export function safeFailureText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/(authorization|token|api[-_]?key|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, "bearer [redacted]")
    .replace(/\b(?:sk|bf|app|ghp|gho|xox)[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(/https?:\/\/[^\s)]+/gi, "[upstream]")
    .slice(0, MAX_FAILURE_CHARS);
}

/**
 * Split one long reply into bounded chunks on paragraph, then sentence,
 * then hard boundaries. Each chunk stays within maxChars when possible.
 * @param text - the full reply text.
 * @param maxChars - per-message character budget.
 * @returns Chunk texts in order; at least one element for non-empty input.
 */
export function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n\n", maxChars);
    if (cut < MIN_CHUNK_CHARS) cut = rest.lastIndexOf("\n", maxChars);
    if (cut < MIN_CHUNK_CHARS) cut = rest.lastIndexOf("\u3002", maxChars) + 1;
    if (cut < MIN_CHUNK_CHARS) cut = rest.lastIndexOf(". ", maxChars) + 1;
    if (cut < MIN_CHUNK_CHARS) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== "") chunks.push(rest);
  return chunks;
}

/**
 * Create a presenter whose destination cannot be retargeted later.
 * @param port - Octo transport.
 * @param target - immutable reply destination.
 * @param options - presentation and failure policy.
 * @returns A turn presenter with drainable close semantics.
 */
export function createTurnPresenter(
  port: OctoPort,
  target: TurnTarget,
  options: PresenterOptions,
): TurnPresenter {
  return new TurnTextPresenter(port, target, options);
}

class TurnTextPresenter implements TurnPresenter {
  private finalized = false;
  private ackSent = false;
  private typingTimer: ReturnType<typeof setInterval> | undefined;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private finalizationPromise: Promise<void> | undefined;

  constructor(
    private readonly port: OctoPort,
    private readonly target: TurnTarget,
    private readonly options: PresenterOptions,
  ) {
    const delay = this.options.ackDelayMs;
    if (delay !== undefined && delay > 0) {
      this.ackTimer = setTimeout(() => {
        this.ackTimer = undefined;
        void this.sendAck();
      }, delay);
      (this.ackTimer as { unref?: () => void }).unref?.();
    }
    this.startTyping();
  }

  /** @returns True once the final reply has been sent (or attempted). */
  isFinalized(): boolean {
    return this.finalized;
  }

  /** Send the committed final answer, chunked when necessary.
   * @param text - the agent's final message.
   * @returns A promise settled after all chunk sends complete.
   */
  deliver(text: string): Promise<void> {
    this.finalizationPromise ??= this.finalize(text, false);
    return this.finalizationPromise;
  }

  /** Send a redacted failure note.
   * @param error - the driver or transport failure.
   * @returns A promise settled after the best-effort send.
   */
  fail(error: unknown): Promise<void> {
    this.finalizationPromise ??= this.finalize(safeFailureText(error), true);
    return this.finalizationPromise;
  }

  /** Stop timers and await any in-flight final send.
   * @returns A promise settled after presenter-owned work finishes.
   */
  close(): Promise<void> {
    this.stopTimers();
    if (this.finalizationPromise !== undefined) return this.finalizationPromise;
    return Promise.resolve();
  }

  /** Start typing immediately and keep the indicator warm.
   * @returns void.
   */
  private startTyping(): void {
    if (!this.options.typing || this.typingTimer !== undefined || this.finalized) return;
    void this.port.typing(this.target.chatId, this.target.channelType).catch(() => undefined);
    this.typingTimer = setInterval(() => {
      void this.port.typing(this.target.chatId, this.target.channelType).catch(() => undefined);
    }, TYPING_INTERVAL_MS);
    (this.typingTimer as { unref?: () => void }).unref?.();
  }

  /** Stop all timers owned by the presenter.
   * @returns void.
   */
  private stopTimers(): void {
    if (this.typingTimer !== undefined) {
      clearInterval(this.typingTimer);
      this.typingTimer = undefined;
    }
    if (this.ackTimer !== undefined) {
      clearTimeout(this.ackTimer);
      this.ackTimer = undefined;
    }
  }

  /** Send the delayed acknowledgement when the turn is still waiting.
   * @returns A promise settled after the best-effort ack.
   */
  private async sendAck(): Promise<void> {
    if (this.finalized || this.ackSent) return;
    this.ackSent = true;
    try {
      await this.port.send(this.target.chatId, { text: this.options.ackText ?? DEFAULT_ACK_TEXT }, {
        replyTo: this.target.replyToMessageId,
        channelType: this.target.channelType,
      });
    } catch (error) {
      this.options.onFailure(error);
    }
  }

  /** Send the final text (chunked) or a redacted failure prefix.
   * @param text - final answer text or failure diagnostic.
   * @param isFailure - prefix the failure banner when true.
   * @returns A promise settled after all sends complete.
   */
  private async finalize(text: string, isFailure: boolean): Promise<void> {
    if (this.finalized) return;
    this.stopTimers();
    this.finalized = true;
    const body = text.trim();
    if (body === "") return;
    const maxChars = Math.max(this.options.maxReplyChars ?? 3500, MIN_CHUNK_CHARS);
    const chunks = chunkText(isFailure ? "\u56de\u7b54\u5931\u8d25\uff1a" + body : body, maxChars);
    for (let index = 0; index < chunks.length; index++) {
      try {
        await this.port.send(this.target.chatId, { text: chunks[index] }, {
          replyTo: this.target.replyToMessageId,
          channelType: this.target.channelType,
          ...(index === 0 && this.target.replyMentionUid === undefined
            ? {}
            : index === 0
              ? { mentionUids: [this.target.replyMentionUid as string] }
              : {}),
        });
      } catch (error) {
        this.options.onFailure(error);
        return;
      }
    }
  }
}
