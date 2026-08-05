// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// objc 0.2 macros still probe this legacy feature on recent Rust toolchains.
#![allow(unexpected_cfgs)]

use aes::Aes256;
use cbc::cipher::block_padding::NoPadding;
use cbc::cipher::{BlockDecryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac_array;
use plist::Value;
use rusqlite::Connection;
use serde::Serialize;
use sha2::Sha512;
use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use std::time::UNIX_EPOCH;
use tauri::Manager;
use tempfile::NamedTempFile;

mod emoji_file_cache;
mod wechat_data_bookmark;
use emoji_file_cache::{
    __cmd__cache_and_copy_emoji_file, __cmd__copy_cached_emoji_file, cache_and_copy_emoji_file,
    copy_cached_emoji_file,
};
use wechat_data_bookmark::{
    __cmd__restore_wechat_data_bookmark, __cmd__save_wechat_data_bookmark,
    restore_wechat_data_bookmark, save_wechat_data_bookmark,
};

// Learn more about Tauri commands at https://tauri.app/v1/guides/features/command
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

fn resolve_path_from_home(input: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(input);
    if path.is_absolute() {
        return Ok(path);
    }

    let home_dir = tauri::api::path::home_dir()
        .ok_or_else(|| "failed to resolve home directory".to_string())?;

    Ok(home_dir.join(path))
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

fn walk_plist(value: &Value, out: &mut Vec<String>, seen: &mut HashSet<String>) {
    match value {
        Value::String(s) => push_urls_from_string(s, out, seen),
        Value::Array(items) => {
            for item in items {
                walk_plist(item, out, seen);
            }
        }
        Value::Dictionary(dict) => {
            for (_k, v) in dict {
                walk_plist(v, out, seen);
            }
        }
        _ => {}
    }
}

fn normalize_hex_key(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let no_prefix = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"));
    let key = no_prefix.unwrap_or(trimmed).trim().to_ascii_lowercase();
    if key.len() != 64 {
        return Err("db key must be 64 hex chars (32 bytes)".to_string());
    }
    if !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("db key must be hex".to_string());
    }
    Ok(key)
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

fn decrypt_db_file_v4_with_key(path: &Path, key_bytes: &[u8], treat_as_passphrase: bool) -> Result<Vec<u8>, DecryptError> {
    const IV_SIZE: usize = 16;
    const HMAC_SHA512_SIZE: usize = 64;
    const KEY_SIZE: usize = 32;
    const AES_BLOCK_SIZE: usize = 16;
    const ROUND_COUNT: u32 = 256_000;
    const PAGE_SIZE: usize = 4096;
    const SALT_SIZE: usize = 16;
    const SQLITE_HEADER: &[u8] = b"SQLite format 3";

    let mut buf = std::fs::read(path).map_err(DecryptError::Io)?;
    if buf.starts_with(SQLITE_HEADER) {
        return Ok(buf);
    }
    if buf.len() < PAGE_SIZE || buf.len() % PAGE_SIZE != 0 {
        return Err(DecryptError::Invalid("invalid encrypted db size".to_string()));
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
            return Err(DecryptError::Invalid("invalid db reserve region".to_string()));
        }

        // Verify HMAC over ciphertext + IV, plus page number.
        let mut mac = HmacSha512::new_from_slice(&mac_key)
            .map_err(|e| DecryptError::Crypto(format!("hmac init: {e}")))?;
        mac.update(&buf[start + offset..iv_start + IV_SIZE]);
        mac.update(&((cur_page as u32) + 1).to_le_bytes());
        let expected = mac.finalize().into_bytes();
        if expected.as_slice() != &buf[hmac_start..hmac_end] {
            return Err(DecryptError::HmacMismatch);
        }

        let iv = &buf[iv_start..iv_end];
        // Decrypt page content in-place.
        let decrypted_page = Aes256CbcDec::new(&key.into(), iv.into())
            .decrypt_padded_mut::<NoPadding>(&mut buf[start + offset..iv_start])
            .map_err(|e| DecryptError::Crypto(format!("decrypt failed: {e}")))?;
        decrypted.extend_from_slice(decrypted_page);
        decrypted.extend_from_slice(&buf[iv_start..end]);
    }

    Ok(decrypted)
}

fn decrypt_db_file_v4(path: &Path, pkey_hex: &str) -> Result<Vec<u8>, String> {
    let pass = hex::decode(pkey_hex).map_err(|e| format!("invalid db key hex: {e}"))?;
    // Try the common SQLCipher pattern first: passphrase -> PBKDF2(256k) -> key.
    match decrypt_db_file_v4_with_key(path, &pass, true) {
        Ok(v) => Ok(v),
        Err(DecryptError::HmacMismatch) => {
            // Some injectors may dump the already-derived 32-byte encryption key; try that too.
            decrypt_db_file_v4_with_key(path, &pass, false).map_err(|e| e.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn extract_fav_urls(fav_archive_path: String) -> Result<Vec<String>, String> {
    let path = resolve_path_from_home(&fav_archive_path)?;
    if !Path::new(&path).exists() {
        return Err(format!("fav.archive not found: {}", path.display()));
    }

    let plist_value =
        Value::from_file(&path).map_err(|e| format!("failed to parse plist: {}", e))?;

    let mut urls = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();
    walk_plist(&plist_value, &mut urls, &mut seen);

    Ok(urls)
}

#[tauri::command]
fn extract_emoticon_urls_v4(
    emoticon_db_path: String,
    db_key: String,
) -> Result<Vec<String>, String> {
    let path = resolve_path_from_home(&emoticon_db_path)?;
    if !Path::new(&path).exists() {
        return Err(format!("emoticon.db not found: {}", path.display()));
    }

    let key = normalize_hex_key(&db_key)?;
    let decrypted = decrypt_db_file_v4(&path, &key)?;

    // Write to a temp file so rusqlite can read the SQLite header/page layout.
    let mut tmp = NamedTempFile::new().map_err(|e| format!("failed to create temp file: {e}"))?;
    tmp.write_all(&decrypted)
        .map_err(|e| format!("failed to write temp db: {e}"))?;
    tmp.flush()
        .map_err(|e| format!("failed to flush temp db: {e}"))?;

    let conn = Connection::open(tmp.path()).map_err(|e| format!("open db: {e}"))?;

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
            Ok(v) => v,
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
            let best = best_emoticon_url_from_fields(&[
                cdn,
                tp,
                thumb,
                extern_url,
                encrypt_url,
            ]);
            if let Some(url) = best {
                seen_md5.insert(md5);
                urls.push(url);
            }
        }

        // If the preferred table yields anything, stop (avoid mixing "custom" into "fav").
        if urls.len() > before {
            break;
        }
    }

    // Fallback: best-effort scan non-store table directly (one URL per md5).
    if urls.is_empty() {
        let mut stmt = conn
            .prepare(
                "SELECT md5, thumb_url, tp_url, cdn_url, extern_url, encrypt_url FROM kNonStoreEmoticonTable",
            )
            .map_err(|e| format!("query kNonStoreEmoticonTable: {e}"))?;
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
            .map_err(|e| format!("query kNonStoreEmoticonTable: {e}"))?;
        for row in rows {
            let (md5, thumb, tp, cdn, extern_url, encrypt_url) =
                row.map_err(|e| format!("query kNonStoreEmoticonTable: {e}"))?;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoDumpUrlsResult {
    wxid: String,
    db_key: String,
    db_key_file: String,
    urls_file: String,
    log_file: String,
    urls: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WxEmoticonFlowEvent {
    wxid: String,
    stage: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WeChatRunningCheck {
    running: bool,
    matches: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathAccessStatus {
    path: String,
    exists: bool,
    readable: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WeChatEnvironmentDiag {
    v4_data_dir: PathAccessStatus,
    legacy_data_dir: PathAccessStatus,
    default_wechat_app: PathAccessStatus,
}

#[cfg(target_os = "macos")]
fn home_path() -> Result<PathBuf, String> {
    tauri::api::path::home_dir().ok_or_else(|| "failed to resolve home directory".to_string())
}

#[cfg(target_os = "macos")]
fn path_access_status(path: PathBuf, expect_dir: bool) -> PathAccessStatus {
    let display = path.display().to_string();
    match std::fs::metadata(&path) {
        Ok(meta) => {
            if expect_dir {
                if !meta.is_dir() {
                    return PathAccessStatus {
                        path: display,
                        exists: true,
                        readable: false,
                        error: Some("path exists but is not a directory".to_string()),
                    };
                }
                match std::fs::read_dir(&path) {
                    Ok(_) => PathAccessStatus {
                        path: display,
                        exists: true,
                        readable: true,
                        error: None,
                    },
                    Err(e) => PathAccessStatus {
                        path: display,
                        exists: true,
                        readable: false,
                        error: Some(e.to_string()),
                    },
                }
            } else if meta.is_dir() || meta.is_file() {
                PathAccessStatus {
                    path: display,
                    exists: true,
                    readable: true,
                    error: None,
                }
            } else {
                PathAccessStatus {
                    path: display,
                    exists: true,
                    readable: false,
                    error: Some("path exists but is not a regular file/app bundle".to_string()),
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PathAccessStatus {
            path: display,
            exists: false,
            readable: false,
            error: None,
        },
        Err(e) => PathAccessStatus {
            path: display,
            exists: false,
            readable: false,
            error: Some(e.to_string()),
        },
    }
}

#[cfg(target_os = "macos")]
fn collect_wechat_process_matches(wechat_app_path: &str) -> Vec<String> {
    let home_dir = match home_path() {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let cache_app = home_dir.join("Library/Caches/export-wechat-emoji/WeChat.app");
    let xwechat_files = home_dir.join(
        "Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files",
    );

    let mut needles = vec![
        format!("{}/Contents/", wechat_app_path.trim_end_matches('/')),
        format!("{}/Contents/", cache_app.display()),
        "/Applications/WeChat.app/Contents/".to_string(),
        format!("--wechat-files-path={}", xwechat_files.display()),
        "--bundle-id=5A4RE8SF68.com.tencent.xinWeChat".to_string(),
    ];
    needles.sort();
    needles.dedup();

    let out = Command::new("/bin/ps")
        .args(["-A", "-o", "pid=,args="])
        .output();
    let Ok(out) = out else { return vec![] };
    let text = String::from_utf8_lossy(&out.stdout);

    let mut matches = Vec::<String>::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let matched = needles.iter().any(|needle| line.contains(needle))
            || (line.contains("/Contents/MacOS/WeChat ") && line.contains("com.tencent.xinWeChat"))
            || (line.contains("/Contents/MacOS/WeChatAppEx")
                && line.contains("com.tencent.xinWeChat"));
        if matched {
            matches.push(line.to_string());
        }
    }

    matches.sort();
    matches.dedup();
    matches
}

#[tauri::command]
fn file_mtime_ms(path: String) -> Result<Option<i64>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let mut p = PathBuf::from(trimmed);
    if !p.is_absolute() {
        // Support a common "~/" input for convenience.
        if let Some(rest) = trimmed.strip_prefix("~/") {
            let home = tauri::api::path::home_dir()
                .ok_or_else(|| "failed to resolve home directory".to_string())?;
            p = home.join(rest);
        }
    }

    if !p.exists() {
        return Ok(None);
    }

    let meta = std::fs::metadata(&p).map_err(|e| format!("failed to stat {}: {e}", p.display()))?;
    let modified = meta
        .modified()
        .map_err(|e| format!("failed to get mtime {}: {e}", p.display()))?;
    let ms = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("invalid mtime {}: {e}", p.display()))?
        .as_millis() as i64;
    Ok(Some(ms))
}

#[tauri::command]
fn check_wechat_running(wechat_app_path: Option<String>) -> Result<WeChatRunningCheck, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = wechat_app_path;
        return Ok(WeChatRunningCheck {
            running: false,
            matches: vec![],
        });
    }

    #[cfg(target_os = "macos")]
    {
        let wechat_app_path = wechat_app_path.unwrap_or_else(|| "/Applications/WeChat.app".to_string());
        let matches = collect_wechat_process_matches(&wechat_app_path);

        Ok(WeChatRunningCheck {
            running: !matches.is_empty(),
            matches,
        })
    }
}

#[tauri::command]
fn diagnose_wechat_environment() -> Result<WeChatEnvironmentDiag, String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Err("diagnose_wechat_environment is only supported on macOS".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let home_dir = home_path()?;
        let v4_data_dir = home_dir.join(
            "Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files",
        );
        let legacy_data_dir = home_dir.join(
            "Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat",
        );
        let default_wechat_app = PathBuf::from("/Applications/WeChat.app");

        Ok(WeChatEnvironmentDiag {
            v4_data_dir: path_access_status(v4_data_dir, true),
            legacy_data_dir: path_access_status(legacy_data_dir, true),
            default_wechat_app: path_access_status(default_wechat_app, false),
        })
    }
}

const KEY_DUMP_REQUIRES_MANUAL_ACTION: &str =
    "cached db key is unavailable or invalid; retry manually to obtain a new key";

fn ensure_key_dump_allowed(allow_key_dump: bool) -> Result<(), String> {
    if allow_key_dump {
        Ok(())
    } else {
        Err(KEY_DUMP_REQUIRES_MANUAL_ACTION.to_string())
    }
}

#[tauri::command]
async fn auto_dump_emoticon_urls_v4(
    app: tauri::AppHandle,
    wechat_app_path: Option<String>,
    wxid_dir: String,
    allow_key_dump: Option<bool>,
) -> Result<AutoDumpUrlsResult, String> {
    let allow_key_dump = allow_key_dump.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || {
        auto_dump_emoticon_urls_v4_blocking(app, wechat_app_path, wxid_dir, allow_key_dump)
    })
    .await
    .map_err(|e| format!("internal task failed: {e}"))?
}

#[cfg(not(target_os = "macos"))]
fn auto_dump_emoticon_urls_v4_blocking(
    _app: tauri::AppHandle,
    _wechat_app_path: Option<String>,
    _wxid_dir: String,
    _allow_key_dump: bool,
) -> Result<AutoDumpUrlsResult, String> {
    Err("auto dump is only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
fn auto_dump_emoticon_urls_v4_blocking(
    app: tauri::AppHandle,
    wechat_app_path: Option<String>,
    wxid_dir: String,
    allow_key_dump: bool,
) -> Result<AutoDumpUrlsResult, String> {
    fn emit_flow(app: &tauri::AppHandle, wxid: &str, stage: &str, message: &str) {
        let _ = app.emit_all(
            "wxemoticon:flow",
            WxEmoticonFlowEvent {
                wxid: wxid.to_string(),
                stage: stage.to_string(),
                message: message.to_string(),
            },
        );
    }

    fn wechat_running_matches(wechat_app_path: &str) -> Vec<String> {
        collect_wechat_process_matches(wechat_app_path)
    }

    fn normalize_key_file_line(s: &str) -> String {
        s.trim().trim_start_matches("0x").trim_start_matches("0X").trim().to_ascii_lowercase()
    }

    fn is_valid_key_hex(s: &str) -> bool {
        let k = normalize_key_file_line(s);
        k.len() == 64 && k.chars().all(|c| c.is_ascii_hexdigit())
    }

    fn read_first_line(path: &Path) -> Option<String> {
        let content = std::fs::read_to_string(path).ok()?;
        content.lines().next().map(|s| s.trim().to_string())
    }

    fn append_log(path: &Path, line: &str) {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{line}");
        }
    }

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

    fn read_bundle_version(app_path: &Path) -> Option<String> {
        let p = app_path.join("Contents/Info.plist");
        let v = Value::from_file(p).ok()?;
        let dict = v.as_dictionary()?;
        dict.get("CFBundleVersion")?.as_string().map(|s| s.to_string())
    }

    fn ensure_wechat_runnable_copy(src_app: &Path) -> Result<PathBuf, String> {
        if codesign_is_adhoc(src_app) {
            return Ok(src_app.to_path_buf());
        }

        let home_dir = tauri::api::path::home_dir()
            .ok_or_else(|| "failed to resolve home directory".to_string())?;
        let cache_app = home_dir.join("Library/Caches/export-wechat-emoji/WeChat.app");
        if let Some(parent) = cache_app.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create cache dir: {e}"))?;
        }

        let src_ver = read_bundle_version(src_app);
        let dst_ver = read_bundle_version(&cache_app);

        if src_ver != dst_ver {
            // Keep /Applications untouched: work on a cached copy.
            let _ = std::fs::remove_dir_all(&cache_app);
            let status = Command::new("/bin/cp")
                .arg("-R")
                .arg(src_app)
                .arg(&cache_app)
                .status()
                .map_err(|e| format!("failed to copy WeChat.app: {e}"))?;
            if !status.success() {
                return Err("failed to copy WeChat.app to cache".to_string());
            }
            // Clear quarantine if present.
            let _ = Command::new("/usr/bin/xattr").arg("-cr").arg(&cache_app).status();
        }

        if !codesign_is_adhoc(&cache_app) {
            let status = Command::new("/usr/bin/codesign")
                .args(["--force", "--deep", "--sign", "-"])
                .arg(&cache_app)
                .status()
                .map_err(|e| format!("failed to re-sign WeChat copy: {e}"))?;
            if !status.success() {
                return Err("failed to re-sign cached WeChat.app copy".to_string());
            }
        }

        Ok(cache_app)
    }

    fn resolve_key_dumper_dylib(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let resolver = app.path_resolver();
        let candidates = [
            "wechat_key_dumper.dylib",
            "_up_/tools/wechat-key-dumper/wechat_key_dumper.dylib",
            "tools/wechat-key-dumper/wechat_key_dumper.dylib",
            "wechat-key-dumper/wechat_key_dumper.dylib",
            "wechat_key_dumper/wechat_key_dumper.dylib",
        ];
        for c in candidates {
            if let Some(p) = resolver.resolve_resource(c) {
                if p.exists() {
                    return Ok(p);
                }
            }
        }

        // Dev fallback.
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tools/wechat-key-dumper/wechat_key_dumper.dylib");
        if dev.exists() {
            return Ok(dev);
        }

        Err("failed to locate wechat_key_dumper.dylib (bundle resource missing)".to_string())
    }

    fn terminate_pid(pid: u32) {
        let _ = Command::new("/bin/kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();
    }

    fn terminate_child(child: &mut std::process::Child) {
        let pid = child.id();
        terminate_pid(pid);

        // Avoid blocking forever if WeChat doesn't exit on SIGTERM.
        for _ in 0..5 {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_secs(1));
        }

        let _ = child.kill();
        let _ = child.wait();
    }

    fn wait_for_key_file(
        key_file: &Path,
        timeout: Duration,
    ) -> Result<String, String> {
        let mut waited = Duration::from_secs(0);
        while waited < timeout {
            if let Some(line) = read_first_line(key_file) {
                if is_valid_key_hex(&line) {
                    return Ok(normalize_key_file_line(&line));
                }
            }
            std::thread::sleep(Duration::from_secs(1));
            waited += Duration::from_secs(1);
        }
        Err("timed out waiting for db key; login and open the emoji panel once, then try again".to_string())
    }

    fn wait_for_target_wxid_file(
        wxid_file: &Path,
        timeout: Duration,
    ) -> Result<String, String> {
        let mut waited = Duration::from_secs(0);
        while waited < timeout {
            if let Some(line) = read_first_line(wxid_file) {
                let value = line.trim().to_string();
                if !value.is_empty() {
                    return Ok(value);
                }
            }
            std::thread::sleep(Duration::from_secs(1));
            waited += Duration::from_secs(1);
        }
        Err("timed out waiting for target wxid; login and open the emoji panel once, then try again".to_string())
    }

    fn find_emoticon_db_for_wxid(wxid_dir: &str) -> Result<PathBuf, String> {
        let home_dir = tauri::api::path::home_dir()
            .ok_or_else(|| "failed to resolve home directory".to_string())?;
        let base = home_dir.join(
            "Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files",
        );
        let db = base
            .join(wxid_dir)
            .join("db_storage/emoticon/emoticon.db");
        if !db.exists() {
            return Err(format!("emoticon.db not found for wxid: {wxid_dir}"));
        }
        Ok(db)
    }

    let home_dir =
        tauri::api::path::home_dir().ok_or_else(|| "failed to resolve home directory".to_string())?;
    let app_data_dir = app
        .path_resolver()
        .app_data_dir()
        .ok_or_else(|| "failed to resolve appDataDir".to_string())?;
    let out_dir = app_data_dir.join("export-wechat-emoji");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("failed to create app out dir: {e}"))?;

    // Mirror dir: keep compatibility with CLI/old scripts.
    let mirror_dir = home_dir.join(
        "Library/Containers/com.tencent.xinWeChat/Data/Documents/export-wechat-emoji",
    );
    std::fs::create_dir_all(&mirror_dir)
        .map_err(|e| format!("failed to create mirror dir: {e}"))?;

    let wxid_dir = wxid_dir.trim().to_string();
    if wxid_dir.is_empty() {
        return Err("wxid_dir is required".to_string());
    }
    emit_flow(&app, &wxid_dir, "preparing_wechat_copy", "开始获取表情数据…");

    let key_file = out_dir.join(format!("emoticon_dbkey_{wxid_dir}.txt"));
    let key_wxid_file = out_dir.join(format!("emoticon_dbkey_{wxid_dir}.wxid"));
    let key_log = out_dir.join(format!("emoticon_dbkey_{wxid_dir}.log"));
    let urls_file = out_dir.join(format!("emoticon_urls_{wxid_dir}.txt"));
    let urls_log = out_dir.join(format!("emoticon_urls_{wxid_dir}.log"));

    let mirror_key_file = mirror_dir.join(format!("emoticon_dbkey_{wxid_dir}.txt"));
    let mirror_key_wxid_file = mirror_dir.join(format!("emoticon_dbkey_{wxid_dir}.wxid"));
    let mirror_key_log = mirror_dir.join(format!("emoticon_dbkey_{wxid_dir}.log"));
    let mirror_urls_file = mirror_dir.join(format!("emoticon_urls_{wxid_dir}.txt"));
    let mirror_urls_log = mirror_dir.join(format!("emoticon_urls_{wxid_dir}.log"));

    let mirror_legacy_key = mirror_dir.join("emoticon_dbkey.txt");
    let mirror_legacy_urls = mirror_dir.join("emoticon_urls.txt");
    let mirror_legacy_log = mirror_dir.join("emoticon_urls.log");

    let db = find_emoticon_db_for_wxid(&wxid_dir)?;

    // Keep files on disk (per user request), but truncate logs for this run.
    let _ = std::fs::remove_file(&urls_file);
    let _ = std::fs::remove_file(&urls_log);
    let _ = std::fs::write(&urls_log, "");
    let _ = std::fs::remove_file(&mirror_urls_file);
    let _ = std::fs::remove_file(&mirror_urls_log);
    let _ = std::fs::write(&mirror_urls_log, "");
    let _ = std::fs::remove_file(&mirror_legacy_log);
    let _ = std::fs::write(&mirror_legacy_log, "");

    let wechat_app_path = wechat_app_path.unwrap_or_else(|| "/Applications/WeChat.app".to_string());

    let dump_key = || -> Result<String, String> {
        // Dumping key requires WeChat to be fully quit (cannot run concurrently on the same container).
        if !wechat_running_matches(&wechat_app_path).is_empty() {
            return Err("WECHAT_RUNNING".to_string());
        }

        let wechat_app = PathBuf::from(&wechat_app_path);
        if !wechat_app.exists() {
            return Err(format!("WeChat.app not found: {}", wechat_app.display()));
        }

        let dylib = resolve_key_dumper_dylib(&app)?;
        emit_flow(&app, &wxid_dir, "preparing_wechat_copy", "正在准备微信副本…");
        let run_app = ensure_wechat_runnable_copy(&wechat_app)?;

        // Truncate key output for a fresh run.
        let _ = std::fs::remove_file(&key_file);
        let _ = std::fs::remove_file(&key_wxid_file);
        let _ = std::fs::remove_file(&key_log);
        let _ = std::fs::remove_file(&mirror_key_file);
        let _ = std::fs::remove_file(&mirror_key_wxid_file);
        let _ = std::fs::remove_file(&mirror_key_log);

        append_log(
            &urls_log,
            &format!("[info] launching WeChat for db key dump: {}", run_app.display()),
        );
        append_log(
            &mirror_urls_log,
            &format!("[info] launching WeChat for db key dump: {}", run_app.display()),
        );

        emit_flow(
            &app,
            &wxid_dir,
            "waiting_for_key",
            "等待抓取 key…（如弹出微信，请登录并打开一次表情面板）",
        );
        let mut child = Command::new(run_app.join("Contents/MacOS/WeChat"))
            .env("EXPORT_WECHAT_EMOJI_KEY_OUT", &key_file)
            .env("EXPORT_WECHAT_EMOJI_KEY_WXID_OUT", &key_wxid_file)
            .env("EXPORT_WECHAT_EMOJI_KEY_LOG", &key_log)
            .env("EXPORT_WECHAT_EMOJI_TARGET_WXID", &wxid_dir)
            .env("DYLD_INSERT_LIBRARIES", &dylib)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("failed to launch WeChat: {e}"))?;

        let key_res = wait_for_key_file(&key_file, Duration::from_secs(600));
        let key_wxid_res = wait_for_target_wxid_file(&key_wxid_file, Duration::from_secs(600));

        terminate_child(&mut child);

        let key = key_res?;
        let actual_wxid = key_wxid_res?;
        if actual_wxid != wxid_dir {
            return Err(format!(
                "抓取到的 key 属于另一个微信账号：{}。请在弹出的微信里登录你选择的账号（当前选择：{}）后重试。",
                actual_wxid, wxid_dir
            ));
        }
        emit_flow(&app, &wxid_dir, "offline_parsing", "已获取 key，正在离线解析…");

        // Mirror key + log to the WeChat container dir for compatibility.
        let _ = std::fs::copy(&key_file, &mirror_key_file);
        let _ = std::fs::copy(&key_wxid_file, &mirror_key_wxid_file);
        let _ = std::fs::copy(&key_log, &mirror_key_log);
        let _ = std::fs::write(&mirror_legacy_key, format!("{key}\n"));
        Ok(key)
    };

    let dump_key_if_allowed = || -> Result<String, String> {
        ensure_key_dump_allowed(allow_key_dump)?;
        dump_key()
    };

    let mut used_existing_key = false;
    let mut db_key: Option<String> = None;

    // Prefer app cache, then fall back to mirror cache (CLI/old scripts).
    if key_file.exists() {
        if let Some(line) = read_first_line(&key_file) {
            if is_valid_key_hex(&line) {
                db_key = Some(normalize_key_file_line(&line));
                used_existing_key = true;
                append_log(&urls_log, &format!("[info] using existing db key: {}", key_file.display()));
                append_log(
                    &mirror_urls_log,
                    &format!("[info] using existing db key: {}", key_file.display()),
                );
            }
        }
    }
    if db_key.is_none() {
        let candidates = [&mirror_key_file, &mirror_legacy_key];
        for c in candidates {
            if let Some(line) = read_first_line(c) {
                if is_valid_key_hex(&line) {
                    let k = normalize_key_file_line(&line);
                    db_key = Some(k.clone());
                    used_existing_key = true;
                    // Seed app cache for future runs.
                    let _ = std::fs::write(&key_file, format!("{k}\n"));
                    append_log(
                        &urls_log,
                        &format!("[info] using existing db key from mirror: {}", c.display()),
                    );
                    append_log(
                        &mirror_urls_log,
                        &format!("[info] using existing db key from mirror: {}", c.display()),
                    );
                    break;
                }
            }
        }
    }

    if db_key.is_none() {
        db_key = Some(dump_key_if_allowed()?);
    }

    let mut db_key = db_key.ok_or_else(|| "failed to get db key".to_string())?;
    if !is_valid_key_hex(&db_key) {
        return Err("invalid db key".to_string());
    }

    if used_existing_key {
        emit_flow(&app, &wxid_dir, "offline_parsing", "使用缓存 key，正在离线解析…");
    } else {
        emit_flow(&app, &wxid_dir, "offline_parsing", "正在离线解析…");
    }

    append_log(&urls_log, &format!("[info] wxid_dir={wxid_dir}"));
    append_log(&urls_log, &format!("[info] emoticon_db={}", db.display()));
    append_log(&mirror_urls_log, &format!("[info] wxid_dir={wxid_dir}"));
    append_log(&mirror_urls_log, &format!("[info] emoticon_db={}", db.display()));

    let extract_for_key = |key: &str| -> Result<(Vec<String>, bool), String> {
        let mut urls = Vec::<String>::new();
        let mut seen_md5 = HashSet::<String>::new();
        let mut saw_hmac_mismatch = false;

        append_log(&urls_log, &format!("[info] extracting urls from: {}", db.display()));
        append_log(&mirror_urls_log, &format!("[info] extracting urls from: {}", db.display()));
        match decrypt_db_file_v4(&db, key) {
            Ok(decrypted) => {
                let mut tmp = NamedTempFile::new()
                    .map_err(|e| format!("failed to create temp file: {e}"))?;
                tmp.write_all(&decrypted)
                    .map_err(|e| format!("failed to write temp db: {e}"))?;
                tmp.flush()
                    .map_err(|e| format!("failed to flush temp db: {e}"))?;

                let conn =
                    Connection::open(tmp.path()).map_err(|e| format!("open temp db: {e}"))?;

                // Prefer order tables so we match the emoji panel (one URL per md5).
                // Prefer "Fav" first to align with "收藏表情" expectation.
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
                        Err(e) => {
                            append_log(&urls_log, &format!("[warn] query {table} failed: {e}"));
                            append_log(&mirror_urls_log, &format!("[warn] query {table} failed: {e}"));
                            continue;
                        }
                    };

                    let before = urls.len();
                    for row in rows {
                        let (md5, thumb, tp, cdn, extern_url, encrypt_url) = match row {
                            Ok(v) => v,
                            Err(e) => {
                                append_log(
                                    &urls_log,
                                    &format!("[warn] query {table} row failed: {e}"),
                                );
                                append_log(
                                    &mirror_urls_log,
                                    &format!("[warn] query {table} row failed: {e}"),
                                );
                                continue;
                            }
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

                    // If we got anything from the preferred table, stop (avoid mixing custom into fav).
                    if urls.len() > before {
                        break;
                    }
                }

                // Fallback: scan the non-store table directly (one URL per md5).
                if urls.is_empty() {
                    let mut stmt = match conn.prepare(
                        "SELECT md5, thumb_url, tp_url, cdn_url, extern_url, encrypt_url FROM kNonStoreEmoticonTable",
                    ) {
                        Ok(v) => v,
                        Err(e) => {
                            append_log(&urls_log, &format!("[warn] query kNonStoreEmoticonTable prepare failed: {e}"));
                            append_log(&mirror_urls_log, &format!("[warn] query kNonStoreEmoticonTable prepare failed: {e}"));
                            return Ok((urls, saw_hmac_mismatch));
                        }
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
                        Err(e) => {
                            append_log(&urls_log, &format!("[warn] query kNonStoreEmoticonTable failed: {e}"));
                            append_log(&mirror_urls_log, &format!("[warn] query kNonStoreEmoticonTable failed: {e}"));
                            return Ok((urls, saw_hmac_mismatch));
                        }
                    };
                    for row in rows {
                        let (md5, thumb, tp, cdn, extern_url, encrypt_url) = match row {
                            Ok(v) => v,
                            Err(e) => {
                                append_log(&urls_log, &format!("[warn] query kNonStoreEmoticonTable row failed: {e}"));
                                append_log(&mirror_urls_log, &format!("[warn] query kNonStoreEmoticonTable row failed: {e}"));
                                continue;
                            }
                        };
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
            }
            Err(e) => {
                if e.contains("HMAC verification failed") {
                    saw_hmac_mismatch = true;
                }
                append_log(&urls_log, &format!("[warn] failed to decrypt {}: {e}", db.display()));
                append_log(&mirror_urls_log, &format!("[warn] failed to decrypt {}: {e}", db.display()));
            }
        }

        Ok((urls, saw_hmac_mismatch))
    };

    let (mut urls, saw_hmac_mismatch) = extract_for_key(&db_key)?;
    if urls.is_empty() && used_existing_key && saw_hmac_mismatch {
        append_log(
            &urls_log,
            if allow_key_dump {
                "[warn] existing db key seems invalid; re-dumping key and retrying..."
            } else {
                "[warn] existing db key seems invalid; automatic key dump is disabled"
            },
        );
        db_key = dump_key_if_allowed()?;
        let (retry_urls, _retry_saw) = extract_for_key(&db_key)?;
        urls = retry_urls;
    }

    if urls.is_empty() {
        return Err(format!("no URLs extracted; see log: {}", urls_log.display()));
    }

    emit_flow(&app, &wxid_dir, "writing_files", "正在写入结果文件…");
    let content = format!("{}\n", urls.join("\n"));
    std::fs::write(&urls_file, content)
        .map_err(|e| format!("failed to write urls file: {e}"))?;
    let _ = std::fs::copy(&urls_file, &mirror_urls_file);
    let _ = std::fs::copy(&urls_log, &mirror_urls_log);
    let _ = std::fs::write(&mirror_legacy_urls, format!("{}\n", urls.join("\n")));

    emit_flow(&app, &wxid_dir, "done", "完成");
    Ok(AutoDumpUrlsResult {
        wxid: wxid_dir,
        db_key,
        db_key_file: key_file.display().to_string(),
        urls_file: urls_file.display().to_string(),
        log_file: urls_log.display().to_string(),
        urls,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_refresh_cannot_dump_a_new_key() {
        assert_eq!(
            ensure_key_dump_allowed(false),
            Err(KEY_DUMP_REQUIRES_MANUAL_ACTION.to_string())
        );
    }

    #[test]
    fn manual_refresh_can_dump_a_new_key() {
        assert_eq!(ensure_key_dump_allowed(true), Ok(()));
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            greet,
            copy_cached_emoji_file,
            cache_and_copy_emoji_file,
            save_wechat_data_bookmark,
            restore_wechat_data_bookmark,
            file_mtime_ms,
            check_wechat_running,
            diagnose_wechat_environment,
            extract_fav_urls,
            extract_emoticon_urls_v4,
            auto_dump_emoticon_urls_v4
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
