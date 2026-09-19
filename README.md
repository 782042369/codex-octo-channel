<p align="center">
  <img src="https://raw.githubusercontent.com/782042369/codex-octo-channel/master/assets/readme-hero.png" width="220" alt="Octo 聊天机器人与本地终端 coding agent 相连的示意图">
</p>

<h1 align="center">codex-octo-channel</h1>

<p align="center">把 Octo 即时通讯接到本机 Codex CLI：每个私聊、群聊或话题各自拥有一个持久 Codex 线程与独立工作区，回答以文本消息回到 Octo。</p>

<p align="center">
  <a href="https://github.com/782042369/codex-octo-channel/blob/master/LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-22C55E?style=flat-square" alt="License: Apache 2.0"></a>
  <img src="https://img.shields.io/badge/Node-%3E%3D20-3776AB?style=flat-square" alt="Node.js 20 及以上">
  <a href="https://www.npmjs.com/package/codex-octo-channel"><img src="https://img.shields.io/npm/v/codex-octo-channel?style=flat-square&color=F59E0B" alt="npm 版本"></a>
  <img src="https://img.shields.io/badge/Codex%20CLI-local%20process-4B5563?style=flat-square" alt="本地 Codex CLI 进程">
</p>

这是一个独立的 Node 服务，不需要 DSH 宿主：它把消息交给本机 `codex` 二进制，每个回合就是一个受超时约束的 `codex exec`（或 `codex exec resume`）子进程，并用 JSONL 事件流解析结果。它是 [dsh-octo-channel](https://github.com/782042369/dsh-octo-channel) 的姊妹项目，区别只在被驱动的执行体。

## 核心能力

| 能力 | 说明 |
|---|---|
| 独立进程，无需宿主 | 单一 Node 服务直接驱动本机 Codex CLI，适合只有 Codex 的机器 |
| 每会话一个持久线程 | 从 `thread.started` 取线程 id 并即时落盘，重启后 `resume` 续接；resume 失败自动新建线程 |
| 每会话独立工作区 | 默认 `workspaces/<会话摘要>/`，可切 `shared` 模式让所有会话共用同一目录 |
| 并发与背压 | 每会话 FIFO + 排队上限，全局并发上限；单回合超时后 SIGTERM，宽限后 SIGKILL |
| 聊天体验 | typing 每 10 秒保活、3 秒未完成先回执、长回答分片、失败信息脱敏后回聊天 |
| 关停安全 | SIGTERM 后停收新回合、拒绝新子进程、取消在跑子进程、排空已定回复再断开连接 |

## 环境要求

- Node.js >= 20。
- 本机已安装并登录 `codex` CLI（开发验证于 0.153.4）。
- 一个专用的 Octo 机器人 token（请勿与 dsh-octo-channel 共用：两个服务注册同一 bot 会互相顶掉）。

## 快速安装

```bash
# 一键脚本（检查环境 -> 安装 -> 交互询问 Token -> 可选开机自启）
curl -fsSL https://raw.githubusercontent.com/782042369/codex-octo-channel/master/install.sh | bash

# 或从 npm 全局安装
npm i -g codex-octo-channel
codex-octo-channel

# 或从源码运行
git clone https://github.com/782042369/codex-octo-channel.git
cd codex-octo-channel && npm install && npm run build && npm start
```

## 快速开始

1. 写 `~/.codex-octo-channel/config.json`（可参考仓库内 `config.example.json`）：

```json
{
  "botToken": "bf_your_dedicated_bot_token",
  "apiUrl": "https://im.example.com/api",
  "accessMode": "owner",
  "codex": {
    "bin": "/usr/local/bin/codex",
    "sandbox": "workspace-write",
    "timeoutMs": 600000
  }
}
```

2. 启动 `codex-octo-channel`，日志出现 `codex-octo-channel: online as <robot_id> (owner <uid>)`。
3. 在 Octo 私聊机器人（群聊需 @），看到「收到，正在处理…」后等待最终回答。
4. 发 `/status` 可查看当前线程 id、队列长度、模型、沙箱与工作区路径。

## 聊天内命令

| 命令 | 作用 |
|---|---|
| `/new` | 丢弃当前线程映射，下一条消息从全新 Codex 上下文开始 |
| `/status` | 显示线程 id、排队数、模型、沙箱模式与工作区路径 |
| `/help` | 显示帮助 |

## 配置

配置文件为 `~/.codex-octo-channel/config.json`，环境变量 `CODEX_OCTO_*` 可覆盖文件（如 `CODEX_OCTO_BOT_TOKEN`、`CODEX_OCTO_API_URL`、`CODEX_OCTO_MODEL`）。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `botToken` | 必填 | 专用 Octo 机器人 token |
| `apiUrl` | 必填 | Octo REST 基础地址 |
| `wsUrl` | 自动 | WuKongIM WebSocket 地址覆盖 |
| `stateRoot` | `~/.codex-octo-channel` | 会话映射与工作区根目录 |
| `accessMode` | `owner` | `owner` / `allowlist` / `open` |
| `allowedUserIds` / `allowedChatIds` | `[]` | 白名单 |
| `deniedUserIds` / `deniedChatIds` | `[]` | 黑名单 |
| `requireMention` | `true` | 群聊仅响应 @ |
| `sessionScope` | `chat` | `chat` 或 `chat-sender` |
| `ackDelayMs` | `3000` | 超时先回执；`0` 关闭 |
| `maxMessageChars` | `12000` | 入站消息长度上限 |
| `maxQueuedTurns` | `3` | 每会话排队上限 |
| `maxReplyChars` | `3500` | 出站长回答分片阈值 |
| `workspacesRoot` | `<stateRoot>/workspaces` | 工作区根目录 |
| `workspaceMode` | `per-chat` | `per-chat` 每会话一个子目录；`shared` 全部共用根目录 |
| `sendWorkspaceImages` | `true` | 回合内新出现的图片自动发回聊天 |
| `maxImagesPerTurn` / `maxImageBytes` | `3` / `5242880` | 每回合图片数量与单张大小上限 |
| `codex.bin` | `codex` | codex 可执行文件（systemd 下建议绝对路径） |
| `codex.sandbox` | `workspace-write` | 新线程沙箱：`read-only` / `workspace-write` / `danger-full-access` |
| `codex.model` | CLI 默认 | `-m` 覆盖 |
| `codex.timeoutMs` | `600000` | 单回合墙钟上限 |
| `codex.maxConcurrentTurns` | `4` | 全局并发 codex 进程上限 |

## 服务化

仓库内提供 systemd 单元示例：

```bash
cp systemd/codex-octo-channel.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now codex-octo-channel
journalctl -u codex-octo-channel -f
```

## 测试

```bash
npm test                            # typecheck + build + 全部离线套件
node scripts/integration-test.mjs   # 假传输 + 假 driver
node scripts/crypto-test.mjs        # 会话加密与帧解析向量
node scripts/shutdown-test.mjs      # 关停与 driver 失败路径
node scripts/codex-online-test.mjs  # 真实 codex：新建执行 + resume 记忆
OCTO_TOKEN=bf_... OCTO_API_URL=... node scripts/smoke.mjs   # 真实 Octo 冒烟
```

## 设计说明

- 线程身份：线程 id 取 `thread.started.thread_id`（resume 时会原样重现），一有值就落盘；resume 在开线程前失败（如 rollout 被清理）会自动改用新线程重试一次。
- argv 顺序：共享参数放在 `exec`/`resume` 子命令之后——放在 `resume` 之前的 exec 级参数无法可靠传递（验证于 0.153.4）。
- 沙箱：`-s` 只作用于新线程，`codex exec resume` 沿用已存策略，因此请在会话第一次提问前就定好 `codex.sandbox`。
- 关停：SIGTERM 会取消排队回合、终止在跑子进程、排空发送，然后断开连接；等待信号量槽位的回合在关停后不会再启动新进程。

## 目录结构

```text
src/
  main.ts               进程入口：配置、装配、信号处理
  channel.ts            入站粘合：访问策略、@ 门控、队列、命令
  config.ts             配置文件与 CODEX_OCTO_* 环境变量
  port.ts               Octo 传输（注册 / WS / 心跳 / 发送 / 图片）
  reply-presenter.ts    typing 保活、延迟回执、分片发送
  conversation.ts       会话键与工作区摘要名
  codex/
    runner.ts           codex exec/resume 驱动（JSONL、超时、取消）
    session-store.ts    会话到线程 id 的原子持久化映射
  protocol/             移植的 Octo 协议（见 NOTICE）
```

## 许可证

Apache-2.0。`src/protocol/` 下的协议层经 [782042369/dsh-octo-channel](https://github.com/782042369/dsh-octo-channel) 移植自 [Mininglamp-OSS/openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo)（Apache-2.0），详见 [NOTICE](./NOTICE)。
