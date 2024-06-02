# Tauri + React + Typescript
> 解决飞书、企微、钉钉聊天(mo yu)的时候找不到的痛点，一键导出微信所有表情包

>仅 `MacOS` 支持，就是把微信的表情包全部导出来，然后可以通过飞书、企微、钉钉的聊天界面手动批量倒入表情包

## 微信表情包导出

### 开发
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

- Q: 使用时提示两三次目录授权，是否可信？
  - A: 都是正常范围的权限授权，点击允许就行，不会有额外权限获取