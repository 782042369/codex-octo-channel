/** Codex CLI driver: one spawned codex exec process per agent turn.
 *
 * Uses "codex exec --json" (JSONL events on stdout) plus
 * "--output-last-message <file>" for the committed final answer, and
 * "codex exec resume <threadId>" for continuation across turns. The thread
 * id is captured from the thread.started event, which is re-emitted with
 * the same id on resume (verified against codex-cli 0.153.4).
 * @module codex-octo-channel/codex/runner
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { CodexSandboxMode } from "../config.js";

/** Usage totals reported by the final turn.completed event. */
export interface CodexUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

/** Successful outcome of one agent turn. */
export interface CodexRunResult {
  /** Codex thread id; persists across turns for "exec resume". */
  threadId: string;
  /** The agent's committed final message. */
  text: string;
  /** Token usage when the turn completed with a usage event. */
  usage?: CodexUsage;
  /** True when this turn resumed a stored thread. */
  resumed: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/** Terminal failure of one agent turn. */
export interface CodexRunFailure {
  /** Stable machine-readable cause. */
  kind: "timeout" | "nonzero-exit" | "no-output";
  /** Human-readable diagnostic (already log-safe). */
  message: string;
  /** Process exit code, when the process ran and exited on its own. */
  exitCode?: number;
  /** True when the failure happened before any thread.started event. */
  beforeThreadStart: boolean;
}

/** Union outcome for one turn. */
export type CodexRunOutcome =
  | { ok: true; result: CodexRunResult }
  | { ok: false; failure: CodexRunFailure };

/** Turn request handed to the runner. */
export interface CodexRunRequest {
  /** User-visible prompt text for this turn. */
  prompt: string;
  /** Working directory for the codex process (per-chat workspace). */
  cwd: string;
  /** Resume this Codex thread id when set. */
  resumeThreadId?: string | undefined;
  /** Extra env entries merged into the child environment. */
  env?: Record<string, string> | undefined;
}

/** Minimal child-process handle the runner consumes. */
export interface CodexChild {
  /** stdout as line-chunks without trailing newlines. */
  stdout: AsyncIterable<string>;
  /** stderr as line-chunks without trailing newlines. */
  stderr: AsyncIterable<string>;
  /** Terminate the process with the given signal. */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  /** Resolves with the exit code, or null when terminated by a signal. */
  exited: Promise<number | null>;
}

/** Spawner signature; injectable so tests can fake the CLI. */
export type CodexSpawnFn = (
  bin: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> | undefined },
) => CodexChild;

/** Runner tunables resolved from configuration. */
export interface CodexRunnerOptions {
  /** Codex executable path or name. */
  bin: string;
  /** Sandbox policy for fresh turns; resume inherits the stored policy. */
  sandbox: CodexSandboxMode;
  /** Model override; omitted when empty. */
  model?: string | undefined;
  /** Raw "-c key=value" overrides. */
  configOverrides?: string[] | undefined;
  /** Wall-clock limit per turn. */
  timeoutMs: number;
  /** Grace period between SIGTERM and SIGKILL on timeout. */
  killGraceMs?: number | undefined;
  /** Diagnostic sink. */
  log?: ((line: string) => void) | undefined;
}

/** One thread.started JSONL event payload. */
interface ThreadStartedEvent {
  type: "thread.started";
  thread_id: string;
}

/** One item.completed JSONL event payload (subset). */
interface ItemCompletedEvent {
  type: "item.completed";
  item: { type: string; text?: string };
}

/** One turn.completed JSONL event payload (subset). */
interface TurnCompletedEvent {
  type: "turn.completed";
  usage?: Record<string, number>;
}

/** One error JSONL event payload (subset). */
interface ErrorEvent {
  type: "error";
  message?: string;
}

/** Union of the JSONL events this runner consumes. */
type CodexEvent =
  | ThreadStartedEvent
  | ItemCompletedEvent
  | TurnCompletedEvent
  | ErrorEvent
  | { type: string };

/** Bytes of codex stdout kept for diagnostics. */
const MAX_STDOUT_SNIPPET = 4000;
/** Cap on retained stderr bytes. */
const MAX_STDERR_BYTES = 8000;
/** Default grace period between SIGTERM and SIGKILL. */
const DEFAULT_KILL_GRACE_MS = 5000;

/**
 * Parse one JSONL line into a narrow event object.
 * @param line - raw stdout line, may be empty or non-JSON noise.
 * @returns The parsed event, or undefined for ignorable lines.
 */
function parseEvent(line: string): CodexEvent | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    if (typeof parsed?.type === "string") return parsed as CodexEvent;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract a bounded failure message from buffered stderr.
 * @param stderr - raw stderr text.
 * @returns A single-line diagnostic string, empty when stderr is empty.
 */
