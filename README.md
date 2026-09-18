# codex-octo-channel

> Octo IM channel for the [Codex CLI](https://github.com/openai/codex): each Octo DM, group, or thread drives its own persistent Codex session on this machine; committed answers return to Octo as text messages, with typing indicators and an online heartbeat.

Sister project of [dsh-octo-channel](https://github.com/782042369/dsh-octo-channel) (which bridges Octo to DeepSeek Harness agents). This service is a **standalone Node process** — no DSH host required — that swaps the DSH agent layer for the local `codex` binary: every turn is one bounded `codex exec` / `codex exec resume` child process with JSONL event parsing.

## What it does

- Registers a **dedicated bot** with the Octo server and keeps it online (WuKongIM WebSocket + 30s heartbeat, auto-reconnect).
- Receives DMs and group/thread messages; groups only respond to @-mentions (`requireMention`).
- Each conversation facet owns **one persistent Codex thread** (`codex exec resume`, thread id captured from `thread.started`) and **one private workspace directory** under `stateRoot/workspaces/`, surviving restarts.
- Long turns keep the chat alive: typing indicator every 10s, a "收到，正在处理…" ack after 3s (configurable), and the committed final answer is read back from `--output-last-message`.
- Per-conversation FIFO queue with backpressure, plus a global cap on concurrent codex processes.
- In-chat commands: `/new` (fresh Codex context), `/status` (thread id, queue, model), `/help`.
- Owner-first access policy (`accessMode: owner | allowlist | open`), denylists, message length caps, redacted failure replies, and chunked long answers.

## Requirements

- Node.js >= 20 and a `codex` CLI (>= 0.14x, verified with 0.153.4) already logged in on this machine.
- A **dedicated Octo bot token** (create one via BotFather). Do not reuse the dsh-octo-channel bot: two services registering the same bot evict each other.

## Install

```bash
git clone https://github.com/782042369/codex-octo-channel.git
cd codex-octo-channel
npm install
npm run build
npm test   # optional: offline integration test

## Configure

Create `~/.codex-octo-channel/config.json` (see `config.example.json`); environment variables `CODEX_OCTO_*` override the file.

```json
{
  "botToken": "bf_...",
  "apiUrl": "https://im.example.com/api",
  "accessMode": "owner",
  "codex": {
    "bin": "/root/.nvm/versions/node/v24.19.0/bin/codex",
    "sandbox": "workspace-write",
    "timeoutMs": 600000
  }
}
```

| Field | Default | Description |
|---|---|---|
| `botToken` | — (required) | Dedicated Octo bot token (`bf_...` or `app_...`) |
| `apiUrl` | — (required) | Octo REST base URL |
| `wsUrl` | auto | WuKongIM WebSocket URL override |
| `stateRoot` | `~/.codex-octo-channel` | session map + per-chat workspaces |
| `accessMode` | `owner` | `owner` / `allowlist` / `open` |
| `allowedUserIds` / `allowedChatIds` | `[]` | explicit allowlist entries |
| `requireMention` | `true` | groups only respond to @-mentions |
| `sessionScope` | `chat` | `chat` or `chat-sender` (per-sender threads in groups) |
| `ackDelayMs` | `3000` | delayed "working on it" note; `0` disables |
| `maxQueuedTurns` | `3` | per-conversation backpressure |
| `maxReplyChars` | `3500` | longer answers are chunked |
| `workspacesRoot` | `<stateRoot>/workspaces` | root directory for codex workspaces |
| `workspaceMode` | `per-chat` | `per-chat`: one subdirectory per conversation; `shared`: all chats share `workspacesRoot` directly (single-cwd mode, like dsh-octo-channel) |
| `codex.bin` | `codex` | codex executable (use an absolute path under systemd) |
| `codex.sandbox` | `workspace-write` | sandbox for fresh threads (`read-only` / `workspace-write` / `danger-full-access`) |
| `codex.model` | CLI default | `-m` override |
| `codex.timeoutMs` | `600000` | hard wall-clock limit per turn |
| `codex.maxConcurrentTurns` | `4` | global concurrent codex process cap |

## Run

```bash
npm start                      # foreground
node scripts/smoke.mjs         # protocol smoke against a live Octo server
```

Systemd (example unit in `systemd/`):

```bash
cp systemd/codex-octo-channel.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now codex-octo-channel
journalctl -u codex-octo-channel -f
```

## Tests

```bash
npm test                        # typecheck + build + offline integration test
node scripts/integration-test.mjs   # fake transport + fake codex driver
node scripts/codex-online-test.mjs  # REAL codex: fresh exec + resume recall
OCTO_TOKEN=bf_... OCTO_API_URL=... node scripts/smoke.mjs   # live Octo
```

## Layout

```
src/
  main.ts               process entry: config, wiring, signals
  channel.ts            inbound glue: policy, gating, queues, commands
  config.ts             config file + CODEX_OCTO_* env loading
  port.ts               Octo transport (register/WS/heartbeat/send)
  reply-presenter.ts    typing keep-alive, delayed ack, chunked final send
  conversation.ts       conversation keys + workspace slugs
  codex/
    runner.ts           codex exec/resume driver (JSONL, timeout, cancel)
    session-store.ts    conversation -> thread id map (atomic persistence)
  protocol/             ported Octo protocol (see NOTICE)
```

## Design notes

- **Thread identity**: the driver captures `thread.started.thread_id` (re-emitted unchanged on resume) and persists it per conversation; a resume that fails before the thread starts (e.g. pruned rollout) retries once with a fresh thread.
- **Argv order**: shared flags are placed after the `exec`/`resume` subcommand — exec-level flags before `resume` do not reliably reach the subcommand (verified against 0.153.4).
- **Sandbox**: `-s` applies to fresh threads only; `codex exec resume` inherits the stored policy, so tighten `codex.sandbox` before the first turn of a chat.
- **Graceful stop**: SIGTERM cancels queued turns, SIGTERMs in-flight codex children, drains presenters, then disconnects the transport.

## License

Apache-2.0. The protocol layer under `src/protocol/` is ported from [Mininglamp-OSS/openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo) (Apache-2.0) via [782042369/dsh-octo-channel](https://github.com/782042369/dsh-octo-channel); see [NOTICE](./NOTICE).