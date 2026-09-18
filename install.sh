#!/usr/bin/env bash
#
# codex-octo-channel installer — one command for non-technical users.
#
# Interactive:
#   curl -fsSL https://raw.githubusercontent.com/782042369/codex-octo-channel/master/install.sh | bash
#
# Non-interactive (for automation):
#   CODEX_OCTO_INSTALL_TOKEN=bf_xxx CODEX_OCTO_INSTALL_API_URL=https://host/api SKIP_START=1 bash install.sh
#
set -u

PACKAGE="codex-octo-channel"
CONFIG_DIR="$HOME/.codex-octo-channel"
CONFIG_FILE="$CONFIG_DIR/config.json"
SERVICE_NAME="codex-octo-channel"

# ── pretty output helpers ────────────────────────────────────────────────

# Print a step banner.
step() { printf "\n\033[1;36m==> %s\033[0m\n" "$1"; }
# Print a success line.
ok()   { printf "\033[1;32m OK %s\033[0m\n" "$1"; }
# Print a warning line.
warn() { printf "\033[1;33m ! %s\033[0m\n" "$1"; }
# Print a fatal line and exit.
die()  { printf "\033[1;31m X %s\033[0m\n" "$1"; exit 1; }

# Read one answer from the terminal (works even when piped from curl).
# $1 = prompt text, $2 = variable name, $3 = secret(yes/no).
ask() {
  local prompt="$1" var="$2" secret="$3"
  local answer=""
  if [ "$secret" = "yes" ]; then
    printf "%s" "$prompt"
    read -rs answer < /dev/tty
    printf "\n"
  else
    printf "%s" "$prompt"
    read -r answer < /dev/tty
  fi
  printf -v "$var" '%s' "$answer"
}

# ── 0. welcome ───────────────────────────────────────────────────────────

printf '\033[1m%s\033[0m\n' "codex-octo-channel 安装器 / installer"
printf '%s\n' "把 Octo 聊天里的机器人接到本机 Codex，装完即可在聊天里直接对话。"

OS="$(uname -s)"
[ "$OS" = "Linux" ] || [ "$OS" = "Darwin" ] || die "请分别在 Linux 或 macOS (WSL) 上运行 / run on Linux or macOS only."

# ── 1. node >= 20 ────────────────────────────────────────────────────────

step "步骤 1/5：检查 Node.js（需要 20 或更高版本）"
if ! command -v node >/dev/null 2>&1; then
  warn "没有找到 Node.js。请先复制运行下面这行，装好后重新运行本脚本："
  printf '%s\n' "  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && . $HOME/.nvm/nvm.sh && nvm install --lts"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 版本太低（当前 $(node -v)），请安装 20+ 后重试。"
ok "Node.js $(node -v)"

# ── 2. codex cli ─────────────────────────────────────────────────────────

step "步骤 2/5：检查 Codex CLI"
if command -v codex >/dev/null 2>&1; then
  ok "Codex CLI $(codex --version 2>/dev/null | head -1)"
  if codex login status 2>/dev/null | grep -qi "logged in"; then
    ok "Codex 已登录"
  else
    warn "Codex 还没有登录。请在另一个终端运行: codex login ，完成后再回来按回车继续。"
    read -r _ < /dev/tty 2>/dev/null || true
  fi
else
  warn "没有找到 codex 命令。请先安装: npm install -g @openai/codex ，再运行 codex login 登录，然后重新运行本脚本。"
  exit 1
fi

# ── 3. install the package ───────────────────────────────────────────────

step "步骤 3/5：安装 $PACKAGE（来自 npm）"
if npm install -g "$PACKAGE" >/dev/null 2>&1; then
  ok "安装完成"
elif command -v sudo >/dev/null 2>&1 && sudo npm install -g "$PACKAGE" >/dev/null 2>&1; then
  ok "安装完成（使用了 sudo）"
else
  die "npm 全局安装失败。可先运行: sudo npm install -g $PACKAGE ，再重新运行本脚本。"
