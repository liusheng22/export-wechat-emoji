#!/bin/bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <path-to-dmg>" >&2
  exit 2
fi

DMG_PATH="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX_SCRIPT="${SCRIPT_DIR}/fix-damaged-app.command"
FIX_SCRIPT_DMG_NAME='提示“已损坏”时双击修复.command'

if [[ ! -f "${DMG_PATH}" ]]; then
  echo "DMG not found: ${DMG_PATH}" >&2
  exit 1
fi

if [[ ! -f "${FIX_SCRIPT}" ]]; then
  echo "Repair helper not found: ${FIX_SCRIPT}" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
RW_DMG="${WORK_DIR}/writable.dmg"
FINAL_DMG="${WORK_DIR}/final.dmg"
MOUNT_POINT=""

cleanup() {
  if [[ -n "${MOUNT_POINT}" ]] && mount | grep -Fq " on ${MOUNT_POINT} "; then
    hdiutil detach "${MOUNT_POINT}" -quiet || true
  fi
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

hdiutil convert "${DMG_PATH}" -format UDRW -ov -o "${RW_DMG}" >/dev/null
MOUNT_POINT="$(
  hdiutil attach "${RW_DMG}" -readwrite -noverify -noautoopen -nobrowse \
    | sed -n 's|^.*\(/Volumes/.*\)$|\1|p' \
    | tail -n 1
)"

if [[ -z "${MOUNT_POINT}" ]]; then
  echo "Failed to mount writable DMG" >&2
  exit 1
fi

cp "${FIX_SCRIPT}" "${MOUNT_POINT}/${FIX_SCRIPT_DMG_NAME}"
chmod +x "${MOUNT_POINT}/${FIX_SCRIPT_DMG_NAME}"
if [[ -f "${MOUNT_POINT}/.VolumeIcon.icns" ]]; then
  rm "${MOUNT_POINT}/.VolumeIcon.icns"
  /usr/bin/SetFile -a c "${MOUNT_POINT}"
fi

VOLUME_NAME="$(basename "${MOUNT_POINT}")"
sleep 2
/usr/bin/osascript - "${VOLUME_NAME}" <<'APPLESCRIPT'
on run argv
  set volumeName to item 1 of argv

  tell application "Finder"
    tell disk volumeName
      open

      tell container window
        set current view to icon view
        set toolbar visible to false
        set statusbar visible to false
        set the bounds to {10, 60, 770, 490}
      end tell

      set viewOptions to the icon view options of container window
      tell viewOptions
        set icon size to 96
        set text size to 14
        set arrangement to not arranged
        set background color to {65535, 65535, 65535}
      end tell

      set position of item "导出微信表情包.app" to {150, 190}
      set position of item "Applications" to {380, 190}
      set position of item "提示“已损坏”时双击修复.command" to {610, 190}
      set extension hidden of item "提示“已损坏”时双击修复.command" to true

      close
      open
      delay 1
    end tell

    set selection to {}
    delay 3
  end tell
end run
APPLESCRIPT

hdiutil detach "${MOUNT_POINT}" -quiet
MOUNT_POINT=""
hdiutil convert "${RW_DMG}" -format UDZO -imagekey zlib-level=9 -ov -o "${FINAL_DMG}" >/dev/null
mv "${FINAL_DMG}" "${DMG_PATH}"

echo "Added the repair helper and Finder layout to ${DMG_PATH}"
