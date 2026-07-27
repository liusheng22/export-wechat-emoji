# 导出微信表情包（macOS / Linux）

[![release](https://github.com/liusheng22/export-wechat-emoji/actions/workflows/release.yml/badge.svg)](https://github.com/liusheng22/export-wechat-emoji/actions/workflows/release.yml)

> 一键导出微信收藏表情包，方便批量导入飞书、企微、钉钉等平台。

> GUI 目前支持 macOS；`wxemoticon` 命令行工具支持 macOS 和 Linux。

## 功能概览

- App 一键获取并预览微信收藏表情
- 默认无需手动输入 db key（App 自动处理）
- 导出支持每 50 张分组或不分组
- 支持断点续跑（跳过已存在文件）与导出统计
- 提供可选 CLI：`wxemoticon`

## Linux CLI（Ubuntu/Debian x86_64）

已适配腾讯官方 Linux 微信 4.x（默认程序 `/opt/wechat/wechat`）。Linux 版当前仅提供命令行工具，不包含 GUI 或 `.deb` 安装包。

### 从源码构建

需要 Rust stable、`build-essential` 和 `pkg-config`：

```bash
sudo apt update
sudo apt install -y build-essential pkg-config
git clone https://github.com/liusheng22/export-wechat-emoji.git
cd export-wechat-emoji
cargo build --manifest-path cli/Cargo.toml --release
install -Dm755 cli/target/release/wxemoticon ~/.local/bin/wxemoticon
```

确保 `~/.local/bin` 已加入 `PATH`，然后执行：

```bash
# 查看账号（优先读取 XDG 文档目录，并兼容 ~/Documents 和 ~/文档）
wxemoticon urls --list-accounts

# 直接导出；需要重新抓 key 时会提示先退出微信
wxemoticon export
```

非默认安装或数据位置可显式指定：

```bash
wxemoticon \
  --wechat-bin /opt/wechat/wechat \
  --wechat-data-dir "$HOME/文档/xwechat_files" \
  export
```

Linux 自动抓 key 会启动一次官方微信，并仅读取本次启动的微信进程内存；找到与目标 `emoticon.db` 首页 HMAC 匹配的 key 后立即停止该进程。若微信本身无法启动，或系统策略禁止读取 `/proc/<pid>/mem`，仍可先提供已有 key 生成 URL，再从 URL 文件导出：

```bash
wxemoticon urls --key-file /path/to/emoticon_dbkey.txt --out /tmp/emoticon_urls.txt
wxemoticon export --urls-file /tmp/emoticon_urls.txt
```

缓存与日志默认写入 `~/.local/share/wxemoticon`，图片默认导出到 `~/Downloads`。

## 下载与安装（GUI）

1. 打开 GitHub Releases：<https://github.com/liusheng22/export-wechat-emoji/releases>
2. 按芯片类型下载对应 App 安装包（推荐 `.dmg`）：
   - Apple Silicon（M1/M2/M3）：`wxemoticon-app-macos-arm64.dmg`
   - Intel Mac：`wxemoticon-app-macos-x64.dmg`
3. 按常规方式安装并打开 `导出微信表情包.app`

芯片类型查看方式：
- macOS 左上角苹果图标 → “关于本机” → 查看“芯片”

如果出现“应用已损坏，无法打开”，可参考：
- <https://juejin.cn/post/7597271614942134291>

## App 一键导出（推荐）

1. 打开 App
2. 点击“一键从微信获取并预览”
3. 预览确认后点击“导出”
4. 导出完成后自动打开目录

说明：
- 当本机已有可用 key 时，通常不需要关闭微信。
- 当需要重新抓取 key 时，App 会提示你先完全退出微信再继续。
- 导出目录默认在 `~/Downloads/微信表情包_导出_时间戳`。
- 导出信息会放在 `导出信息/` 子目录（如 `emoticon_urls.txt`、`使用说明.txt`）。

## CLI（命令行方式）

如果你更喜欢命令行，可使用 `wxemoticon`（macOS / Linux）。

安装方式 A：安装脚本（默认，零配置）

```bash
curl -fsSL https://raw.githubusercontent.com/liusheng22/export-wechat-emoji/main/scripts/install-wxemoticon.sh | bash
```

升级到指定版本（例如 `v0.1.4`）：

```bash
curl -fsSL https://raw.githubusercontent.com/liusheng22/export-wechat-emoji/main/scripts/install-wxemoticon.sh | env WXEMOTICON_VERSION=v0.1.4 bash
```

安装方式 B：Homebrew（推荐长期维护）

```bash
brew tap liusheng22/wxemoticon
brew install wxemoticon
```

Homebrew 升级：

```bash
brew update
brew upgrade wxemoticon
```

安装后验证：

```bash
wxemoticon --version
wxemoticon --help
```

如果提示找不到命令，可把 `~/.local/bin` 加入 PATH（zsh）：

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

CLI 内置升级命令（脚本安装用户可用）：

```bash
# 升级到最新
wxemoticon update

# 升级到指定版本
wxemoticon update --version v0.1.4
```

说明：
- 如果你是通过 Homebrew 安装，请优先使用 `brew upgrade wxemoticon`。
- `wxemoticon update` 默认会提示你使用 brew 升级，避免覆盖 brew 管理文件。

### CLI 能力总览

- `wxemoticon key`：获取/刷新 db key（64 位 hex）
- `wxemoticon urls`：导出 URL 列表（会自动抓 key 并离线解密查询）
- `wxemoticon export`：直接下载导出图片

### 常用流程示例

```bash
# 1) 查看可用账号
wxemoticon urls --list-accounts

# 2) 获取 db key（不传 --wxid 时，单账号自动选中；多账号交互选择）
wxemoticon key

# 3) 导出 URL 列表（默认输出“数量 + 文件路径”）
wxemoticon urls

# 4) 一键导出图片（会交互选择分组策略）
wxemoticon export
```

### 指定 `wxid` 的完整示例

```bash
# 1) 先列出账号，拿到目标 wxid（例如 wxid_xxx）
wxemoticon urls --list-accounts

# 2) 指定 wxid 抓取/刷新 db key
wxemoticon key --wxid "wxid_xxx"

# 3) 指定 wxid 导出 URL 列表（可选）
wxemoticon urls --wxid "wxid_xxx"

# 4) 指定 wxid 直接导出表情包图片
wxemoticon export --wxid "wxid_xxx"
```

如果你想做脚本化（不走交互），可以加 `--no-interactive` 与 `--json`：

```bash
wxemoticon key --wxid "wxid_xxx" --no-interactive --json
wxemoticon export --wxid "wxid_xxx" --no-interactive --flat --skip-existing --json
```

如果你的微信不是默认路径（例如官方备份）：

```bash
WECHAT_APP="/Applications/WeChat.bak.app"

# 1) 抓取/刷新 db key（会输出 key 文件路径）
wxemoticon --wechat-app "$WECHAT_APP" key

# 2) 解析并导出 URL 列表（会输出 URL 文件路径）
wxemoticon --wechat-app "$WECHAT_APP" urls

# 3) 直接下载导出图片（推荐日常使用这个命令）
wxemoticon --wechat-app "$WECHAT_APP" export
```

说明：
- `key` 适合排障或你需要单独确认 db key 是否可用。
- `urls` 适合你只想先拿链接文件，稍后再处理下载。
- `export` 适合最终导出图片，内部会自动走 key + urls 流程。

### 关键参数说明

- 全局参数：
  - `--wechat-app`：指定微信路径，默认 `/Applications/WeChat.app`
  - `--no-interactive`：关闭交互（适合脚本化）
- `key` 常用参数：
  - `--force`：忽略已有 key，强制重抓
  - `--timeout`：抓 key 超时时间（秒）
  - `--open`：在 Finder 定位 key 文件
  - `--json`：以 JSON 输出结果
- `urls` 常用参数：
  - `--list-accounts`：仅列账号并退出
  - `--print`：打印全部 URL 到终端
  - `--out`：自定义 URL 输出文件
  - `--force-key`：忽略已有 key 并重抓
  - `--open`：在 Finder 定位 URL 文件
  - `--json`：以 JSON 输出结果
- `export` 常用参数：
  - `--flat`：不分组导出
  - `--group-size`：自定义每组数量（例如 `50`）
  - `--skip-existing`：跳过已存在文件（断点续跑）
  - `--out-dir`：指定导出目录
  - `--open`：导出后自动打开目录
  - `--json`：以 JSON 输出统计结果

## 常见问题

- Q: 使用时会弹出文件权限授权，是否正常？
  - A: 正常，按系统提示授权即可。

- Q: 预览里有些图片加载失败？
  - A: 可能是 URL 过期、风控或资源暂不可达；导出时也可能出现少量失败。

- Q: 为什么默认每 50 张分组？
  - A: 飞书/企微/钉钉等平台常见单次添加上限约 50 张，分组更方便导入。

- Q: 新版微信（4.x）找不到 `fav.archive`？
  - A: 属于正常变化。微信 4.x 主要使用 `xwechat_files` 下的数据库，本项目已适配新版路径。

## 开发者说明（仅开发）

### 环境依赖

- Node.js `>= 20`
- pnpm
- Rust stable
- Tauri v1 构建依赖（macOS 通常需要 Xcode Command Line Tools）

### 开发者快速开始

1. 安装依赖

```bash
pnpm install
```

2. 启动桌面端开发模式（前端 + Tauri）

```bash
pnpm tauri dev
```

3. 代码检查（提交前建议执行）

```bash
pnpm -s typecheck
cargo check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path cli/Cargo.toml
```

### 构建命令（开发者）

```bash
# 仅构建前端静态资源（dist）
pnpm build

# 构建 App（debug）
pnpm tauri build --debug

# 构建 App（release）
pnpm tauri-build
```

### CLI 开发命令（wxemoticon）

```bash
# 查看 CLI 帮助
cargo run --manifest-path cli/Cargo.toml -- --help

# 构建 CLI（release）
cargo build --manifest-path cli/Cargo.toml --release
```

### Homebrew 发布（维护者）

- `tap`：一个 Homebrew 公式仓库（通常是 GitHub 仓库），用于存放公式文件。
- `formula`：一个 Ruby 文件（例如 `Formula/wxemoticon.rb`），定义下载地址、校验值和安装方式。

本项目已经支持在 release workflow 中自动更新 tap 里的公式文件（可选）：

1. 创建 GitHub 仓库（示例）：`liusheng22/homebrew-wxemoticon`
2. 在该仓库创建 `Formula/` 目录
3. 在本仓库 Secrets 中配置：
   - `HOMEBREW_TAP_REPO`：例如 `liusheng22/homebrew-wxemoticon`
   - `HOMEBREW_TAP_TOKEN`：对 tap 仓库有写权限的 token

配置完成后，每次发 tag 触发 release 时，会自动生成并提交 `Formula/wxemoticon.rb` 到 tap 仓库。
