# macOS 微信表情包导出

> 解决飞书、企微、钉钉聊天(mo yu)的时候找不到表情包回复的痛点

> 一键导出微信所有表情包，就可通过飞书、企微、钉钉的聊天界面手动批量倒入表情包了

> 仅 `MacOS` 支持，Windows暂时没有设备去开发、测试

## 开发调试

### 环境依赖

- Node.js `>= 20`（见 `package.json` 的 `engines`）
- pnpm（建议用 `package.json` 的 `packageManager` 对齐版本）
- Rust stable + Tauri v1 构建依赖（macOS 通常需要 Xcode Command Line Tools）

### 安装依赖

```bash
pnpm install
```

### 运行桌面客户端（Tauri / 开发）

```bash
pnpm tauri dev
```

说明：

- `src-tauri/tauri.conf.json` 里配置了 `beforeDevCommand: pnpm dev`，所以 `pnpm dev` 是给 `tauri dev` 启动前置用的（单独跑也可用于前端调试页面）。

### 构建（Tauri）

Debug 构建：

```bash
pnpm tauri build --debug
```

Release 构建：

```bash
pnpm tauri-build
```

### 常用脚本速查

- `pnpm dev`：启动 Vite（给 `tauri dev` 做前置，也可单独跑）
- `pnpm build`：构建前端产物到 `dist/`
- `pnpm tauri dev`：运行 Tauri 桌面端（开发）
- `pnpm tauri build --debug`：构建 debug 包
- `pnpm tauri-build`：构建 release 包
- `pnpm typecheck`：TypeScript 类型检查（不输出文件）

### 问题
- Q: 安装后提示 `xxx已损坏，无法打开。你应该将它移到废纸篓。`
  - A: 这里是详细操作过程 [点击查看](https://zhuanlan.zhihu.com/p/135948430)

- Q: 使用过程中提示了2～3次文件授权，是否可信？
  - A: 是正常范围的文件权限授权，点击允许就行，不会有额外文件的权限获取

- Q: 为什么在预览表情包时，有些图片无法显示？
  - A: 部分资源不是 gif（可能是 jpg/png/webp），已做自动后缀 fallback；仍可能存在 URL 过期/风控导致的加载失败

- Q: 为什么导出后是的表情包图片每 50 张进行分类？
  - A: 因为例如飞书添加表情包，单次上限是选中 50 张图，这样便于添加

[![release](https://github.com/liusheng22/export-wechat-emoji/actions/workflows/release.yml/badge.svg)](https://github.com/liusheng22/export-wechat-emoji/actions/workflows/release.yml)
