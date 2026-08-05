#!/usr/bin/env bash
set -euo pipefail

WECHAT_APP="${1:-/Applications/WeChat.app}"
TARGET_WXID="${2:-}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DYLIB="$ROOT_DIR/tools/wechat-key-dumper/wechat_key_dumper.dylib"
BUILD_SH="$ROOT_DIR/tools/wechat-key-dumper/build.sh"
SRC_C="$ROOT_DIR/tools/wechat-key-dumper/key_dumper.c"

OUT_DIR="$HOME/Library/Containers/com.tencent.xinWeChat/Data/Documents/export-wechat-emoji"
OUT_FILE="$OUT_DIR/emoticon_dbkey.txt"
LOG_FILE="$OUT_DIR/emoticon_dbkey.log"

mkdir -p "$OUT_DIR"

if [[ ! -d "$WECHAT_APP" ]]; then
  echo "WeChat.app not found: $WECHAT_APP" >&2
  exit 1
fi

if [[ ! -f "$DYLIB" || "$SRC_C" -nt "$DYLIB" ]]; then
  bash "$BUILD_SH"
fi

# Prefer running the given WeChat.app directly if it's already ad-hoc signed (e.g. patched by WeChatTweak).
# Otherwise, copy + ad-hoc sign under ~/Library/Caches to keep /Applications untouched.
RUN_APP="$WECHAT_APP"
if ! /usr/bin/codesign -dvv "$WECHAT_APP" 2>&1 | /usr/bin/grep -q "Signature=adhoc"; then
  # Hardened Runtime / library validation can block DYLD_INSERT_LIBRARIES.
  CACHE_APP="$HOME/Library/Caches/export-wechat-emoji/WeChat.app"
  mkdir -p "$(dirname "$CACHE_APP")"

  src_ver="$(/usr/bin/defaults read "$WECHAT_APP/Contents/Info.plist" CFBundleVersion 2>/dev/null || true)"
  dst_ver="$(/usr/bin/defaults read "$CACHE_APP/Contents/Info.plist" CFBundleVersion 2>/dev/null || true)"

  if [[ "$src_ver" != "$dst_ver" ]]; then
    echo "Preparing WeChat copy (this may take a while)..." >&2
    rm -rf "$CACHE_APP"
    cp -R "$WECHAT_APP" "$CACHE_APP"
    /usr/bin/xattr -cr "$CACHE_APP" >/dev/null 2>&1 || true
  fi

  # Ensure the cached copy is ad-hoc signed so DYLD_INSERT_LIBRARIES works reliably.
  if ! /usr/bin/codesign -dvv "$CACHE_APP" 2>&1 | /usr/bin/grep -q "Signature=adhoc"; then
    echo "Re-signing cached WeChat copy for DYLD injection..." >&2
    /usr/bin/codesign --force --deep --sign - "$CACHE_APP" >/dev/null
  fi

  RUN_APP="$CACHE_APP"
fi

rm -f "$OUT_FILE"
rm -f "$LOG_FILE"

echo "Launching WeChat with injected key dumper..." >&2
echo "Key will be written to: $OUT_FILE" >&2
echo "If it doesn't appear quickly, login and open the emoji panel once." >&2

WECHAT_PID=""
cleanup() {
  if [[ -n "$WECHAT_PID" ]]; then
    kill -TERM "$WECHAT_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

EXPORT_WECHAT_EMOJI_KEY_OUT="$OUT_FILE" \
EXPORT_WECHAT_EMOJI_KEY_LOG="$LOG_FILE" \
EXPORT_WECHAT_EMOJI_TARGET_WXID="$TARGET_WXID" \
DYLD_INSERT_LIBRARIES="$DYLIB" \
"$RUN_APP/Contents/MacOS/WeChat" >/dev/null 2>&1 &
WECHAT_PID=$!

for _ in $(seq 1 300); do
  if [[ -s "$OUT_FILE" ]]; then
    key="$(head -n 1 "$OUT_FILE" | tr -d '\r\n')"
    echo "$key"
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for key. Check: $OUT_FILE" >&2
if [[ -f "$LOG_FILE" ]]; then
  echo "--- key dumper log (tail) ---" >&2
  tail -n 50 "$LOG_FILE" >&2 || true
fi
exit 1
