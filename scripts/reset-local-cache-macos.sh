#!/usr/bin/env bash

set -euo pipefail

DRY_RUN=0

usage() {
  cat <<'EOF'
用法：
  bash scripts/reset-local-cache-macos.sh
  bash scripts/reset-local-cache-macos.sh --dry-run

说明：
  - 删除本项目 / App / CLI 在本机生成的本地缓存与状态文件
  - 用于模拟“首次运行、无 dbkey、无 URL 缓存”的场景
  - 不会删除微信原始数据库，不会删除 xwechat_files，不会删除你的微信聊天数据

会清理这些目录 / 文件：
  - ~/Library/Application Support/me.lius.wxemoticon
  - ~/Library/Caches/me.lius.wxemoticon
  - ~/Library/WebKit/me.lius.wxemoticon
  - ~/Library/Preferences/me.lius.wxemoticon.plist
  - ~/Library/Saved Application State/me.lius.wxemoticon.savedState
  - ~/Library/Containers/com.tencent.xinWeChat/Data/Documents/export-wechat-emoji
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ -n "${1:-}" ]]; then
  echo "不支持的参数：$1" >&2
  echo >&2
  usage >&2
  exit 1
fi

APP_BUNDLE_ID="me.lius.wxemoticon"
APP_NAME="导出微信表情包"

if pgrep -af "${APP_BUNDLE_ID}|${APP_NAME}|wxemoticon" >/dev/null 2>&1; then
  echo "检测到 ${APP_NAME} 或 wxemoticon 可能仍在运行。"
  echo "请先完全退出应用后再执行本脚本。"
  exit 1
fi

TARGETS=(
  "$HOME/Library/Application Support/${APP_BUNDLE_ID}"
  "$HOME/Library/Caches/${APP_BUNDLE_ID}"
  "$HOME/Library/WebKit/${APP_BUNDLE_ID}"
  "$HOME/Library/Preferences/${APP_BUNDLE_ID}.plist"
  "$HOME/Library/Saved Application State/${APP_BUNDLE_ID}.savedState"
  "$HOME/Library/Containers/com.tencent.xinWeChat/Data/Documents/export-wechat-emoji"
)

echo "准备清理以下本地缓存："
for path in "${TARGETS[@]}"; do
  echo "  - ${path}"
done
echo

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[dry-run] 仅预览，不执行删除。"
  exit 0
fi

REMOVED=0
SKIPPED=0

for path in "${TARGETS[@]}"; do
  if [[ -e "${path}" ]]; then
    rm -rf "${path}"
    echo "已删除：${path}"
    REMOVED=$((REMOVED + 1))
  else
    echo "不存在，跳过：${path}"
    SKIPPED=$((SKIPPED + 1))
  fi
done

echo
echo "清理完成：删除 ${REMOVED} 项，跳过 ${SKIPPED} 项。"
echo "现在你可以重新打开刚下载的 App，验证“无 dbkey / 无缓存”场景。"
