/** Configuration model, defaults, and layered loading (file + environment). */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionScope } from "./conversation.js";

/** Sandbox policies accepted by `codex exec -s`. */
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** Tunables of the Codex CLI driver. */
export interface CodexOptions {
  /** Path or name of the codex executable; defaults to "codex" on PATH. */
  bin?: string;
  /** Model id passed as `-m`; omitted when empty. */
  model?: string;
  /** Sandbox mode passed as `-s`; resume turns inherit the original policy. */
  sandbox?: CodexSandboxMode;
  /** Raw `-c key=value` config overrides passed through verbatim. */
  configOverrides?: string[];
  /** Hard wall-clock limit for one agent turn. */
  timeoutMs?: number;
  /** Extra environment entries merged into the codex process env. */
  env?: Record<string, string>;
  /** Upper bound on codex processes running at the same time. */
  maxConcurrentTurns?: number;
}

/** Service configuration as stored in config.json. */
export interface Config {
  /** Octo bot token: bf_ (BotFather user bot) or app_ (admin app bot). */
  botToken?: string;
  /** Octo server REST API base URL, e.g. https://im.example.com/api. */
  apiUrl?: string;
  /** WuKongIM WebSocket URL; auto-detected from the register response when omitted. */
  wsUrl?: string;
  /** Root directory for state (session map + per-chat workspaces). */
  stateRoot?: string;
  /** Which conversation facet owns one Codex session. */
  sessionScope?: SessionScope;
  /** In group chats, only respond when the bot is @-mentioned. */
  requireMention?: boolean;
  /** Access mode: owner-only by default, explicit allowlist, or intentionally open. */
  accessMode?: "owner" | "allowlist" | "open";
  /** Explicit sender allowlist; an empty list means allow all senders. */
  allowedUserIds?: string[];
  /** Explicit chat allowlist; an empty list means allow all chats. */
  allowedChatIds?: string[];
  /** Sender denylist, evaluated before the allowlists. */
  deniedUserIds?: string[];
  /** Chat denylist, evaluated before the allowlists. */
  deniedChatIds?: string[];
  /** If the final answer is not ready within this many milliseconds, send a "received, working on it" ack; 0 disables. */
  ackDelayMs?: number;
  /** Maximum inbound text length accepted from Octo. */
  maxMessageChars?: number;
  /** Maximum queued turns per conversation before applying backpressure. */
  maxQueuedTurns?: number;
  /** Interval of the Octo online-status heartbeat. */
  heartbeatIntervalMs?: number;
  /** Outbound messages longer than this are split into multiple messages. */
  maxReplyChars?: number;
  /** Automatically send images that appear in the workspace during a turn. */
  sendWorkspaceImages?: boolean;
  /** Cap on images auto-sent per turn. */
  maxImagesPerTurn?: number;
  /** Largest image file auto-sent (bytes). */
  maxImageBytes?: number;
  /** Root directory holding the per-chat codex workspaces; defaults to <stateRoot>/workspaces. */
  workspacesRoot?: string;
  /** per-chat: one subdirectory per conversation; shared: all chats share workspacesRoot directly. */
  workspaceMode?: "per-chat" | "shared";
  /** Codex CLI driver tunables. */
  codex?: CodexOptions;
}

/** Configuration after defaults have been resolved. */
export interface ResolvedConfig {
  botToken: string;
  apiUrl: string;
  wsUrl: string | undefined;
  stateRoot: string;
  sessionScope: SessionScope;
  requireMention: boolean;
  accessMode: "owner" | "allowlist" | "open";
  allowedUserIds: string[];
  allowedChatIds: string[];
  deniedUserIds: string[];
  deniedChatIds: string[];
  ackDelayMs: number;
  maxMessageChars: number;
  maxQueuedTurns: number;
  heartbeatIntervalMs: number;
  maxReplyChars: number;
  sendWorkspaceImages: boolean;
  maxImagesPerTurn: number;
  maxImageBytes: number;
  workspacesRoot: string;
  workspaceMode: "per-chat" | "shared";
  codex: Required<Pick<CodexOptions, "bin" | "sandbox" | "timeoutMs" | "maxConcurrentTurns">> & {
    model: string | undefined;
    configOverrides: string[];
    env: Record<string, string>;
  };
}

/** Default state root: ~/.codex-octo-channel. */
export function defaultStateRoot(): string {
  return join(homedir(), ".codex-octo-channel");
}

/**
 * Normalize a string list into a trimmed, duplicate-free policy set.
 * @param values - raw configured ids.
 * @returns Cleaned id list.
 */
function normalizeIds(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

/**
 * Clamp a finite numeric setting to a safe integer range.
 * @param value - configured value.
 * @param fallback - default when unset or non-finite.
 * @param minimum - inclusive lower bound.
 * @param maximum - inclusive upper bound.
 * @returns The clamped integer.
 */
function clampInt(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value as number)));
}

