#!/bin/bash
# 幂等配置 drawio MCP：写入 mcporter 配置、建数据目录、安装无头浏览器、启动 keep-alive 守护进程。
# 用法：bash setup.sh [--dry-run] [--no-browser]
# 依赖：node、npx、mcporter。可用 MCPORTER_CONFIG 指定配置文件，用 XDG_DATA_HOME 调整数据根目录。
set -euo pipefail

DRY_RUN=0
INSTALL_BROWSER=1
HERE="$(cd "$(dirname "$0")" && pwd)"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-browser) INSTALL_BROWSER=0 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

CONFIG="${MCPORTER_CONFIG:-$HOME/.mcporter/mcporter.json}"
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/next-drawio"
SRC_DIR="$DATA_ROOT/src"
EXPORT_DIR="$DATA_ROOT/exported"
export MCPORTER_CONFIG="$CONFIG"

fail() {
  echo "失败: $1" >&2
  echo "修复提示: $2" >&2
  exit 1
}

run() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

check_requirements() {
  command -v node >/dev/null || fail "缺少 node" "安装 Node.js 18 及以上版本"
  command -v npx >/dev/null || fail "缺少 npx" "安装 npm（随 Node.js 提供）"
  command -v mcporter >/dev/null || fail "缺少 mcporter" "执行 npm install -g mcporter"
}

# merge_config 合并 drawio 条目：缺失则新增；已存在只补 lifecycle 与 DRAWIO_DATA_DIR，不覆盖其他字段。
# 输出 created、updated 或 unchanged；dry-run 时不落盘。
merge_config() {
  CONFIG="$CONFIG" SRC_DIR="$SRC_DIR" DRY_RUN="$DRY_RUN" node -e '
const fs = require("node:fs");
const path = require("node:path");
const { CONFIG, SRC_DIR, DRY_RUN } = process.env;
let root = { mcpServers: {} };
let existed = false;
if (fs.existsSync(CONFIG)) {
  existed = true;
  try {
    root = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch (error) {
    console.error("解析失败: " + error.message);
    process.exit(1);
  }
}
if (!root || typeof root !== "object" || Array.isArray(root)) {
  console.error("配置文件顶层不是对象");
  process.exit(1);
}
if (!root.mcpServers || typeof root.mcpServers !== "object") root.mcpServers = {};
const before = JSON.stringify(root);
let entry = root.mcpServers.drawio;
const isNew = !entry;
if (isNew) {
  entry = {
    command: "npx",
    args: ["-y", "@next-ai-drawio/mcp-server@latest"],
    description: "next-ai-draw-io: draw.io MCP server",
  };
}
entry.lifecycle = "keep-alive";
entry.env = entry.env && typeof entry.env === "object" ? entry.env : {};
if (!entry.env.DRAWIO_DATA_DIR) entry.env.DRAWIO_DATA_DIR = SRC_DIR;
if (!entry.env.BROWSER) entry.env.BROWSER = "none";
root.mcpServers.drawio = entry;
const changed = JSON.stringify(root) !== before || !existed;
if (changed && DRY_RUN !== "1") {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  if (existed) fs.copyFileSync(CONFIG, CONFIG + ".bak-" + new Date().toISOString().replace(/\D/g, "").slice(0, 14));
  const tmp = CONFIG + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(root, null, 2) + "\n");
  fs.renameSync(tmp, CONFIG);
}
console.log(!changed ? "unchanged" : isNew ? "created" : "updated");
const dir = entry.env.DRAWIO_DATA_DIR;
if (dir !== SRC_DIR) console.error("提示: 已有 DRAWIO_DATA_DIR=" + dir + "，保持不变，未改成 " + SRC_DIR);
'
}

ensure_daemon() {
  local changed="$1"
  local status
  status="$(mcporter daemon status 2>&1 || true)"
  if grep -q 'Daemon pid' <<<"$status"; then
    if [ "$changed" != unchanged ]; then
      echo "配置已变更，重启守护进程使 env 与 lifecycle 生效（未保存的画布会话会断开，已保存的 .drawio 不受影响）"
      run mcporter daemon restart
    else
      echo "守护进程已在运行"
    fi
  else
    run mcporter daemon start
  fi
}

main() {
  check_requirements
  echo "配置文件: $CONFIG"
  echo "源文件目录: $SRC_DIR"
  echo "导出目录: $EXPORT_DIR"

  local result
  result="$(merge_config)" || fail "合并 mcporter 配置失败" "手工修正 $CONFIG 为合法 JSON 后重跑（此时尚未改动该文件）"
  echo "drawio 条目: $result"

  run mkdir -p "$SRC_DIR" "$EXPORT_DIR"
  if [ "$INSTALL_BROWSER" = 1 ]; then
    if [ "$DRY_RUN" = 1 ]; then bash "$HERE/install-browser.sh" --dry-run; else bash "$HERE/install-browser.sh"; fi
  fi
  ensure_daemon "$result"

  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] 未写入任何文件，未启动守护进程"
    return 0
  fi
  mcporter config doctor || fail "config doctor 未通过" "按上面的输出修复配置后重跑本脚本"
  mcporter daemon status
}

main
