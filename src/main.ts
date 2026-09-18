#!/usr/bin/env node
/** Process entry: wire config, transport, driver, and channel together.
 * @module codex-octo-channel/main
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, type ResolvedConfig } from "./config.js";
import { installChannel, type Channel } from "./channel.js";
import { OctoPort } from "./port.js";
import { CodexRunner } from "./codex/runner.js";
import { SessionStore } from "./codex/session-store.js";

/** Version reported to the Octo server at registration. */
const PLUGIN_VERSION = "0.1.0";

/** Timestamped stdout logger.
 * @param line - message without trailing newline.
 */
function log(line: string): void {
  console.log(new Date().toISOString() + " " + line);
}

/**
 * Validate that the resolved configuration carries connection credentials.
 * @param config - resolved configuration.
 * @returns True when botToken and apiUrl are both present.
 */
function hasCredentials(config: ResolvedConfig): boolean {
  return config.botToken !== "" && config.apiUrl !== "";
}

/**
 * Bootstrap the service: load config, open state, connect, install handlers.
 * @returns The process exit code.
 */
async function bootstrap(): Promise<number> {
  const config = loadConfig();
  if (!hasCredentials(config)) {
    log(
      "codex-octo-channel: botToken/apiUrl are not configured - create " +
        join(config.stateRoot, "config.json") +
        " (botToken, apiUrl) or set CODEX_OCTO_BOT_TOKEN / CODEX_OCTO_API_URL, then restart.",
    );
    return 1;
  }

  await mkdir(config.stateRoot, { recursive: true });
  const store = SessionStore.open(join(config.stateRoot, "session-map.json"));
  const port = new OctoPort({
    botToken: config.botToken,
    apiUrl: config.apiUrl,
    ...(config.wsUrl === undefined ? {} : { wsUrl: config.wsUrl }),
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    pluginVersion: PLUGIN_VERSION,
    log,
  });
  const runner = new CodexRunner({
    bin: config.codex.bin,
    sandbox: config.codex.sandbox,
    ...(config.codex.model === undefined ? {} : { model: config.codex.model }),
    ...(config.codex.configOverrides.length === 0 ? {} : { configOverrides: config.codex.configOverrides }),
    timeoutMs: config.codex.timeoutMs,
    log,
  });
  const channel = installChannel({ port, runner, store, config, notify: log });

  port.onLifecycle("reconnecting", () => log("codex-octo-channel: connection lost, reconnecting - events arriving now are not replayed"));
  port.onLifecycle("reconnected", () => log("codex-octo-channel: connection restored"));
  port.onLifecycle("error", (error?: Error) => log("codex-octo-channel: transport error: " + (error?.message ?? "unknown")));
  port.onLifecycle("heartbeat-failed", () => undefined);

  if (config.accessMode === "open") {
    log("codex-octo-channel: warning - accessMode=open grants the bot to every permitted chat");
  } else if (config.accessMode === "allowlist" && config.allowedUserIds.length === 0 && config.allowedChatIds.length === 0) {
    log("codex-octo-channel: accessMode=allowlist has no entries; all inbound messages will be denied");
  } else {
    log("codex-octo-channel: accessMode=" + config.accessMode + " (secure default: owner)");
  }
  log(
    "codex-octo-channel: starting bot (" + config.apiUrl + ", codex=" + config.codex.bin +
      ", sandbox=" + config.codex.sandbox + ", workspace=" + config.workspacesRoot +
      " [" + config.workspaceMode + "])" ,
  );

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) {
      log("codex-octo-channel: forced exit on second " + signal);
      process.exit(0);
    }
    closing = true;
    log("codex-octo-channel: " + signal + " received, shutting down");
    void (async (): Promise<void> => {
      try {
        await channel.close();
        await port.disconnect();
      } catch (error) {
        log("codex-octo-channel: shutdown error: " + (error instanceof Error ? error.message : String(error)));
      }
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await port.connect();
  } catch (error) {
    log("codex-octo-channel: connect failed: " + (error instanceof Error ? error.message : String(error)));
    await channel.close().catch(() => undefined);
    return 1;
  }
  log("codex-octo-channel: online as " + port.robotId + " (owner " + port.ownerUid + ")");
  return 0;
}

bootstrap().then(
  (code: number): void => {
    if (code !== 0) process.exit(code);
  },
  (error: unknown): void => {
    log("codex-octo-channel: fatal: " + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
  },
);