/**
 * Apply defaults on top of a merged Config.
 * @param config - merged file + environment configuration.
 * @returns Fully resolved configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const stateRoot = resolve(config.stateRoot ?? defaultStateRoot());
  const codex = config.codex ?? {};
  const sandbox: CodexSandboxMode =
    codex.sandbox === "read-only" || codex.sandbox === "danger-full-access"
      ? codex.sandbox
      : "workspace-write";
  return {
    botToken: (config.botToken ?? "").trim(),
    apiUrl: (config.apiUrl ?? "").trim(),
    wsUrl: config.wsUrl?.trim() || undefined,
    stateRoot,
    sessionScope: config.sessionScope === "chat-sender" ? "chat-sender" : "chat",
    requireMention: config.requireMention ?? true,
    accessMode:
      config.accessMode === "allowlist" || config.accessMode === "open" ? config.accessMode : "owner",
    allowedUserIds: normalizeIds(config.allowedUserIds),
    allowedChatIds: normalizeIds(config.allowedChatIds),
    deniedUserIds: normalizeIds(config.deniedUserIds),
    deniedChatIds: normalizeIds(config.deniedChatIds),
    ackDelayMs: clampInt(config.ackDelayMs, 3000, 0, 300_000),
    maxMessageChars: clampInt(config.maxMessageChars, 12_000, 256, 200_000),
    maxQueuedTurns: clampInt(config.maxQueuedTurns, 3, 1, 32),
    heartbeatIntervalMs: clampInt(config.heartbeatIntervalMs, 30_000, 5_000, 300_000),
    maxReplyChars: clampInt(config.maxReplyChars, 3500, 500, 50_000),
    sendWorkspaceImages: config.sendWorkspaceImages ?? true,
    maxImagesPerTurn: clampInt(config.maxImagesPerTurn, 3, 1, 10),
    maxImageBytes: clampInt(config.maxImageBytes, 5_242_880, 10_240, 52_428_800),
    workspacesRoot: resolve(config.workspacesRoot ?? join(stateRoot, "workspaces")),
    workspaceMode: config.workspaceMode === "shared" ? "shared" : "per-chat",
    codex: {
      bin: codex.bin?.trim() || "codex",
      model: codex.model?.trim() || undefined,
      sandbox,
      configOverrides: (codex.configOverrides ?? []).filter((entry) => typeof entry === "string" && entry.includes("=")),
      timeoutMs: clampInt(codex.timeoutMs, 600_000, 30_000, 7_200_000),
      maxConcurrentTurns: clampInt(codex.maxConcurrentTurns, 4, 1, 32),
      env: { ...(codex.env ?? {}) },
    },
  };
}

/**
 * Read the JSON config file when present; a missing file is not an error.
 * @param path - absolute config.json path.
 * @returns Parsed partial configuration.
 */
function readConfigFile(path: string): Config {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Config;
  } catch (error) {
    throw new Error("invalid config file " + path + ": " + (error instanceof Error ? error.message : String(error)));
  }
}

/**
 * Overlay environment variables (CODEX_OCTO_*) on top of file configuration.
 * @param file - configuration parsed from config.json.
 * @param env - environment map (defaults to process.env).
 * @returns Merged configuration.
 */
function applyEnv(file: Config, env: NodeJS.ProcessEnv = process.env): Config {
  const merged: Config = { ...file };
  // "model" is not a Config key; it is lifted into codex.model afterwards.
  const str = (key: string, into: string): void => {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") (merged as Record<string, unknown>)[into] = value.trim();
  };
  str("CODEX_OCTO_BOT_TOKEN", "botToken");
  str("CODEX_OCTO_API_URL", "apiUrl");
  str("CODEX_OCTO_WS_URL", "wsUrl");
  str("CODEX_OCTO_STATE_ROOT", "stateRoot");
  str("CODEX_OCTO_WORKSPACES_ROOT", "workspacesRoot");
  str("CODEX_OCTO_ACCESS_MODE", "accessMode");
  str("CODEX_OCTO_MODEL", "model");
  return merged as Config & { model?: string };
}

/**
 * Lift a top-level `model` key (set via CODEX_OCTO_MODEL) into codex.model.
 * @param config - merged configuration.
 * @returns Configuration with the model override attached to the codex block.
 */
function liftModel(config: Config & { model?: string }): Config {
  if (config.model === undefined) return config;
  const { model, ...rest } = config;
  void model;
  return { ...rest, codex: { ...(rest.codex ?? {}), model } };
}

/**
 * Load and resolve configuration from the default or overridden path.
 * @param env - environment map (defaults to process.env).
 * @returns Fully resolved configuration.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const path = env.CODEX_OCTO_CONFIG?.trim() || join(defaultStateRoot(), "config.json");
  return resolveConfig(liftModel(applyEnv(readConfigFile(path), env)));
}
