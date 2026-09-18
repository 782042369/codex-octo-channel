/**
 * Offline integration test for the channel glue, without a live Octo
 * server or the real codex binary.
 *
 * Mocks the transport and the codex driver; drives fake inbound messages
 * through installChannel and asserts on the outbound sends and runner calls.
 *
 * Usage: node scripts/integration-test.mjs
 */
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { installChannel } from "../lib/channel.js";
import { resolveConfig } from "../lib/config.js";

let failures = 0;

/** Assert one condition and record failures.
 * @param condition - expected truthy value.
 * @param label - human-readable assertion name.
 */
function assert(condition, label) {
  if (condition) console.log("  ok -", label);
  else {
    failures += 1;
    console.error("  FAIL -", label);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build a fake OctoPort that records sends and typing calls.
 * @returns The fake port object.
 */
function makeFakePort() {
  const port = new EventEmitter();
  port.robotId = "test_bot";
  port.ownerUid = "owner_uid";
  port.sends = [];
  port.tyings = [];
  port.onMessage = (handler) => {
    port.on("message", handler);
    return () => port.off("message", handler);
  };
  port.send = async (to, input, options) => {
    port.sends.push({ to, text: input.text ?? "", options: options ?? {} });
    return { messageId: "sent-" + port.sends.length };
  };
  port.typing = async (to, channelType) => {
    port.tyings.push({ to, channelType });
  };
  return port;
}

/** Build a fake codex driver with scripted outcomes.
 * @param behavior - function(request) -> outcome or promise; also object
 *                   fields: requests, delayMs, cancelled.
 * @returns The fake runner.
 */
function makeFakeRunner(behavior) {
  return {
    requests: [],
    cancelled: false,
    async run(request) {
      this.requests.push(request);
      if (behavior.delayMs > 0) await sleep(behavior.delayMs);
      return behavior.next(request);
    },
    cancelAll() {
      this.cancelled = true;
    },
  };
}

/** Compose one normalized inbound Octo message.
 * @param overrides - partial message fields.
 * @returns The frozen message object.
 */
function inbound(overrides) {
  return {
    chatId: "user_a",
    channelType: 1,
    senderId: "user_a",
    messageId: "m" + Math.random().toString(36).slice(2),
    content: "hello",
    botMentioned: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

const STATE_ROOT = "/tmp/coc-octo-integration/state";
rmSync(STATE_ROOT, { recursive: true, force: true });

/** Resolve a test configuration tuned for fast turns.
 * @param overrides - config fields layered over the base.
 * @returns Resolved configuration.
 */
function testConfig(overrides) {
  return resolveConfig({
    stateRoot: STATE_ROOT,
    accessMode: "open",
    ackDelayMs: 0,
    maxReplyChars: 600,
    ...overrides,
  });
}

/** Build the channel stack with fresh fakes.
 * @param config - resolved configuration.
 * @param behavior - fake runner behavior.
 * @returns The assembled stack.
 */
async function makeStack(config, behavior) {
  const { SessionStore } = await import("../lib/codex/session-store.js");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(STATE_ROOT, { recursive: true });
  const port = makeFakePort();
  const runner = makeFakeRunner(behavior);
  const store = SessionStore.open(STATE_ROOT + "/session-map.json");
  const channel = installChannel({ port, runner, store, config, notify: () => undefined });
  return { port, runner, store, channel };
}

// ── 1. DM reply + resume chain ────────────────────────────────────────────
console.log("# DM reply, session persistence, resume");
{
  let threadCounter = 0;
  const behavior = {
    delayMs: 0,
    next: (request) => ({
      ok: true,
      result: {
        threadId: "thread-" + (++threadCounter),
        text: "reply to: " + request.prompt.slice(0, 40),
        resumed: request.resumeThreadId !== undefined,
        durationMs: 5,
      },
    }),
  };
  const { port, runner, channel } = await makeStack(testConfig({}), behavior);
  port.emit("message", inbound({ content: "hi codex" }));
  await sleep(80);
  assert(runner.requests.length === 1, "one runner call after one DM");
  assert(runner.requests[0].resumeThreadId === undefined, "first turn starts fresh");
  assert(runner.requests[0].cwd.startsWith(STATE_ROOT + "/workspaces/"), "turn runs in a private workspace");
  assert(port.sends.length === 1 && port.sends[0].text.startsWith("reply to:"), "DM reply sent");

  port.emit("message", inbound({ content: "again please" }));
  await sleep(80);
  assert(runner.requests.length === 2, "second turn executed");
  assert(runner.requests[1].resumeThreadId === "thread-1", "second turn resumes thread-1");
  assert(port.sends.length === 2, "second reply sent");
  await channel.close();
}

// ── 2. Group gating and mentions ─────────────────────────────────────────
console.log("# Group mention gating");
{
  const behavior = { delayMs: 0, next: () => ({ ok: true, result: { threadId: "g1", text: "group reply", durationMs: 1 } }) };
  const { port, runner, channel } = await makeStack(testConfig({}), behavior);
  port.emit("message", inbound({ chatId: "group_1", channelType: 2, content: "no mention here" }));
  await sleep(50);
  assert(runner.requests.length === 0, "group message without mention ignored");
  port.emit("message", inbound({ chatId: "group_1", channelType: 2, senderId: "alice", content: "@bot do it", botMentioned: true }));
  await sleep(50);
  assert(runner.requests.length === 1, "mentioned group message answered");
  assert(runner.requests[0].prompt.startsWith("[群消息, 发送者 alice]"), "group prompt carries sender identity");
  assert(port.sends.at(-1).options.mentionUids?.[0] === "alice", "group reply @-mentions the sender");
  await channel.close();
}

// ── 3. /new resets the session ───────────────────────────────────────────
console.log("# /new command");
{
  let threads = 0;
  const behavior = { delayMs: 0, next: (request) => ({ ok: true, result: { threadId: "t" + (++threads), text: "ok", durationMs: 1 } }) };
  const { port, runner, channel } = await makeStack(testConfig({}), behavior);
  port.emit("message", inbound({ content: "first" }));
  await sleep(60);
  port.emit("message", inbound({ content: "/new" }));
  await sleep(60);
  assert(port.sends.at(-1).text.includes("新的 Codex 会话"), "/new acknowledged");
  port.emit("message", inbound({ content: "after reset" }));
  await sleep(60);
  assert(runner.requests.at(-1).resumeThreadId === undefined, "turn after /new starts fresh");
  await channel.close();
}

// ── 4. Backpressure ──────────────────────────────────────────────────────
console.log("# backpressure");
{
  const behavior = { delayMs: 150, next: () => ({ ok: true, result: { threadId: "b1", text: "busy reply", durationMs: 1 } }) };
  const { port, runner, channel } = await makeStack(testConfig({ maxQueuedTurns: 1 }), behavior);
  port.emit("message", inbound({ content: "one" }));
  port.emit("message", inbound({ content: "two" }));
  await sleep(300);
  assert(runner.requests.length === 1, "busy conversation drops the second turn");
  assert(port.sends.some((s) => s.text.includes("较多任务")), "backpressure notice sent");
  await channel.close();
}

// ── 5. Chunked long replies ──────────────────────────────────────────────
console.log("# long reply chunking");
{
  const longText = Array.from({ length: 60 }, (_, i) => "段落" + i + " 内容".repeat(12)).join("\n\n");
  const behavior = { delayMs: 0, next: () => ({ ok: true, result: { threadId: "c1", text: longText, durationMs: 1 } }) };
  const { port, channel } = await makeStack(testConfig({}), behavior);
  port.emit("message", inbound({ content: "write long" }));
  await sleep(80);
  const chunkSends = port.sends.filter((s) => s.text.startsWith("段落"));
  assert(chunkSends.length >= 3, "long reply split into chunks (" + chunkSends.length + ")");
  assert(chunkSends.every((s) => s.text.length <= 650), "every chunk within the char budget");
  await channel.close();
}

// ── 6. Failure redaction ─────────────────────────────────────────────────
console.log("# failure redaction");
{
  const behavior = {
    delayMs: 0,
    next: () => ({ ok: false, failure: { kind: "nonzero-exit", message: "Authorization: Bearer sk-secret123 exploded", beforeThreadStart: true } }),
  };
  const { port, channel } = await makeStack(testConfig({}), behavior);
  port.emit("message", inbound({ content: "boom" }));
  await sleep(80);
  const failure = port.sends.find((s) => s.text.includes("回答失败"));
  assert(failure !== undefined, "failure notice sent");
  assert(failure.text.includes("[redacted]"), "credentials redacted in failure text");
  assert(!failure.text.includes("sk-secret123"), "raw secret never reaches chat");
  await channel.close();
}

// ── 7. Delayed ack ───────────────────────────────────────────────────────
console.log("# delayed ack");
{
  const behavior = { delayMs: 250, next: () => ({ ok: true, result: { threadId: "a1", text: "final answer", durationMs: 1 } }) };
  const { port, channel } = await makeStack(testConfig({ ackDelayMs: 50 }), behavior);
  port.emit("message", inbound({ content: "slow one" }));
  await sleep(400);
  assert(port.sends[0].text.includes("正在处理"), "ack sent before the slow final answer");
  assert(port.sends.at(-1).text === "final answer", "final answer delivered after ack");
  assert(port.tyings.length >= 1, "typing indicator shown during the turn");
  await channel.close();
}

// ── 8. Access policy ─────────────────────────────────────────────────────
console.log("# access policy");
{
  const behavior = { delayMs: 0, next: () => ({ ok: true, result: { threadId: "p1", text: "should not happen", durationMs: 1 } }) };
  const { port, runner, channel } = await makeStack(testConfig({ accessMode: "owner" }), behavior);
  port.emit("message", inbound({ senderId: "stranger", chatId: "stranger", content: "let me in" }));
  await sleep(50);
  assert(runner.requests.length === 0, "non-owner message rejected by policy");
  port.emit("message", inbound({ senderId: "owner_uid", chatId: "owner_uid", content: "owner here" }));
  await sleep(50);
  assert(runner.requests.length === 1, "owner message accepted");
  await channel.close();
}

// ── 9. Workspace mode ────────────────────────────────────────────────────
console.log("# workspace mode");
{
  const behavior = { delayMs: 0, next: () => ({ ok: true, result: { threadId: "w1", text: "ok", durationMs: 1 } }) };
  const shared = await makeStack(testConfig({ workspaceMode: "shared", workspacesRoot: "/tmp/coc-octo-integration/shared-ws" }), behavior);
  shared.port.emit("message", inbound({ content: "ws" }));
  await sleep(60);
  assert(shared.runner.requests[0].cwd === "/tmp/coc-octo-integration/shared-ws", "shared mode runs in the shared directory");
  await shared.channel.close();
  const perChat = await makeStack(testConfig({ workspacesRoot: "/tmp/coc-octo-integration/per-ws" }), behavior);
  perChat.port.emit("message", inbound({ content: "ws" }));
  await sleep(60);
  const perCwd = perChat.runner.requests[0].cwd;
  assert(perCwd.startsWith("/tmp/coc-octo-integration/per-ws/") && perCwd !== "/tmp/coc-octo-integration/per-ws", "per-chat mode uses a private subdirectory");
  await perChat.channel.close();
}

console.log(failures === 0 ? "\nintegration test: PASS" : "\nintegration test: FAIL (" + failures + ")");
process.exit(failures === 0 ? 0 : 1);