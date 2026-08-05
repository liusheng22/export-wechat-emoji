#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/wechat_key_dumper.dylib"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "error: xcrun not found; install Xcode Command Line Tools first" >&2
  exit 1
fi

if ! MACOS_SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null)"; then
  echo "error: macOS SDK not found; install Xcode Command Line Tools first" >&2
  exit 1
fi

xcrun --sdk macosx clang \
  -isysroot "$MACOS_SDK" \
  -dynamiclib \
  -O2 \
  -fvisibility=hidden \
  -o "$OUT" \
  "$DIR/key_dumper.c" \
  -arch arm64 -arch x86_64 \
  -mmacosx-version-min=11.0

echo "built: $OUT"
