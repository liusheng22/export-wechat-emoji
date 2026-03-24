use aes::Aes256;
use anyhow::{anyhow, Context};
use cbc::cipher::block_padding::NoPadding;
use cbc::cipher::{BlockDecryptMut, KeyIvInit};
use clap::{Parser, Subcommand};
use dialoguer::theme::ColorfulTheme;
use dialoguer::{Confirm, Input, Select};
use hmac::{Hmac, Mac};
use indicatif::{ProgressBar, ProgressStyle};
use pbkdf2::pbkdf2_hmac_array;
use plist::Value;
use regex::Regex;
use reqwest::header::CONTENT_TYPE;
use reqwest::Client;
use rusqlite::Connection;
use serde::Serialize;
use sha2::Sha512;
use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};
use tempfile::NamedTempFile;
use tokio::time::Instant;
use url::Url;

// The key dumper dylib is built by build.rs and embedded here so the CLI stays a single executable.
#[cfg(target_os = "macos")]
static WECHAT_KEY_DUMPER_DYLIB: &[u8] = include_bytes!(env!("WXEMOTICON_KEY_DUMPER_DYLIB_PATH"));

#[derive(Parser, Debug)]
#[command(
    name = "wxemoticon",
    author,
    version,
    about = "macOS 微信表情包工具（无需 SIP）：抓取 db key / 导出 URL / 导出表情包图片"
)]
struct Cli {
    /// WeChat.app 路径（默认 /Applications/WeChat.app；也可传 /Applications/WeChat.bak.app）
    #[arg(long, global = true, default_value = "/Applications/WeChat.app")]
    wechat_app: String,

    /// 关闭交互提示（需要把必要参数都传全）
    #[arg(long, global = true)]
    no_interactive: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// 抓取新版微信（4.x）表情数据库的 db key（64 位 hex）
    Key(KeyArgs),

    /// 导出表情包 URL 列表（会自动抓 key 并离线解密查询）
    Urls(UrlsArgs),

    /// 一键导出表情包图片到目录（会自动生成 URL 列表并下载）
    Export(ExportArgs),
}

#[derive(Parser, Debug)]
struct KeyArgs {
    /// 选择账号（xwechat_files 里的 wxid_* 目录名）。不传则自动选择（只有 1 个账号时），或交互选择
    #[arg(long)]
    wxid: Option<String>,

    /// 输出 key 文件路径（默认写到微信容器 Documents/export-wechat-emoji）
    #[arg(long)]
    out: Option<String>,

    /// 输出日志文件路径
    #[arg(long)]
    log: Option<String>,

    /// 忽略已有 key 文件，强制重新抓取
    #[arg(long)]
    force: bool,

    /// 等待 key 的超时时间（秒）
    #[arg(long, default_value_t = 600)]
    timeout: u64,

    /// 在 Finder 中打开（定位）输出文件
    #[arg(long)]
    open: bool,

    /// 以 JSON 输出
    #[arg(long)]
    json: bool,
}

#[derive(Parser, Debug)]
struct UrlsArgs {
    /// 选择账号（xwechat_files 里的 wxid_* 目录名）。不传则交互选择
    #[arg(long)]
    wxid: Option<String>,

    /// 列出可用账号并退出
    #[arg(long)]
    list_accounts: bool,

    /// 输出 URL 文件路径
    #[arg(long)]
    out: Option<String>,

    /// 输出日志文件路径
    #[arg(long)]
    log: Option<String>,

    /// db key 文件路径
    #[arg(long)]
    key_file: Option<String>,

    /// 忽略已有 key 文件，强制重新抓取
    #[arg(long)]
    force_key: bool,

    /// 等待 key 的超时时间（秒）
    #[arg(long, default_value_t = 600)]
    timeout: u64,

    /// 打印 URL 列表到 stdout（一行一个）；默认仅输出“数量 + 文件路径”
    #[arg(long)]
    print: bool,

    /// 在 Finder 中打开（定位）输出文件
    #[arg(long)]
    open: bool,

    /// 以 JSON 输出
    #[arg(long)]
    json: bool,
}

#[derive(Parser, Debug)]
struct ExportArgs {
    /// 选择账号（xwechat_files 里的 wxid_* 目录名）。不传则交互选择
    #[arg(long)]
    wxid: Option<String>,

    /// 从已有 URL 文件导出（跳过抓 key/解密查询）
    #[arg(long, hide = true)]
    urls_file: Option<String>,

    /// 导出目录（默认 ~/Downloads/微信表情包_导出_YYYYMMDD_HHMMSS）
    #[arg(long)]
    out_dir: Option<String>,

    /// 每多少张分一个子目录（例如 50）；0 表示不分组
    #[arg(long)]
    group_size: Option<usize>,

    /// 等同于 --group-size 0（全部放在一个目录）
    #[arg(long)]
    flat: bool,

    /// 并发下载数
    #[arg(long, default_value_t = 6)]
    concurrency: usize,

    /// 跳过已存在的文件（断点续跑）
    #[arg(long, alias = "resume")]
    skip_existing: bool,

    /// 等待 key 的超时时间（秒）
    #[arg(long, default_value_t = 600)]
    timeout: u64,

    /// 单个图片下载超时（秒）
    #[arg(long, default_value_t = 30)]
    http_timeout: u64,

    /// 导出完成后打开导出目录
    #[arg(long)]
    open: bool,

