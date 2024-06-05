# macOS 微信表情包导出

> 解决飞书、企微、钉钉聊天(mo yu)的时候找不到表情包回复的痛点

> 一键导出微信所有表情包，就可通过飞书、企微、钉钉的聊天界面手动批量倒入表情包了

> 仅 `MacOS` 支持，Windows暂时没有设备去开发、测试

## 开发调试

### 开发环境 dev
```bash
pnpm tauri dev
```

### 生产环境 debug
```bash
pnpm tauri build --debug
```

### 生产环境 release
```bash
pnpm tauri-build
```

### 问题
- Q: 安装后提示 `xxx已损坏，无法打开。你应该将它移到废纸篓。`
  - A: 这里是详细操作过程 [点击查看](https://zhuanlan.zhihu.com/p/135948430)

- Q: 使用过程中提示了2～3次文件授权，是否可信？
  - A: 是正常范围的文件权限授权，点击允许就行，不会有额外文件的权限获取

- Q: 为什么在预览表情包时，有些图片无法显示？
  - A: 这个是微信的图片 URL 限制，没有好的方案

- Q: 为什么导出后是的表情包图片每 50 张进行分类？
  - A: 因为例如飞书添加表情包，单次上限是选中 50 张图，这样便于添加

[![release](https://github.com/liusheng22/export-wechat-emoji/actions/workflows/release.yml/badge.svg)](https://github.com/liusheng22/export-wechat-emoji/actions/workflows/release.yml)

