/**
 * Online test against the real codex binary on this machine.
 *
 * Runs two real turns through CodexRunner: a fresh exec that plants a code
 * word, then a resume that must recall it and reuse the same thread id.
 * Also asserts the argv shape produced by buildCodexArgs.
 *
 * Usage: node scripts/codex-online-test.mjs
 * Env:   CODEX_BIN (default "codex"), CODEX_SANDBOX (default read-only),
 *        CODEX_TIMEOUT_MS (default 240000).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRunner, buildCodexArgs } from "../lib/codex/runner.js";

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

const bin = process.env.CODEX_BIN ?? "codex";
const sandbox = process.env.CODEX_SANDBOX ?? "read-only";
const timeoutMs = Number(process.env.CODEX_TIMEOUT_MS ?? 240000);
const runner = new CodexRunner({ bin, sandbox, timeoutMs, log: (line) => console.log("    [runner]", line) });

const workDir = mkdtempSync(join(tmpdir(), "codex-octo-online-"));
const codeWord = "BANANA-" + Math.random().toString(36).slice(2, 8).toUpperCase();

try {
  // argv shape
  const fresh = buildCodexArgs({ bin, sandbox, timeoutMs }, { prompt: "p", cwd: workDir }, "/tmp/last.txt");
  assert(fresh[0] === "exec" && fresh.includes("-s", 0) === false || fresh.includes("-s"), "fresh argv contains exec");
  assert(fresh.indexOf("exec") < fresh.indexOf("-s"), "fresh argv puts -s after exec");
  assert(fresh[fresh.length - 1] === "p" && fresh[fresh.length - 2] === "--", "prompt passed after -- separator");
  const resumeArgs = buildCodexArgs({ bin, sandbox, timeoutMs }, { prompt: "p", cwd: workDir, resumeThreadId: "TID" }, "/tmp/last.txt");
  assert(resumeArgs.includes("resume") && resumeArgs.includes("TID"), "resume argv carries the thread id");
  assert(resumeArgs.indexOf("resume") < resumeArgs.indexOf("--json"), "resume argv puts shared flags after the subcommand");
  assert(!resumeArgs.includes("-s"), "resume argv omits the sandbox flag");

  // turn 1: fresh exec, plant the code word
  console.log("# turn 1: fresh exec");
  const first = await runner.run({ prompt: "Remember this code word for later: " + codeWord + ". Reply with exactly: OK", cwd: workDir });
  assert(first.ok, "first turn ok");
  if (first.ok) {
    assert(first.result.text.trim().toUpperCase().includes("OK"), "first turn final message captured (" + first.result.text.slice(0, 40) + ")");
    assert(first.result.threadId !== "", "thread id captured from thread.started");
    assert(first.result.resumed === false, "first turn is not a resume");
  }

  // turn 2: resume, recall the code word
  console.log("# turn 2: resume");
  const threadId = first.ok ? first.result.threadId : "";
  const second = await runner.run({ prompt: "What was the code word I gave you earlier in this conversation? Reply with just the word.", cwd: workDir, resumeThreadId: threadId });
  assert(second.ok, "second turn ok");
  if (second.ok) {
    assert(second.result.text.includes(codeWord), "resume recalls the code word (" + second.result.text.slice(0, 60) + ")");
    assert(second.result.threadId === threadId, "resume keeps the same thread id");
    assert(second.result.resumed === true, "resume marked as resumed");
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\ncodex online test: PASS" : "\ncodex online test: FAIL (" + failures + ")");
process.exit(failures === 0 ? 0 : 1);