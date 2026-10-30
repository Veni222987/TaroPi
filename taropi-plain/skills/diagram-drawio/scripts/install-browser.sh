#!/bin/bash
# 幂等安装 chrome-headless-shell 到 ~/.local/bin，供 drawio MCP 无头渲染预览页。
# 用法：bash install-browser.sh [--dry-run]
# 环境变量：DRAWIO_BIN_DIR（安装目录，默认 ~/.local/bin）、DRAWIO_CHROME_VERSION、DRAWIO_CHROME_URL（可为 file:// 本地 zip）。
set -euo pipefail

VERSION="${DRAWIO_CHROME_VERSION:-156.0.8078.80}"
BIN_DIR="${DRAWIO_BIN_DIR:-$HOME/.local/bin}"
BASE_URL="${DRAWIO_CHROME_BASE_URL:-https://registry.npmmirror.com/-/binary/chrome-for-testing}"
URL="${DRAWIO_CHROME_URL:-$BASE_URL/$VERSION/linux64/chrome-headless-shell-linux64.zip}"
CACHE_DIR="${DRAWIO_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/next-drawio}"
ZIP="$CACHE_DIR/chrome-headless-shell-$VERSION.zip"
LINK="$BIN_DIR/chrome-headless-shell"
TARGET="$BIN_DIR/chrome-headless-shell-$VERSION"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

fail() {
  echo "失败: $1" >&2
  echo "修复提示: $2" >&2
  exit 1
}

check_platform() {
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] \
    || fail "当前平台 $(uname -s)/$(uname -m) 暂不支持自动安装" "自行安装 chrome-headless-shell 并放到 PATH 上"
  command -v curl >/dev/null || fail "缺少 curl" "安装 curl"
  command -v unzip >/dev/null || fail "缺少 unzip" "安装 unzip"
}

# already_installed 判断链接或 PATH 里是否已有可运行的 chrome-headless-shell。
already_installed() {
  local bin
  for bin in "$LINK" "$(command -v chrome-headless-shell 2>/dev/null || true)"; do
    if [ -n "$bin" ] && [ -x "$bin" ] && "$bin" --version >/dev/null 2>&1; then
      echo "已安装: $bin ($("$bin" --version 2>&1 | head -1))"
      return 0
    fi
  done
  return 1
}

missing_libs() {
  ldd "$1" 2>/dev/null | grep 'not found' || true
}

install_browser() {
  mkdir -p "$BIN_DIR" "$CACHE_DIR"
  local work
  work="$CACHE_DIR/unpack"
  mkdir -p "$work"

  if [ ! -d "$TARGET" ]; then
    if [ ! -s "$ZIP" ]; then
      echo "下载: $URL"
      curl -fL --retry 2 -o "$ZIP.part" "$URL" || fail "下载失败" "检查网络，或用 DRAWIO_CHROME_URL 指定可访问的地址"
      mv "$ZIP.part" "$ZIP"
    fi
    unzip -q -o "$ZIP" -d "$work/unpacked" || fail "解压失败" "删除缓存 $ZIP 后重跑以重新下载"
    [ -x "$work/unpacked/chrome-headless-shell-linux64/chrome-headless-shell" ] \
      || fail "压缩包里没有 chrome-headless-shell" "确认下载地址指向 chrome-headless-shell-linux64.zip"
    local libs
    libs="$(missing_libs "$work/unpacked/chrome-headless-shell-linux64/chrome-headless-shell")"
    [ -z "$libs" ] || fail "缺少系统库:
$libs" "用系统包管理器安装上面列出的库后重跑"
    mv "$work/unpacked/chrome-headless-shell-linux64" "$TARGET"
  fi
  ln -sfn "$TARGET/chrome-headless-shell" "$LINK"
  "$LINK" --version >/dev/null 2>&1 || fail "安装后无法运行 $LINK" "运行 $LINK --version 查看错误"
  echo "已安装: $LINK -> $TARGET ($("$LINK" --version 2>&1 | head -1))"
}

main() {
  already_installed && return 0
  check_platform
  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] 将从 $URL 安装到 $TARGET，并链接为 $LINK"
    return 0
  fi
  install_browser
}

main