function stderrSummary(stderr: string): string {
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? "").slice(0, 300);
}

/**
 * Wrap one readable stream into an async iterator of lines.
 * @param stream - the raw child stream.
 * @returns Line iterator without trailing newlines.
 */
function toLines(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let buffer = "";
  const queue: string[] = [];
  const waiters: ((result: IteratorResult<string>) => void)[] = [];
  let done = false;

  /** Queue one completed line for consumers.
   * @param line - text without the trailing newline.
   */
  function push(line: string): void {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter({ value: line, done: false });
    else queue.push(line);
  }

  /** Resolve remaining waiters at stream end.
   * @returns void.
   */
  function finish(): void {
    done = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter?.({ value: "", done: true });
    }
  }

  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      push(line);
      index = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer !== "") push(buffer);
    buffer = "";
    finish();
  });
  stream.on("error", () => finish());

  return (async function* lines(): AsyncGenerator<string> {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as string;
        continue;
      }
      if (done) return;
      const next = await new Promise<IteratorResult<string>>((resolve) => {
        waiters.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  })();
}

/**
 * Default spawner using node:child_process against the configured binary.
 * @param bin - executable path or name.
 * @param args - complete argv including the exec/resume subcommand.
 * @param options - cwd and env for the child.
 * @returns The child handle consumed by the runner.
 */
