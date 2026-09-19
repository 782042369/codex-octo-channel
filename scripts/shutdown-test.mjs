/**
 * Regression tests for the shutdown and driver-failure paths.
 *
 * The first case reproduces a bug where a turn that was already waiting for a
 * global concurrency slot still spawned a codex process after close(), which
 * could hold the shutdown for the full codex timeout.
 *
 * Usage: node scripts/shutdown-test.mjs
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { installChannel } from "../lib/channel.js";
import { resolveConfig } from "../lib/config.js";
import { CodexRunner } from "../lib/codex/runner.js";
import { SessionStore } from "../lib/codex/session-store.js";

const ROOT = "/tmp/codex-octo-shutdown-test";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

/** Wait for a fixed number of milliseconds.
 * @param ms - delay in milliseconds.
 * @returns A promise resolved after the delay.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Build a fake OctoPort that records outbound sends.
 * @returns The fake port.
 */
function makeFakePort() {
  const port = new EventEmitter();
  port.robotId = "bot";
  port.ownerUid = "owner";
  port.sends = [];
  port.onMessage = (handler) => {
    port.on("message", handler);
    return () => port.off("message", handler);
  };
  port.send = async (to, input) => {
    port.sends.push({ to, text: input.text ?? "" });
    return { messageId: "m" + port.sends.length };
  };
  port.typing = async () => undefined;
  port.sendImage = async () => ({ messageId: "i" });
  return port;
}

/** Build one normalized inbound message.
 * @param chatId - DM peer uid.
 * @param content - message text.
 * @returns The message object.
 */
function inbound(chatId, content) {
  return {
    chatId,
    channelType: 1,
    senderId: chatId,
    messageId: "m-" + Math.random().toString(36).slice(2),
    content,
    botMentioned: false,
    timestamp: Date.now(),
  };
}

/** Verify no codex process is spawned once the channel has been closed.
 * @returns A promise settled when the assertions ran.
 */
async function testShutdownDoesNotSpawn() {
  const config = resolveConfig({
    stateRoot: ROOT,
    accessMode: "open",
    ackDelayMs: 0,
    codex: { maxConcurrentTurns: 1, timeoutMs: 600_000 },
  });
  let releaseFirst;
  const firstRun = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let closed = false;
  const runner = {
    calls: 0,
    callsAfterClose: 0,
    async run() {
      this.calls += 1;
      if (closed) this.callsAfterClose += 1;
      await firstRun;
      return { ok: true, result: { threadId: "t", text: "done", resumed: false, durationMs: 1 } };
    },
    cancelAll() {
      this.cancelled = true;
    },
  };
  const port = makeFakePort();
  const store = SessionStore.open(ROOT + "/session-map.json");
  const channel = installChannel({ port, runner, store, config, notify: () => undefined });

  port.emit("message", inbound("user_a", "first"));
  await sleep(30);
  port.emit("message", inbound("user_b", "second"));
  await sleep(30);
  assert.equal(runner.calls, 1, "the first turn is running");

  closed = true;
  const closing = channel.close();
  releaseFirst();
  await closing;

  assert.equal(runner.callsAfterClose, 0, "no codex process starts after close()");
  assert.ok(
    port.sends.some((send) => send.to === "user_b" && send.text.includes("服务正在关闭")),
    "the waiting turn is failed with a shutdown notice",
  );
}

/** Verify the driver classifies a missing binary instead of blaming a timeout.
 * @returns A promise settled when the assertion ran.
 */
async function testSpawnErrorClassification() {
  const runner = new CodexRunner({ bin: "/nonexistent-codex-binary-xyz", sandbox: "workspace-write", timeoutMs: 5_000 });
  const outcome = await runner.run({ prompt: "hello", cwd: "/tmp" });
  assert.equal(outcome.ok, false, "a missing binary fails the turn");
  assert.equal(outcome.failure.kind, "spawn-error", "the failure is a spawn error, not a timeout");
}

/** Verify a cancelled runner refuses to spawn new work.
 * @returns A promise settled when the assertion ran.
 */
async function testCancelledRunnerRefusesWork() {
  const runner = new CodexRunner({ bin: "codex", sandbox: "workspace-write", timeoutMs: 5_000 });
  runner.cancelAll();
  const outcome = await runner.run({ prompt: "hello", cwd: "/tmp" });
  assert.equal(outcome.ok, false, "a cancelled runner fails fast");
  assert.equal(outcome.failure.kind, "cancelled", "the failure reports cancellation");
}

await testShutdownDoesNotSpawn();
await testSpawnErrorClassification();
await testCancelledRunnerRefusesWork();
console.log("codex-octo-channel shutdown + driver tests OK");
