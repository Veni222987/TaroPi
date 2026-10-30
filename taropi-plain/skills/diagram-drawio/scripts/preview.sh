#!/bin/bash
# 用无头浏览器打开 drawio 预览页，让 export_diagram 和 screenshot_diagram 可用。
# 用法：
#   bash preview.sh start <Browser URL>   停掉旧预览并打开新会话的预览
#   bash preview.sh stop                  关闭预览
#   bash preview.sh status                查看预览进程
# 环境变量：DRAWIO_CHROME（浏览器路径）、XDG_DATA_HOME。
set -euo pipefail

DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/next-drawio"
STATE_DIR="$DATA_ROOT/preview"
PID_FILE="$STATE_DIR/chrome.pid"
LOG_FILE="$STATE_DIR/chrome.log"
PROFILE_DIR="$STATE_DIR/profile"

fail() {
  echo "失败: $1" >&2
  echo "修复提示: $2" >&2
  exit 1
}

find_browser() {
  local bin
  for bin in "${DRAWIO_CHROME:-}" "$HOME/.local/bin/chrome-headless-shell" "$(command -v chrome-headless-shell 2>/dev/null || true)"; do
    if [ -n "$bin" ] && [ -x "$bin" ]; then
      echo "$bin"
      return 0
    fi
  done
  return 1
}

# running_pid 输出仍在运行的预览进程 pid，并确认它确实是浏览器，避免误杀被复用的 pid。
running_pid() {
  local pid
  [ -s "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE")"
  [ -r "/proc/$pid/cmdline" ] || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q 'chrome-headless-shell' || return 1
  echo "$pid"
}

stop_preview() {
  local pid
  if pid="$(running_pid)"; then
    kill "$pid" 2>/dev/null || true
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.3
    done
    echo "已关闭预览 (pid $pid)"
  else
    echo "没有在运行的预览"
  fi
  : >"$PID_FILE" 2>/dev/null || true
}

start_preview() {
  local url="${1:-}" bin
  case "$url" in
    http://localhost:*/shell/?mcp=*|http://127.0.0.1:*/shell/?mcp=*) ;;
    *) fail "地址不是 drawio 预览页: $url" "传入 start_session 返回的 Browser URL" ;;
  esac
  bin="$(find_browser)" || fail "找不到 chrome-headless-shell" "先运行 install-browser.sh"
  mkdir -p "$STATE_DIR" "$PROFILE_DIR"
  stop_preview >/dev/null

  local args=(--disable-gpu --user-data-dir="$PROFILE_DIR" --remote-debugging-port=0)
  if [ "$(id -u)" = 0 ]; then args+=(--no-sandbox); fi
  nohup "$bin" "${args[@]}" "$url" >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 2
  running_pid >/dev/null || fail "浏览器启动后退出" "查看 $LOG_FILE"
  echo "已打开预览 (pid $(cat "$PID_FILE")): $url"
}

main() {
  case "${1:-}" in
    start) start_preview "${2:-}" ;;
    stop) stop_preview ;;
    status)
      if running_pid >/dev/null; then echo "预览运行中 (pid $(cat "$PID_FILE"))"; else echo "预览未运行"; fi
      ;;
    -h|--help|"") sed -n '2,8p' "$0" ;;
    *) echo "未知子命令: $1" >&2; exit 2 ;;
  esac
}

main "$@"