fi
BIN_PATH="$(command -v codex-octo-channel || true)"
CODEX_BIN="$(command -v codex || true)"

# ── 4. configuration ─────────────────────────────────────────────────────

step "步骤 4/5：填写机器人信息（会保存在本机，仅自己可读）"
BOT_TOKEN="${CODEX_OCTO_INSTALL_TOKEN:-}"
API_URL="${CODEX_OCTO_INSTALL_API_URL:-}"
if [ -f "$CONFIG_FILE" ]; then
  ok "发现已有配置 $CONFIG_FILE，跳过覆盖（想重新配置就删掉它再跑本脚本）"
elif [ -z "$BOT_TOKEN" ] || [ -z "$API_URL" ]; then
  if [ ! -e /dev/tty ]; then
    die "非交互环境请用环境变量提供: CODEX_OCTO_INSTALL_TOKEN / CODEX_OCTO_INSTALL_API_URL"
  fi
  ask "  机器人 Token（BotFather 给的 bf_ 开头那串，输入时不会显示）: " BOT_TOKEN yes
  ask "  Octo 服务器地址（管理员会发给你，形如 https://xx/api ）: " API_URL no
  [ -n "$BOT_TOKEN" ] || die "Token 不能为空。"
  [ -n "$API_URL" ] || die "服务器地址不能为空。"
fi
if [ ! -f "$CONFIG_FILE" ]; then
  mkdir -p "$CONFIG_DIR"
  umask 177
  cat > "$CONFIG_FILE" <<EOF
{
  "botToken": "$BOT_TOKEN",
  "apiUrl": "$API_URL",
  "accessMode": "owner",
  "requireMention": true,
  "ackDelayMs": 3000,
  "codex": {
    "bin": "$CODEX_BIN",
    "sandbox": "workspace-write",
    "timeoutMs": 600000
  }
}
EOF
  chmod 600 "$CONFIG_FILE"
  ok "配置已写入 $CONFIG_FILE"
fi

# ── 5. keep it running ───────────────────────────────────────────────────

step "步骤 5/5：让机器人保持在线"
if [ "${SKIP_START:-0}" = "1" ]; then
  ok "已按要求跳过启动。手动运行: codex-octo-channel"
elif [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1 && [ -n "$BIN_PATH" ]; then
  UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"
  if [ -f "$UNIT_FILE" ]; then
    ok "systemd 服务已存在，重启并设为开机自启"
    sudo systemctl restart "$SERVICE_NAME"
  elif command -v sudo >/dev/null 2>&1; then
    NODE_BIN_DIR="$(dirname "$(command -v node)")"
    CODEX_BIN_DIR="$(dirname "$CODEX_BIN")"
    sudo tee "$UNIT_FILE" >/dev/null <<EOF
[Unit]
Description=codex-octo-channel (Octo IM bridge for the Codex CLI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
ExecStart=$BIN_PATH
Environment=HOME=$HOME
Environment=PATH=$NODE_BIN_DIR:$CODEX_BIN_DIR:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1
    sleep 4
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      ok "机器人已上线并设为开机自启"
    else
      warn "服务启动中，稍后可用这条命令查看状态: systemctl status $SERVICE_NAME"
    fi
  else
    warn "没有 sudo，无法安装 systemd 服务。需要时在终端运行: codex-octo-channel"
  fi
else
  printf '%s\n' "  macOS 或无 systemd 环境：在终端运行下面的命令即可（保持窗口开启）："
  printf '%s\n' "    codex-octo-channel"
fi

# ── done ─────────────────────────────────────────────────────────────────

printf '\n'
printf '\033[1;32m%s\033[0m\n' "安装完成！现在可以："
printf '%s\n' "  1. 在 Octo 里找到你的机器人，直接发消息（群里需要 @它）"
printf '%s\n' "  2. 发送 /help 查看可用命令（/new 开新会话、/status 看状态）"
printf '%s\n' "  3. 查看运行日志: journalctl -u $SERVICE_NAME -f （macOS 直接看运行窗口）"
printf '\n'
