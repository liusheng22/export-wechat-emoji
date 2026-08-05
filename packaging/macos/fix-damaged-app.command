#!/bin/bash

APP_PATH="/Applications/导出微信表情包.app"
HELP_URL="https://juejin.cn/post/7597271614942134291"

clear
echo "导出微信表情包 — 修复“应用已损坏”"
echo ""
echo "这个脚本会移除以下应用的 macOS 下载隔离标记："
echo "  ${APP_PATH}"
echo ""
echo "即将执行："
echo "  sudo xattr -dr com.apple.quarantine \"${APP_PATH}\""
echo ""
echo "详细说明：${HELP_URL}"
echo ""

if [[ ! -d "${APP_PATH}" ]]; then
  echo "未找到应用。请先把“导出微信表情包”拖入 Applications 文件夹，再重新运行本脚本。"
  echo ""
  read -r -p "按回车键关闭窗口…"
  exit 1
fi

echo "请输入当前 macOS 账号的登录密码（输入时不会显示字符）："
if sudo /usr/bin/xattr -dr com.apple.quarantine "${APP_PATH}"; then
  echo ""
  echo "修复完成，正在打开应用…"
  /usr/bin/open "${APP_PATH}"
  echo ""
  echo "详细说明：${HELP_URL}"
  read -r -p "按回车键关闭窗口…"
  exit 0
fi

echo ""
echo "修复失败。请确认当前账号具备管理员权限，并参考："
echo "${HELP_URL}"
read -r -p "按回车键关闭窗口…"
exit 1
