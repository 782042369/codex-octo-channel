/**
 * Protocol smoke test against a live Octo server.
 *
 * Registers the bot, awaits the WuKongIM CONNACK, sends one heartbeat, and
 * (optionally, OCTO_GREET=1) DMs the owner a greeting. Needs a dedicated bot
 * token - do NOT reuse the dsh-octo-channel bot, registrations would evict
 * each other.
 *
 * Usage: OCTO_TOKEN=bf_... OCTO_API_URL=https://im.example.com/api node scripts/smoke.mjs
 */
import { OctoPort } from "../lib/port.js";

const token = process.env.OCTO_TOKEN ?? "";
const apiUrl = process.env.OCTO_API_URL ?? "";
if (token === "" || apiUrl === "") {
  console.error("smoke: set OCTO_TOKEN and OCTO_API_URL first");
  process.exit(2);
}

const log = (line) => console.log(new Date().toISOString(), line);
const port = new OctoPort({
  botToken: token,
  apiUrl,
  heartbeatIntervalMs: 30_000,
  pluginVersion: "0.1.0-smoke",
  log,
});
port.onMessage((message) => log("smoke: inbound " + JSON.stringify(message).slice(0, 200)));
port.onLifecycle("reconnecting", () => log("smoke: reconnecting"));
port.onLifecycle("reconnected", () => log("smoke: reconnected"));

try {
  await port.connect();
  log("smoke: online as " + port.robotId + " (owner " + port.ownerUid + ")");
  if (process.env.OCTO_GREET === "1") {
    const result = await port.send(port.ownerUid, { text: "codex-octo-channel smoke ok" }, { channelType: 1 });
    log("smoke: greeting sent (messageId=" + result.messageId + ")");
  }
  log("smoke: holding the connection for 10s");
  await new Promise((resolve) => setTimeout(resolve, 10_000));
} catch (error) {
  log("smoke: FAILED - " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  await port.disconnect().catch(() => undefined);
  log("smoke: disconnected");
}