export const defaultSpawn: CodexSpawnFn = (bin, args, options) => {
  const child = spawn(bin, args, {
    cwd: options.cwd,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
  return {
    stdout: toLines(child.stdout as NodeJS.ReadableStream),
    stderr: toLines(child.stderr as NodeJS.ReadableStream),
    kill(signal) {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    },
    exited,
  };
};

/**
 * Build the codex argv for one turn.
 * @param runnerOptions - resolved runner tunables.
 * @param request - the turn request.
 * @param lastMessageFile - path passed to "--output-last-message".
 * @returns The complete argv (binary excluded).
 */
export function buildCodexArgs(
  runnerOptions: CodexRunnerOptions,
  request: CodexRunRequest,
  lastMessageFile: string,
): string[] {
  // Flags go AFTER the exec/resume subcommand: exec-level flags placed
  // before "resume" are parsed by the exec parser and do not reliably
  // reach the resume subcommand (verified against codex-cli 0.153.4).
  const shared = ["--json", "--skip-git-repo-check", "-o", lastMessageFile];
  if (runnerOptions.model !== undefined && runnerOptions.model !== "") shared.push("-m", runnerOptions.model);
  for (const entry of runnerOptions.configOverrides ?? []) shared.push("-c", entry);
  const args: string[] = ["exec"];
  if (request.resumeThreadId !== undefined && request.resumeThreadId !== "") {
    args.push("resume", request.resumeThreadId, ...shared);
  } else {
    args.push(...shared, "-s", runnerOptions.sandbox);
  }
  args.push("--", request.prompt);
  return args;
}

/**
 * Drives one codex agent turn as a child process with a hard timeout.
 */
export class CodexRunner {
  private readonly options: CodexRunnerOptions;
  private readonly spawnFn: CodexSpawnFn;
  private readonly activeChildren = new Set<CodexChild>();
  private readonly cancelledChildren = new WeakSet<CodexChild>();

  /**
   * @param options - resolved runner tunables.
   * @param spawnFn - process spawner override for tests.
   */
  constructor(options: CodexRunnerOptions, spawnFn: CodexSpawnFn = defaultSpawn) {
    this.options = options;
    this.spawnFn = spawnFn;
  }

  /**
   * Terminate every in-flight codex process (graceful shutdown).
   * @returns void; affected turns fail with a shutdown diagnostic.
   */
  cancelAll(): void {
    for (const child of this.activeChildren) {
      this.cancelledChildren.add(child);
      child.kill("SIGTERM");
    }
  }

  /**
   * Number of codex processes currently in flight.
   * @returns Active child count.
   */
  get activeCount(): number {
    return this.activeChildren.size;
  }

  /**
   * Run one agent turn to completion.
   * @param request - prompt, workspace, and optional resume id.
   * @returns The turn outcome: success carries the final message and thread id.
   */
  async run(request: CodexRunRequest): Promise<CodexRunOutcome> {
    const startedAt = Date.now();
    const workDir = await mkdtemp(join(tmpdir(), "codex-octo-"));
    const lastMessageFile = join(workDir, "last-message.txt");
    let stderrText = "";
    let threadId = "";
    let lastAgentMessage = "";
    let usage: CodexUsage | undefined;
    let errorMessage: string | undefined;
    let timedOut = false;
    let childRef: CodexChild | undefined;

    try {
      const args = buildCodexArgs(this.options, request, lastMessageFile);
      this.options.log?.(
        "codex: spawn " + this.options.bin + " " + args.filter((arg) => arg !== request.prompt).join(" "),
      );
      const child = this.spawnFn(this.options.bin, args, {
        cwd: request.cwd,
        ...(request.env === undefined ? {} : { env: request.env }),
      });
      this.activeChildren.add(child);
      childRef = child;

      const grace = this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        this.options.log?.("codex: timeout after " + this.options.timeoutMs + "ms, terminating");
        child.kill("SIGTERM");
        const killer = setTimeout(() => child.kill("SIGKILL"), grace);
        (killer as { unref?: () => void }).unref?.();
      }, this.options.timeoutMs);
      (timer as { unref?: () => void }).unref?.();

      const consume = (async (): Promise<void> => {
        const pump = async (stream: AsyncIterable<string>, onLine: (line: string) => void): Promise<void> => {
          for await (const line of stream) onLine(line);
        };
        const onStdout = (line: string): void => {
          const event = parseEvent(line);
          if (event === undefined) return;
          if (event.type === "thread.started") {
            const id = (event as ThreadStartedEvent).thread_id;
            if (typeof id === "string" && id !== "") threadId = id;
          } else if (event.type === "item.completed") {
            const item = (event as ItemCompletedEvent).item;
            if (item?.type === "agent_message" && typeof item.text === "string" && item.text !== "") {
              lastAgentMessage = item.text;
            }
          } else if (event.type === "turn.completed") {
            const raw = (event as TurnCompletedEvent).usage;
            if (raw !== undefined) {
              usage = {
                ...(typeof raw.input_tokens === "number" ? { inputTokens: raw.input_tokens } : {}),
                ...(typeof raw.cached_input_tokens === "number" ? { cachedInputTokens: raw.cached_input_tokens } : {}),
                ...(typeof raw.output_tokens === "number" ? { outputTokens: raw.output_tokens } : {}),
                ...(typeof raw.reasoning_output_tokens === "number"
                  ? { reasoningOutputTokens: raw.reasoning_output_tokens }
                  : {}),
              };
            }
          } else if (event.type === "error") {
            const message = (event as ErrorEvent).message;
            if (typeof message === "string" && message !== "") errorMessage = message;
          }
        };
        const onStderr = (line: string): void => {
          stderrText = (stderrText + line + "\n").slice(-MAX_STDERR_BYTES);
        };
        await Promise.all([pump(child.stdout, onStdout), pump(child.stderr, onStderr)]);
      })();

      const exitCode = await Promise.all([child.exited, consume]).then(([code]) => code);
      clearTimeout(timer);

      const durationMs = Date.now() - startedAt;
      if (this.cancelledChildren.has(child)) {
        return {
          ok: false,
          failure: {
            kind: "nonzero-exit",
            message: "\u670d\u52a1\u6b63\u5728\u5173\u95ed\uff0c\u672c\u8f6e\u5df2\u4e2d\u6b62\u3002",
            beforeThreadStart: threadId === "",
          },
        };
      }
      if (timedOut || exitCode === null) {
        return {
          ok: false,
          failure: {
            kind: "timeout",
            message:
              "Codex \u5904\u7406\u8d85\u65f6\uff08" + Math.round(durationMs / 1000) + "s\uff09\uff0c\u5df2\u7ec8\u6b62\u3002",
            beforeThreadStart: threadId === "",
          },
        };
      }
      if (exitCode !== 0) {
        return {
          ok: false,
          failure: {
            kind: "nonzero-exit",
            message: stderrSummary(stderrText) || errorMessage || ("codex exited with code " + exitCode),
            exitCode,
            beforeThreadStart: threadId === "",
          },
        };
      }

      let finalText = "";
      try {
        finalText = (await readFile(lastMessageFile, "utf8")).trim();
      } catch {
        finalText = "";
      }
      if (finalText === "") finalText = lastAgentMessage.trim();
      if (finalText === "") {
        return {
          ok: false,
          failure: {
            kind: "no-output",
            message: "Codex \u6ca1\u6709\u4ea7\u751f\u6700\u7ec8\u56de\u590d\u3002",
            beforeThreadStart: threadId === "",
          },
        };
      }

      this.options.log?.(
        "codex: turn ok (thread=" + threadId + ", resumed=" + (request.resumeThreadId !== undefined) +
          ", " + durationMs + "ms" +
          (usage === undefined ? "" : ", tokens in=" + (usage.inputTokens ?? 0) + " out=" + (usage.outputTokens ?? 0)) + ")",
      );
      return {
        ok: true,
        result: {
          threadId,
          text: finalText,
          ...(usage === undefined ? {} : { usage }),
          resumed: request.resumeThreadId !== undefined && request.resumeThreadId !== "",
          durationMs,
        },
      };
    } finally {
      if (childRef !== undefined) this.activeChildren.delete(childRef);
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