    /// 以 JSON 输出
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Clone)]
struct Account {
    wxid: String,
    emoticon_db: PathBuf,
    emoticon_db_mtime: Option<SystemTime>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyResult {
    db_key: String,
    db_key_file: String,
    log_file: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UrlsResult {
    wxid: String,
    db_key: String,
    db_key_file: String,
    urls_file: String,
    log_file: String,
    count: usize,
    urls: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    wxid: Option<String>,
    out_dir: String,
    group_size: usize,
    total: usize,
    ok: usize,
    skipped: usize,
    failed: usize,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match &cli.command {
        Commands::Key(args) => cmd_key(&cli, args).await?,
        Commands::Urls(args) => cmd_urls(&cli, args).await?,
        Commands::Export(args) => cmd_export(&cli, args).await?,
    }
    Ok(())
}

fn term_stderr() -> dialoguer::console::Term {
    dialoguer::console::Term::stderr()
}

fn home_dir() -> anyhow::Result<PathBuf> {
    let home = std::env::var("HOME").map_err(|_| anyhow!("无法获取 HOME 环境变量"))?;
    Ok(PathBuf::from(home))
}

fn default_out_dir() -> anyhow::Result<PathBuf> {
    Ok(home_dir()?
        .join("Library/Containers/com.tencent.xinWeChat/Data/Documents/export-wechat-emoji"))
}

fn default_key_file() -> anyhow::Result<PathBuf> {
    Ok(default_out_dir()?.join("emoticon_dbkey.txt"))
}

#[allow(dead_code)]
fn default_key_log() -> anyhow::Result<PathBuf> {
    Ok(default_out_dir()?.join("emoticon_dbkey.log"))
}

fn default_urls_file() -> anyhow::Result<PathBuf> {
    Ok(default_out_dir()?.join("emoticon_urls.txt"))
}

#[allow(dead_code)]
fn default_urls_log() -> anyhow::Result<PathBuf> {
    Ok(default_out_dir()?.join("emoticon_urls.log"))
}

fn key_file_for_wxid(wxid: &str) -> anyhow::Result<PathBuf> {
    Ok(default_out_dir()?.join(format!("emoticon_dbkey_{wxid}.txt")))
}

fn key_log_for_wxid(wxid: &str) -> anyhow::Result<PathBuf> {
    Ok(default_out_dir()?.join(format!("emoticon_dbkey_{wxid}.log")))
}

fn urls_file_for_wxid(wxid: &str) -> anyhow::Result<PathBuf> {
    Ok(default_out_dir()?.join(format!("emoticon_urls_{wxid}.txt")))
}

fn urls_log_for_wxid(wxid: &str) -> anyhow::Result<PathBuf> {
    Ok(default_out_dir()?.join(format!("emoticon_urls_{wxid}.log")))
}

fn xwechat_files_dir() -> anyhow::Result<PathBuf> {
    Ok(home_dir()?.join("Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files"))
}

fn downloads_dir() -> anyhow::Result<PathBuf> {
    Ok(home_dir()?.join("Downloads"))
}

#[cfg(target_os = "macos")]
fn open_reveal(path: &Path) -> anyhow::Result<()> {
    let status = Command::new("/usr/bin/open")
        .arg("-R")
        .arg(path)
        .status()
        .context("执行 open 失败")?;
    if !status.success() {
        return Err(anyhow!("打开 Finder 失败"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_dir(path: &Path) -> anyhow::Result<()> {
    let status = Command::new("/usr/bin/open")
        .arg(path)
        .status()
        .context("执行 open 失败")?;
    if !status.success() {
        return Err(anyhow!("打开 Finder 失败"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn wechat_is_running(wechat_app: &Path) -> bool {
    // Don't use `ps | grep` / `pgrep -f` because they may match themselves and cause false positives.
    // Instead, scan full process argument lists and look for "<bundle>.app/Contents/" substrings.
    let mut bundle_names = HashSet::<String>::new();
    // Our cached runnable copy is always named "WeChat.app".
    bundle_names.insert("WeChat.app".to_string());
    if let Some(name) = wechat_app.file_name().and_then(|s| s.to_str()) {
        if name.ends_with(".app") {
            bundle_names.insert(name.to_string());
        }
    }
    let needles: Vec<String> = bundle_names
        .into_iter()
        .map(|n| format!("{n}/Contents/"))
        .collect();

    let out = Command::new("/bin/ps")
        .args(["-A", "-o", "args="])
        .output();
    let Ok(out) = out else { return false };
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if needles.iter().any(|n| line.contains(n)) {
            return true;
        }
    }
    false
}

fn prompt_enter_to_continue(no_interactive: bool, msg: &str) -> anyhow::Result<()> {
    eprintln!("{msg}");
    if no_interactive {
        return Ok(());
    }
    let input: String = Input::with_theme(&ColorfulTheme::default())
        .with_prompt("确认退出微信后，按回车继续；输入 q 退出")
        .default("".to_string())
        .interact_text_on(&term_stderr())
        .context("读取输入失败")?;
    if input.trim().eq_ignore_ascii_case("q") {
        return Err(anyhow!("已取消"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn wait_for_wechat_exit(wechat_app: &Path, no_interactive: bool) -> anyhow::Result<()> {
    // We only need WeChat to be fully quit when dumping/re-dumping key.
    if !wechat_is_running(wechat_app) {
        return Ok(());
    }

    if no_interactive {
        return Err(anyhow!("检测到微信仍在运行：必须先完全退出微信才能继续抓取 key"));
    }

    loop {
        prompt_enter_to_continue(
            no_interactive,
            "检测到微信仍在运行：必须先完全退出微信才能继续抓取 key。\n请先退出微信，然后按回车重新检查。",
        )?;
        if !wechat_is_running(wechat_app) {
            return Ok(());
        }
        eprintln!("仍检测到微信相关进程未退出，请再次确认已完全退出微信。");
    }
}

#[cfg(not(target_os = "macos"))]
fn wait_for_wechat_exit(_wechat_app: &Path, _no_interactive: bool) -> anyhow::Result<()> {
    Ok(())
}

fn normalize_hex_key(input: &str) -> Option<String> {
    let k = input
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X")
        .trim();
    let k = k.to_ascii_lowercase();
    if k.len() != 64 || !k.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(k)
}

fn read_first_line(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    content.lines().next().map(|s| s.trim().to_string())
}

fn seed_key_file_from_legacy(dst: &Path) {
    if dst.exists() {
        return;
    }
    let Ok(legacy) = default_key_file() else {
        return;
    };
    if legacy == dst || !legacy.exists() {
        return;
    }
    let Some(line) = read_first_line(&legacy) else {
        return;
    };
    let Some(k) = normalize_hex_key(&line) else {
        return;
    };
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let _ = std::fs::write(dst, format!("{k}\n"));
}

fn append_log(path: &Path, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

fn find_accounts() -> anyhow::Result<Vec<Account>> {
    let base = xwechat_files_dir()?;
    if !base.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for ent in std::fs::read_dir(&base).context("读取 xwechat_files 失败")? {
        let ent = ent?;
        let name = ent.file_name().to_string_lossy().to_string();
        
        // 过滤掉微信内部已知的非账号共享目录
        let ignore_dirs = ["all_users", "Backup", "WMPF", "AppletCaches", "Update"];
        if ignore_dirs.contains(&name.as_str()) || name.starts_with('.') {
            continue;
        }

        let db = ent.path().join("db_storage/emoticon/emoticon.db");
        if db.exists() {
            let mtime = std::fs::metadata(&db).ok().and_then(|m| m.modified().ok());
            out.push(Account {
                wxid: name,
                emoticon_db: db,
                emoticon_db_mtime: mtime,
            });
        }
    }
    out.sort_by(|a, b| a.wxid.cmp(&b.wxid));
    Ok(out)
}

fn format_mtime(mtime: Option<SystemTime>) -> String {
    let Some(st) = mtime else {
        return "未知".to_string();
    };
    let Ok(dur) = st.duration_since(SystemTime::UNIX_EPOCH) else {
        return "未知".to_string();
    };
    let nanos: i128 = dur.as_nanos() as i128;
    let Ok(mut dt) = time::OffsetDateTime::from_unix_timestamp_nanos(nanos) else {
        return "未知".to_string();
    };
    if let Ok(local) = time::UtcOffset::current_local_offset() {
        dt = dt.to_offset(local);
    }
    let fmt = time::macros::format_description!("[year]-[month]-[day] [hour]:[minute]");
    dt.format(&fmt).unwrap_or_else(|_| "未知".to_string())
}

fn select_account(accounts: &[Account], no_interactive: bool) -> anyhow::Result<Account> {
    if accounts.is_empty() {
        return Err(anyhow!(
            "未找到任何账号：请确认已登录新版微信（4.x），且目录存在：{}",
            xwechat_files_dir()?.display()
        ));
    }

    if accounts.len() == 1 {
        eprintln!(
            "检测到 1 个账号：{}（自动选择，emoticon.db 更新：{}）",
            accounts[0].wxid,
            format_mtime(accounts[0].emoticon_db_mtime)
        );
        return Ok(accounts[0].clone());
    }

    if no_interactive {
        return Err(anyhow!(
            "已关闭交互：请用 --wxid 指定账号（可先运行 `wxemoticon urls --list-accounts` 查看）"
        ));
    }

    eprintln!("检测到 {} 个账号，请选择：", accounts.len());
    for (i, a) in accounts.iter().enumerate() {
        eprintln!(
            "  {}) {}（emoticon.db 更新：{}）",
            i + 1,
            a.wxid,
            format_mtime(a.emoticon_db_mtime)
        );
    }

    let items: Vec<&str> = accounts.iter().map(|a| a.wxid.as_str()).collect();
    let idx = Select::with_theme(&ColorfulTheme::default())
        .with_prompt("请输入序号")
        .items(&items)
        .default(0)
        .interact_on(&term_stderr())
        .context("读取选择失败")?;
    Ok(accounts[idx].clone())
}

#[cfg(not(target_os = "macos"))]
fn ensure_macos() -> anyhow::Result<()> {
    Err(anyhow!("wxemoticon 目前仅支持 macOS"))
}

#[cfg(target_os = "macos")]
fn ensure_macos() -> anyhow::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
struct TempDylib {
    file: NamedTempFile,
}

#[cfg(target_os = "macos")]
impl TempDylib {
    fn new() -> anyhow::Result<Self> {
        let mut file = tempfile::Builder::new()
            .prefix("wxemoticon_key_dumper_")
            .suffix(".dylib")
            .tempfile()
            .context("创建临时 dylib 文件失败")?;
        file.write_all(WECHAT_KEY_DUMPER_DYLIB)
            .context("写入临时 dylib 失败")?;
        file.flush().ok();
        Ok(Self { file })
    }

    fn path(&self) -> &Path {
        self.file.path()
    }
}

#[cfg(target_os = "macos")]
fn codesign_is_adhoc(app_path: &Path) -> bool {
    let out = Command::new("/usr/bin/codesign")
        .arg("-dvv")
        .arg(app_path)
        .output();
    let Ok(out) = out else { return false };
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    text.contains("Signature=adhoc")
}

#[cfg(target_os = "macos")]
fn read_bundle_version(app_path: &Path) -> Option<String> {
    let p = app_path.join("Contents/Info.plist");
    let v = Value::from_file(p).ok()?;
    let dict = v.as_dictionary()?;
    dict.get("CFBundleVersion")?
        .as_string()
        .map(|s| s.to_string())
}

#[cfg(target_os = "macos")]
fn ensure_wechat_runnable_copy(src_app: &Path) -> anyhow::Result<PathBuf> {
    if codesign_is_adhoc(src_app) {
        return Ok(src_app.to_path_buf());
    }

    let cache_app = home_dir()?.join("Library/Caches/export-wechat-emoji/WeChat.app");
    if let Some(parent) = cache_app.parent() {
        std::fs::create_dir_all(parent).context("创建缓存目录失败")?;
    }

    let src_ver = read_bundle_version(src_app);
    let dst_ver = read_bundle_version(&cache_app);
    if src_ver != dst_ver {
        eprintln!("准备 WeChat 副本（可能需要一点时间）...");
        let _ = std::fs::remove_dir_all(&cache_app);
        let status = Command::new("/bin/cp")
            .arg("-R")
            .arg(src_app)
            .arg(&cache_app)
            .status()
            .context("复制 WeChat.app 失败")?;
        if !status.success() {
            return Err(anyhow!("复制 WeChat.app 失败"));
        }
        let _ = Command::new("/usr/bin/xattr")
            .arg("-cr")
            .arg(&cache_app)
            .status();
    }

    if !codesign_is_adhoc(&cache_app) {
        eprintln!("对 WeChat 副本进行 ad-hoc 重签名（用于 DYLD 注入）...");
        let status = Command::new("/usr/bin/codesign")
            .args(["--force", "--deep", "--sign", "-"])
            .arg(&cache_app)
            .status()
            .context("codesign 失败")?;
        if !status.success() {
            return Err(anyhow!("重签名失败（codesign exit != 0）"));
        }
    }

    Ok(cache_app)
}

#[cfg(target_os = "macos")]
fn terminate_child(child: &mut std::process::Child) {
    let _ = Command::new("/bin/kill")
        .arg("-TERM")
        .arg(child.id().to_string())
        .status();
    for _ in 0..5 {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(target_os = "macos")]
fn dump_db_key(
    wechat_app: &Path,
    key_file: &Path,
    log_file: &Path,
    no_interactive: bool,
    timeout: Duration,
) -> anyhow::Result<String> {
    if !wechat_app.exists() {
        return Err(anyhow!("WeChat.app 不存在：{}", wechat_app.display()));
    }

    wait_for_wechat_exit(wechat_app, no_interactive)?;

    std::fs::create_dir_all(key_file.parent().ok_or_else(|| anyhow!("无效输出路径"))?).ok();

    let dylib = TempDylib::new()?;
    let run_app = ensure_wechat_runnable_copy(wechat_app)?;

    let _ = std::fs::remove_file(key_file);
    let _ = std::fs::remove_file(log_file);

    eprintln!("即将启动微信副本来抓取 db key...");
    eprintln!("如果长时间没反应：请在弹出的微信里登录，并打开一次表情面板。");
    eprintln!("key 输出文件: {}", key_file.display());

    let mut child = Command::new(run_app.join("Contents/MacOS/WeChat"))
        .env("EXPORT_WECHAT_EMOJI_KEY_OUT", key_file)
        .env("EXPORT_WECHAT_EMOJI_KEY_LOG", log_file)
        .env("DYLD_INSERT_LIBRARIES", dylib.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("启动 WeChat 失败")?;

    let start = Instant::now();
    loop {
        if let Some(line) = read_first_line(key_file) {
            if let Some(k) = normalize_hex_key(&line) {
                terminate_child(&mut child);
                return Ok(k);
            }
        }

        if start.elapsed() > timeout {
            terminate_child(&mut child);
            return Err(anyhow!(
                "等待 key 超时（{} 秒）：{}",
                timeout.as_secs(),
                key_file.display()
            ));
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn get_or_dump_key(
    wechat_app: &Path,
    key_file: &Path,
    log_file: &Path,
    no_interactive: bool,
    force: bool,
    timeout: Duration,
) -> anyhow::Result<String> {
    if !force && key_file.exists() {
        if let Some(line) = read_first_line(key_file) {
            if let Some(k) = normalize_hex_key(&line) {
                return Ok(k);
            }
        }
    }

    ensure_macos()?;
    #[cfg(target_os = "macos")]
    {
        dump_db_key(wechat_app, key_file, log_file, no_interactive, timeout)
    }
    #[cfg(not(target_os = "macos"))]
    unreachable!()
}

#[derive(Debug)]
enum DecryptError {
    Io(std::io::Error),
    Invalid(String),
    HmacMismatch,
    Crypto(String),
}

impl From<std::io::Error> for DecryptError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl std::fmt::Display for DecryptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "io error: {e}"),
            Self::Invalid(e) => write!(f, "{e}"),
            Self::HmacMismatch => write!(f, "db key mismatch (HMAC verification failed)"),
            Self::Crypto(e) => write!(f, "{e}"),
        }
    }
}

fn decrypt_db_file_v4_with_key(
    path: &Path,
    key_bytes: &[u8],
    treat_as_passphrase: bool,
) -> Result<Vec<u8>, DecryptError> {
    const IV_SIZE: usize = 16;
    const HMAC_SHA512_SIZE: usize = 64;
    const KEY_SIZE: usize = 32;
    const AES_BLOCK_SIZE: usize = 16;
    const ROUND_COUNT: u32 = 256_000;
    const PAGE_SIZE: usize = 4096;
    const SALT_SIZE: usize = 16;
    const SQLITE_HEADER: &[u8] = b"SQLite format 3";

    let mut buf = std::fs::read(path)?;
    if buf.starts_with(SQLITE_HEADER) {
        return Ok(buf);
    }
    if buf.len() < PAGE_SIZE || buf.len() % PAGE_SIZE != 0 {
        return Err(DecryptError::Invalid(
            "invalid encrypted db size".to_string(),
        ));
    }

    let salt = buf[..SALT_SIZE].to_vec();
    let mac_salt: Vec<u8> = salt.iter().map(|b| b ^ 0x3a).collect();

    if key_bytes.len() != KEY_SIZE {
        return Err(DecryptError::Invalid("db key must be 32 bytes".to_string()));
    }

    let key = if treat_as_passphrase {
        pbkdf2_hmac_array::<Sha512, KEY_SIZE>(key_bytes, &salt, ROUND_COUNT)
    } else {
        let mut k = [0u8; KEY_SIZE];
        k.copy_from_slice(key_bytes);
        k
    };
    let mac_key = pbkdf2_hmac_array::<Sha512, KEY_SIZE>(&key, &mac_salt, 2);

    // SQLCipher reserved bytes per page are IV + HMAC, aligned to AES block size.
    let mut reserve = IV_SIZE + HMAC_SHA512_SIZE;
    if reserve % AES_BLOCK_SIZE != 0 {
        reserve = ((reserve / AES_BLOCK_SIZE) + 1) * AES_BLOCK_SIZE;
    }

    let total_pages = buf.len() / PAGE_SIZE;
    let mut decrypted = Vec::<u8>::with_capacity(buf.len());

    // Page 1 starts with the 16-byte SQLite header.
    decrypted.extend_from_slice(SQLITE_HEADER);
    decrypted.push(0x00);

    type HmacSha512 = Hmac<Sha512>;
    type Aes256CbcDec = cbc::Decryptor<Aes256>;

    for cur_page in 0..total_pages {
        let offset = if cur_page == 0 { SALT_SIZE } else { 0 };
        let start = cur_page * PAGE_SIZE;
        let end = start + PAGE_SIZE;

        let iv_start = end - reserve;
        let iv_end = iv_start + IV_SIZE;
        let hmac_start = iv_start + IV_SIZE;
        let hmac_end = hmac_start + HMAC_SHA512_SIZE;
        if hmac_end > end {
            return Err(DecryptError::Invalid(
                "invalid db reserve region".to_string(),
            ));
        }

        let mut mac = HmacSha512::new_from_slice(&mac_key)
            .map_err(|e| DecryptError::Crypto(format!("hmac init: {e}")))?;
        mac.update(&buf[start + offset..iv_start + IV_SIZE]);
        mac.update(&((cur_page as u32) + 1).to_le_bytes());
        let expected = mac.finalize().into_bytes();
        if expected.as_slice() != &buf[hmac_start..hmac_end] {
            return Err(DecryptError::HmacMismatch);
        }

        let iv = &buf[iv_start..iv_end];
        let decrypted_page = Aes256CbcDec::new(&key.into(), iv.into())
            .decrypt_padded_mut::<NoPadding>(&mut buf[start + offset..iv_start])
            .map_err(|e| DecryptError::Crypto(format!("decrypt failed: {e}")))?;
        decrypted.extend_from_slice(decrypted_page);
        decrypted.extend_from_slice(&buf[iv_start..end]);
    }

    Ok(decrypted)
}

fn decrypt_db_file_v4(path: &Path, pkey_hex: &str) -> anyhow::Result<Vec<u8>> {
    let pass = hex::decode(pkey_hex).context("invalid db key hex")?;
    match decrypt_db_file_v4_with_key(path, &pass, true) {
        Ok(v) => Ok(v),
        Err(DecryptError::HmacMismatch) => {
            decrypt_db_file_v4_with_key(path, &pass, false).map_err(|e| anyhow!(e.to_string()))
        }
        Err(e) => Err(anyhow!(e.to_string())),
    }
}

fn push_urls_from_string(value: &str, out: &mut Vec<String>, seen: &mut HashSet<String>) {
    let mut start = 0usize;
    while start < value.len() {
        let remainder = &value[start..];
        let http_index = remainder.find("http://");
        let https_index = remainder.find("https://");
        let next = match (http_index, https_index) {
            (None, None) => break,
            (Some(i), None) => i,
            (None, Some(i)) => i,
            (Some(a), Some(b)) => a.min(b),
        };

        let absolute_start = start + next;
        let after_scheme = &value[absolute_start..];
        let end = after_scheme
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '\\'))
            .map(|i| absolute_start + i)
            .unwrap_or_else(|| value.len());

        if end > absolute_start {
            let url = value[absolute_start..end].to_string();
            if seen.insert(url.clone()) {
                out.push(url);
            }
        }

        start = end;
    }
}

fn normalize_extracted_url(url: &str) -> String {
    // Prefer https for stability.
    if let Some(rest) = url.strip_prefix("http://") {
        return format!("https://{rest}");
    }
    url.to_string()
}

fn score_emoticon_url(url: &str) -> i32 {
    // Heuristic scoring:
    // - Prefer wxapp/vweixinf `stodownload` links (most likely to be directly downloadable).
    // - Strongly de-prioritize mmbiz `mmemoticon` links (often anti-hotlink / placeholder).
    let u = url.to_ascii_lowercase();
    let mut score = 0i32;
    if u.starts_with("https://") {
        score += 20;
    }
    if u.contains("/stodownload") {
        score += 1000;
    }
    if u.contains("wxapp.tc.qq.com") {
        score += 500;
    } else if u.contains("vweixinf.tc.qq.com") {
        score += 400;
    }
    if u.contains("filekey=") {
        score += 100;
    }
    if u.contains("m=") {
        score += 50;
    }
    if u.contains("mmbiz.qpic.cn") {
        score -= 300;
    }
    if u.contains("/mmemoticon/") {
        score -= 100;
    }
    score
}

fn best_emoticon_url_from_fields(fields: &[Option<String>]) -> Option<String> {
    let mut candidates = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();
    for f in fields {
        if let Some(s) = f {
            push_urls_from_string(s, &mut candidates, &mut seen);
        }
    }
    if candidates.is_empty() {
        return None;
    }

    let mut best: Option<(i32, String)> = None;
    for c in candidates {
        let url = normalize_extracted_url(&c);
        let score = score_emoticon_url(&url);
        match &best {
            None => best = Some((score, url)),
            Some((best_score, best_url)) => {
                if score > *best_score || (score == *best_score && url.len() > best_url.len()) {
                    best = Some((score, url));
                }
            }
        }
    }
    best.map(|(_, u)| u)
}

fn extract_urls_from_emoticon_db(emoticon_db: &Path, db_key: &str) -> anyhow::Result<Vec<String>> {
    let decrypted = decrypt_db_file_v4(emoticon_db, db_key)?;

    let mut tmp = NamedTempFile::new().context("创建临时 db 失败")?;
    tmp.write_all(&decrypted).context("写入临时 db 失败")?;
    tmp.flush().ok();

    let conn = Connection::open(tmp.path()).context("打开临时 db 失败")?;

    let mut urls = Vec::<String>::new();
    let mut seen_md5 = HashSet::<String>::new();

    // Prefer order tables so we only export what the user has in their emoji panel.
    // Prefer "Fav" first to match the user's "收藏表情" expectation.
    let order_tables = ["kFavEmoticonOrderTable", "kCustomEmoticonOrderTable"];
    for table in order_tables {
        let sql = format!(
            "SELECT o.md5, n.thumb_url, n.tp_url, n.cdn_url, n.extern_url, n.encrypt_url \
             FROM {table} o LEFT JOIN kNonStoreEmoticonTable n ON o.md5 = n.md5 \
             ORDER BY o.rowid"
        );
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let rows = match stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        }) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let before = urls.len();
        for row in rows {
            let (md5, thumb, tp, cdn, extern_url, encrypt_url) = match row {
                Ok(v) => v,
                Err(_) => continue,
            };
            if md5.trim().is_empty() {
                continue;
            }
            if seen_md5.contains(&md5) {
                continue;
            }
            if let Some(best) = best_emoticon_url_from_fields(&[
                cdn,
                tp,
                thumb,
                extern_url,
                encrypt_url,
            ]) {
                seen_md5.insert(md5);
                urls.push(best);
            }
        }

        // If we got anything from the preferred table, stop (avoid mixing "custom" into "fav").
        if urls.len() > before {
            break;
        }
    }

    // Fallback: scan the non-store table directly (one URL per md5).
    if urls.is_empty() {
        let mut stmt = conn
            .prepare(
                "SELECT md5, thumb_url, tp_url, cdn_url, extern_url, encrypt_url FROM kNonStoreEmoticonTable",
            )
            .context("查询 kNonStoreEmoticonTable 失败")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })
            .context("查询 kNonStoreEmoticonTable 失败")?;
        for row in rows {
            let (md5, thumb, tp, cdn, extern_url, encrypt_url) = row.context("读取行失败")?;
            if md5.trim().is_empty() {
                continue;
            }
            if !seen_md5.insert(md5) {
                continue;
            }
            if let Some(best) = best_emoticon_url_from_fields(&[
                cdn,
                tp,
                thumb,
                extern_url,
                encrypt_url,
            ]) {
                urls.push(best);
            }
        }
    }

    Ok(urls)
}

async fn cmd_key(cli: &Cli, args: &KeyArgs) -> anyhow::Result<()> {
    let accounts = find_accounts()?;
    let account = if let Some(wxid) = &args.wxid {
        let wxid = wxid.trim().to_string();
        accounts
            .into_iter()
            .find(|a| a.wxid == wxid)
            .ok_or_else(|| {
                anyhow!("未找到账号：{wxid}（可先运行 `wxemoticon urls --list-accounts`）")
            })?
    } else {
        select_account(&accounts, cli.no_interactive)?
    };

    let key_file = if let Some(p) = &args.out {
        resolve_user_path(p)?
    } else {
        key_file_for_wxid(&account.wxid)?
    };
    let log_file = if let Some(p) = &args.log {
        resolve_user_path(p)?
    } else {
        key_log_for_wxid(&account.wxid)?
    };

    // If user already ran the legacy script, reuse its key to avoid re-injection.
    if !args.force {
        seed_key_file_from_legacy(&key_file);
    }

    let wechat_app = resolve_user_path(&cli.wechat_app)?;

    let key = get_or_dump_key(
        &wechat_app,
        &key_file,
        &log_file,
        cli.no_interactive,
        args.force,
        Duration::from_secs(args.timeout),
    )?;

    // Keep legacy cache file for compatibility with the app/scripts.
    if let Ok(legacy) = default_key_file() {
        if legacy != key_file {
            let _ = std::fs::write(&legacy, format!("{key}\n"));
        }
    }

    if args.json {
        let out = KeyResult {
            db_key: key,
            db_key_file: key_file.display().to_string(),
            log_file: log_file.display().to_string(),
        };
        println!("{}", serde_json::to_string(&out)?);
    } else {
        println!("{key}");
        eprintln!("key 文件: {}", key_file.display());
        eprintln!("日志: {}", log_file.display());
    }

    if args.open {
        #[cfg(target_os = "macos")]
        open_reveal(&key_file)?;
    }
    Ok(())
}

async fn cmd_urls(cli: &Cli, args: &UrlsArgs) -> anyhow::Result<()> {
    if args.json && args.print {
        return Err(anyhow!(
            "--json 与 --print 不能同时使用（--json 会输出一段 JSON）"
        ));
    }

    let accounts = find_accounts()?;
    if args.list_accounts {
        if accounts.is_empty() {
            println!(
                "未找到账号（目录不存在或未登录微信）：{}",
                xwechat_files_dir()?.display()
            );
            return Ok(());
        }
        for a in accounts {
            println!("{}", a.wxid);
        }
        return Ok(());
    }

    let account = if let Some(wxid) = &args.wxid {
        let wxid = wxid.trim().to_string();
        accounts
            .into_iter()
            .find(|a| a.wxid == wxid)
            .ok_or_else(|| {
                anyhow!("未找到账号：{wxid}（可先运行 `wxemoticon urls --list-accounts`）")
            })?
    } else {
        select_account(&accounts, cli.no_interactive)?
    };

    let out_file = if let Some(p) = &args.out {
        resolve_user_path(p)?
    } else {
        urls_file_for_wxid(&account.wxid)?
    };
    let log_file = if let Some(p) = &args.log {
        resolve_user_path(p)?
    } else {
        urls_log_for_wxid(&account.wxid)?
    };
    let key_file = if let Some(p) = &args.key_file {
        resolve_user_path(p)?
    } else {
        key_file_for_wxid(&account.wxid)?
    };
    let key_log = key_log_for_wxid(&account.wxid)?;

    // If user already ran the legacy script, reuse its key to avoid re-injection.
    if !args.force_key && args.key_file.is_none() {
        seed_key_file_from_legacy(&key_file);
    }

    std::fs::create_dir_all(out_file.parent().ok_or_else(|| anyhow!("无效输出路径"))?).ok();
    let _ = std::fs::remove_file(&out_file);
    let _ = std::fs::remove_file(&log_file);
    let _ = std::fs::write(&log_file, "");

    let wechat_app = resolve_user_path(&cli.wechat_app)?;

    let mut db_key = get_or_dump_key(
        &wechat_app,
        &key_file,
        &key_log,
        cli.no_interactive,
        args.force_key,
        Duration::from_secs(args.timeout),
    )?;

    append_log(&log_file, &format!("[info] wxid={}", account.wxid));
    append_log(
        &log_file,
        &format!("[info] emoticon_db={}", account.emoticon_db.display()),
    );
    append_log(
        &log_file,
        &format!("[info] key_file={}", key_file.display()),
    );

    let urls = match extract_urls_from_emoticon_db(&account.emoticon_db, &db_key) {
        Ok(v) => v,
        Err(e) => {
            let msg = e.to_string();
            append_log(&log_file, &format!("[warn] first attempt failed: {msg}"));
            // If it looks like a key mismatch and we used an on-disk key, try re-dumping once.
            if msg.contains("HMAC verification failed") && key_file.exists() && !args.force_key {
                append_log(
                    &log_file,
                    "[warn] existing db key seems invalid; re-dumping key and retrying...",
                );
                db_key = get_or_dump_key(
                    &wechat_app,
                    &key_file,
                    &key_log,
                    cli.no_interactive,
                    true,
                    Duration::from_secs(args.timeout),
                )?;
                extract_urls_from_emoticon_db(&account.emoticon_db, &db_key)?
            } else {
                return Err(e);
            }
        }
    };

    // IMPORTANT: keep 1 URL per emoji entry (md5) and keep order. Do NOT de-dup by URL here,
    // otherwise different emoji entries that happen to share the same URL would be lost.

    std::fs::write(&out_file, format!("{}\n", urls.join("\n")))
        .with_context(|| format!("写入 URL 文件失败：{}", out_file.display()))?;

    // Keep legacy cache files for compatibility with the app/scripts.
    if let Ok(legacy_key) = default_key_file() {
        if legacy_key != key_file {
            let _ = std::fs::write(&legacy_key, format!("{db_key}\n"));
        }
    }
    if let Ok(legacy_urls) = default_urls_file() {
        if legacy_urls != out_file {
            let _ = std::fs::write(&legacy_urls, format!("{}\n", urls.join("\n")));
        }
    }

    if args.json {
        let out = UrlsResult {
            wxid: account.wxid,
            db_key,
            db_key_file: key_file.display().to_string(),
            urls_file: out_file.display().to_string(),
            log_file: log_file.display().to_string(),
            count: urls.len(),
            urls,
        };
        println!("{}", serde_json::to_string(&out)?);
        return Ok(());
    }

    if args.print {
        for u in &urls {
            println!("{u}");
        }
        eprintln!("已生成 URL 列表: {} 条", urls.len());
        eprintln!("文件: {}", out_file.display());
        eprintln!("日志: {}", log_file.display());
    } else {
        println!("已生成 URL 列表: {} 条", urls.len());
        println!("文件: {}", out_file.display());
        println!("日志: {}", log_file.display());
    }

    if args.open {
        #[cfg(target_os = "macos")]
        open_reveal(&out_file)?;
    }
    Ok(())
}

async fn cmd_export(cli: &Cli, args: &ExportArgs) -> anyhow::Result<()> {
    let mut urls: Vec<String> = vec![];
    let mut wxid: Option<String> = None;

    if let Some(f) = &args.urls_file {
        let p = resolve_user_path(f)?;
        let content = std::fs::read_to_string(&p)
            .with_context(|| format!("读取 URL 文件失败：{}", p.display()))?;
        urls = parse_urls_from_text(&content);
        if urls.is_empty() {
            return Err(anyhow!("URL 文件里没有解析到任何链接：{}", p.display()));
        }
    } else {
        // Reuse the `urls` pipeline.
        let accounts = find_accounts()?;
        let account = if let Some(wx) = &args.wxid {
            let wx = wx.trim().to_string();
            accounts.into_iter().find(|a| a.wxid == wx).ok_or_else(|| {
                anyhow!("未找到账号：{wx}（可先运行 `wxemoticon urls --list-accounts`）")
            })?
        } else {
            select_account(&accounts, cli.no_interactive)?
        };
        wxid = Some(account.wxid.clone());

        let urls_file = urls_file_for_wxid(&account.wxid)?;
        let urls_log = urls_log_for_wxid(&account.wxid)?;
        let key_file = key_file_for_wxid(&account.wxid)?;
        let key_log = key_log_for_wxid(&account.wxid)?;
        let wechat_app = resolve_user_path(&cli.wechat_app)?;

        std::fs::create_dir_all(default_out_dir()?).ok();
        let _ = std::fs::remove_file(&urls_file);
        let _ = std::fs::remove_file(&urls_log);
        let _ = std::fs::write(&urls_log, "");

        seed_key_file_from_legacy(&key_file);

        let mut db_key = get_or_dump_key(
            &wechat_app,
            &key_file,
            &key_log,
            cli.no_interactive,
            false,
            Duration::from_secs(args.timeout),
        )?;

        append_log(&urls_log, &format!("[info] wxid={}", account.wxid));
        append_log(
            &urls_log,
            &format!("[info] emoticon_db={}", account.emoticon_db.display()),
        );

        urls = match extract_urls_from_emoticon_db(&account.emoticon_db, &db_key) {
            Ok(v) => v,
            Err(e) => {
                let msg = e.to_string();
                append_log(&urls_log, &format!("[warn] first attempt failed: {msg}"));
                if msg.contains("HMAC verification failed") && key_file.exists() {
                    append_log(
                        &urls_log,
                        "[warn] existing db key seems invalid; re-dumping key and retrying...",
                    );
                    db_key = get_or_dump_key(
                        &wechat_app,
                        &key_file,
                        &key_log,
                        cli.no_interactive,
                        true,
                        Duration::from_secs(args.timeout),
                    )?;
                    extract_urls_from_emoticon_db(&account.emoticon_db, &db_key)?
                } else {
                    return Err(e);
                }
            }
        };

        // Keep 1 URL per emoji entry (md5) and keep order; don't de-dup by URL.
        std::fs::write(&urls_file, format!("{}\n", urls.join("\n")))
            .with_context(|| format!("写入 URL 文件失败：{}", urls_file.display()))?;
        eprintln!(
            "已生成 URL 列表：{} 条（{}）",
            urls.len(),
            urls_file.display()
        );

        // Keep legacy cache files for compatibility with the app/scripts.
        if let Ok(legacy_key) = default_key_file() {
            if legacy_key != key_file {
                let _ = std::fs::write(&legacy_key, format!("{db_key}\n"));
            }
        }
        if let Ok(legacy_urls) = default_urls_file() {
            if legacy_urls != urls_file {
                let _ = std::fs::write(&legacy_urls, format!("{}\n", urls.join("\n")));
            }
        }
    }

    // Ask user how to group.
    let group_size = if args.flat {
        0
    } else if let Some(n) = args.group_size {
        n
    } else if cli.no_interactive {
        50
    } else {
        let choices = [
            "每 50 张分组（推荐，适配飞书/企微/钉钉一次最多选 50 张）",
            "全部放在一个目录（不分组）",
        ];
        let idx = Select::with_theme(&ColorfulTheme::default())
            .with_prompt("请选择导出方式")
            .items(&choices)
            .default(0)
            .interact_on(&term_stderr())
            .context("读取选择失败")?;
        if idx == 0 {
            50
        } else {
            0
        }
    };

    // Resolve output directory.
    let out_dir = if let Some(p) = &args.out_dir {
        resolve_user_path(p)?
    } else {
        let ts = chrono_like_timestamp();
        let default = downloads_dir()?.join(format!("微信表情包_导出_{ts}"));
        if cli.no_interactive {
            default
        } else {
            let input: String = Input::with_theme(&ColorfulTheme::default())
                .with_prompt("导出目录（回车使用默认）")
                .default(default.display().to_string())
                .interact_text_on(&term_stderr())
                .context("读取输入失败")?;
            resolve_user_path(&input)?
        }
    };

    if out_dir.exists()
        && out_dir
            .read_dir()
            .ok()
            .map(|mut it| it.next().is_some())
            .unwrap_or(false)
    {
        if !cli.no_interactive {
            let ok = Confirm::with_theme(&ColorfulTheme::default())
                .with_prompt(format!(
                    "目录已存在且非空：{}，继续写入？",
                    out_dir.display()
                ))
                .default(false)
                .interact_on(&term_stderr())
                .unwrap_or(false);
            if !ok {
                return Err(anyhow!("已取消"));
            }
        }
    }

    std::fs::create_dir_all(&out_dir)
        .with_context(|| format!("创建导出目录失败：{}", out_dir.display()))?;

    // Keep metadata out of the emoji image list to reduce clutter.
    let meta_dir = out_dir.join("导出信息");
    std::fs::create_dir_all(&meta_dir).ok();

    // Save URL list alongside export for convenience.
    let _ = std::fs::write(
        meta_dir.join("emoticon_urls.txt"),
        format!("{}\n", urls.join("\n")),
    );

    // Write a short usage note.
    let _ = std::fs::write(meta_dir.join("使用说明.txt"), usage_text());

    // Download.
    let client = Client::builder()
        .user_agent(format!("wxemoticon/{}", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(args.http_timeout))
        .build()
        .context("初始化 HTTP 客户端失败")?;

    let pb = ProgressBar::new(urls.len() as u64);
    pb.set_style(
        ProgressStyle::with_template("{spinner:.green} [{elapsed_precise}] {pos}/{len} {wide_msg}")
            .unwrap()
            .progress_chars("#>-"),
    );

    let started = Instant::now();
    let mut ok = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;

    // Pre-compute file names for stable ordering.
    let jobs: Vec<(usize, String)> = urls.into_iter().enumerate().collect();

    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(args.concurrency.max(1)));
    let mut handles = Vec::with_capacity(jobs.len());
    for (idx, url) in jobs {
        if args.skip_existing {
            if export_existing_file(&out_dir, idx, group_size, &url).is_some() {
                skipped += 1;
                pb.inc(1);
                continue;
            }
        }
        let permit = sem.clone().acquire_owned().await?;
        let client = client.clone();
        let out_dir = out_dir.clone();
        let pb = pb.clone();
        let url_clone = url.clone();
        handles.push(tokio::spawn(async move {
            let _permit = permit;
            let res = download_one(&client, &url_clone, idx).await;
            match res {
                Ok(downloaded) => {
                    if let Err(e) = write_one_exported_file(&out_dir, idx, group_size, &downloaded)
                    {
                        pb.println(format!("写文件失败：{e}"));
                        pb.inc(1);
                        return Ok::<_, anyhow::Error>(false);
                    }
                    pb.set_message(downloaded.file_name.clone());
                    pb.inc(1);
                    Ok::<_, anyhow::Error>(true)
                }
                Err(e) => {
                    pb.println(format!("下载失败：{e}"));
                    pb.inc(1);
                    Ok::<_, anyhow::Error>(false)
                }
            }
        }));
    }

    for h in handles {
        match h.await {
            Ok(Ok(true)) => ok += 1,
            Ok(Ok(false)) => failed += 1,
            Ok(Err(_)) => failed += 1,
            Err(_) => failed += 1,
        }
    }

    pb.finish_and_clear();
    eprintln!(
        "导出完成：成功 {ok}，跳过 {skipped}，失败 {failed}，总耗时 {:?}\n目录：{}",
        started.elapsed(),
        out_dir.display()
    );

    if args.json {
        let out = ExportResult {
            wxid,
            out_dir: out_dir.display().to_string(),
            group_size,
            total: ok + skipped + failed,
            ok,
            skipped,
            failed,
        };
        println!("{}", serde_json::to_string(&out)?);
    }

    if args.open {
        #[cfg(target_os = "macos")]
        open_dir(&out_dir)?;
    }

    Ok(())
}

fn resolve_user_path(input: &str) -> anyhow::Result<PathBuf> {
    let s = input.trim();
    if s.starts_with("~/") || s == "~" {
        let home = home_dir()?;
        if s == "~" {
            return Ok(home);
        }
        return Ok(home.join(s.trim_start_matches("~/")));
    }
    Ok(PathBuf::from(s))
}

fn parse_urls_from_text(input: &str) -> Vec<String> {
    // Accept both "one URL per line" and "mixed text".
    let re = Regex::new(r"https?://[^\s]+").unwrap();
    let mut out = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();
    for m in re.find_iter(input) {
        let u = m
            .as_str()
            .trim()
            .trim_end_matches(|c: char| c == '"' || c == '\'' || c == ')');
        if seen.insert(u.to_string()) {
            out.push(u.to_string());
        }
    }
    out
}

fn usage_text() -> &'static str {
    "\
- Q: 为什么默认每 50 张分组？\n\
- A: 因为飞书/企微/钉钉添加表情时，单次选择上限通常是 50 张；分组后更容易批量导入。\n\
\n\
- Q: 为什么有些表情包可能下载失败？\n\
- A: 微信给的 URL 可能过期、风控、或资源未同步；工具会做一定的后缀 fallback，但仍可能失败。\n\
"
}

fn chrono_like_timestamp() -> String {
    let fmt = time::macros::format_description!("[year][month][day]_[hour][minute][second]");
    match time::OffsetDateTime::now_local() {
        Ok(dt) => dt
            .format(&fmt)
            .unwrap_or_else(|_| "unknown_time".to_string()),
        Err(_) => time::OffsetDateTime::now_utc()
            .format(&fmt)
            .unwrap_or_else(|_| "unknown_time".to_string()),
    }
}

#[derive(Debug, Clone)]
struct Downloaded {
    used_url: String,
    bytes: Vec<u8>,
    file_name: String,
    ext: String,
}

fn stodownload_candidates(url: &str) -> Vec<String> {
    if !url.contains("/stodownload") {
        return vec![url.to_string()];
    }
    let exts = ["gif", "jpg", "png", "webp"];
    let mut out = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();

    let mut push = |s: String| {
        if seen.insert(s.clone()) {
            out.push(s);
        }
    };

    push(url.to_string());

    // Replace `/stodownload` or `/stodownload.xxx` right before `?`.
    // Keep order: original -> gif/jpg/png/webp variants.
    let lower = url.to_ascii_lowercase();
    let Some(pos) = lower.find("/stodownload") else {
        return out;
    };
    let after = &url[pos..];
    let Some(qpos) = after.find('?') else {
        return out;
    };
    let before = &url[..pos];
    let tail = &after[qpos + 1..];
    for ext in exts {
        push(format!("{before}/stodownload.{ext}?{tail}"));
    }

    out
}

fn ext_from_content_type(content_type: Option<&str>) -> Option<&'static str> {
    let ct = content_type?.to_ascii_lowercase();
    if ct.contains("image/gif") {
        return Some("gif");
    }
    if ct.contains("image/png") {
        return Some("png");
    }
    if ct.contains("image/webp") {
        return Some("webp");
    }
    if ct.contains("image/jpeg") || ct.contains("image/jpg") {
        return Some("jpg");
    }
    None
}

fn ext_from_bytes(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 6
        && bytes[0] == 0x47
        && bytes[1] == 0x49
        && bytes[2] == 0x46
        && bytes[3] == 0x38
        && (bytes[4] == 0x39 || bytes[4] == 0x37)
        && bytes[5] == 0x61
    {
        return Some("gif");
    }
    if bytes.len() >= 8
        && bytes[0] == 0x89
        && bytes[1] == 0x50
        && bytes[2] == 0x4e
        && bytes[3] == 0x47
        && bytes[4] == 0x0d
        && bytes[5] == 0x0a
        && bytes[6] == 0x1a
        && bytes[7] == 0x0a
    {
        return Some("png");
    }
    if bytes.len() >= 12
        && bytes[0] == 0x52
        && bytes[1] == 0x49
        && bytes[2] == 0x46
        && bytes[3] == 0x46
        && bytes[8] == 0x57
        && bytes[9] == 0x45
        && bytes[10] == 0x42
        && bytes[11] == 0x50
    {
        return Some("webp");
    }
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return Some("jpg");
    }
    None
}

fn ext_from_url(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    let idx = lower.find("/stodownload.")?;
    let after = &url[idx + "/stodownload.".len()..];
    let qpos = after.find('?')?;
    let ext = after[..qpos].trim();
    if ext.is_empty() {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

fn file_key_from_url(url: &str, fallback_index0: usize) -> String {
    if let Ok(u) = Url::parse(url) {
        if let Some(m) = u
            .query_pairs()
            .find(|(k, _)| k == "m")
            .map(|(_, v)| v.to_string())
        {
            if !m.is_empty() {
                return m;
            }
        }
    }
    // Use 1-based numbering to match user expectations (and group dir ranges that start at 1).
    format!("{:06}", fallback_index0 + 1)
}

async fn download_one(client: &Client, url: &str, fallback_index0: usize) -> anyhow::Result<Downloaded> {
    let candidates = stodownload_candidates(url);
    let mut last_err: Option<anyhow::Error> = None;
    for c in candidates {
        match client.get(&c).send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    last_err = Some(anyhow!("HTTP {}: {c}", resp.status()));
                    continue;
                }
                let content_type = resp
                    .headers()
                    .get(CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let bytes = resp.bytes().await.context("读取响应失败")?.to_vec();
                let ext = ext_from_bytes(&bytes)
                    .map(|s| s.to_string())
                    .or_else(|| ext_from_content_type(content_type.as_deref()).map(|s| s.to_string()))
                    .or_else(|| ext_from_url(&c))
                    .unwrap_or_else(|| "gif".to_string());
                let file_key = file_key_from_url(&c, fallback_index0);
                let file_name = format!("{file_key}.{ext}");
                return Ok(Downloaded {
                    used_url: c,
                    bytes,
                    file_name,
                    ext,
                });
            }
            Err(e) => {
                last_err = Some(anyhow!("请求失败：{e}（{c}）"));
                continue;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("下载失败：所有候选 URL 都失败了")))
}

fn group_sub_dir(index: usize, group_size: usize) -> Option<String> {
    if group_size == 0 {
        return None;
    }
    let sub = index / group_size;
    let start = sub * group_size + 1;
    let end = (sub + 1) * group_size;
    Some(format!("{start}_{end}_组"))
}

fn export_existing_file(
    out_dir: &Path,
    index: usize,
    group_size: usize,
    url: &str,
) -> Option<PathBuf> {
    let sub_dir = group_sub_dir(index, group_size);
    let dir = if let Some(s) = sub_dir {
        out_dir.join(s)
    } else {
        out_dir.to_path_buf()
    };
    let key = file_key_from_url(url, index);
    for ext in ["gif", "jpg", "png", "webp"] {
        let p = dir.join(format!("{key}.{ext}"));
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn write_one_exported_file(
    out_dir: &Path,
    index: usize,
    group_size: usize,
    downloaded: &Downloaded,
) -> anyhow::Result<()> {
    let sub_dir = group_sub_dir(index, group_size);
    let dir = if let Some(s) = sub_dir {
        out_dir.join(s)
    } else {
        out_dir.to_path_buf()
    };
    std::fs::create_dir_all(&dir).ok();

    // Use `m` param as file key when possible; otherwise fall back to index.
    let key = file_key_from_url(&downloaded.used_url, index);
    let name = format!("{key}.{}", downloaded.ext);
    std::fs::write(dir.join(name), &downloaded.bytes).context("写入文件失败")?;
    Ok(())
}
