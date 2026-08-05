// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// objc 0.2 macros still probe this legacy feature on recent Rust toolchains.
#![allow(unexpected_cfgs)]

mod stickerhub;
mod emoji_file_cache;
mod wechat_data_bookmark;

use aes::{Aes128, Aes256};
use aes::cipher::{BlockEncrypt, KeyInit};
use cbc::cipher::block_padding::NoPadding;
use cbc::cipher::{BlockDecryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac_array;
use plist::Value;
use rusqlite::Connection;
use serde::Serialize;
use sha2::Sha512;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use std::time::UNIX_EPOCH;
use tauri::Manager;
use reqwest::blocking::Client;
use tempfile::NamedTempFile;
use emoji_file_cache::{
    __cmd__cache_and_copy_emoji_file,
    __cmd__copy_cached_emoji_file,
    cache_and_copy_emoji_file,
    copy_cached_emoji_file,
};
use wechat_data_bookmark::{
    __cmd__restore_wechat_data_bookmark,
    __cmd__save_wechat_data_bookmark,
    restore_wechat_data_bookmark,
    save_wechat_data_bookmark,
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
        let mut mac = <HmacSha512 as Mac>::new_from_slice(&mac_key)
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

#[derive(Clone, Debug)]
struct EmoticonUrlRow {
    md5: String,
    url: String,
}

#[derive(Clone, Debug)]
struct EmoticonAlbumMemberRow {
    md5: String,
    sort_order: i64,
    download_url: Option<String>,
    encrypt_url: Option<String>,
    aes_key_hex: Option<String>,
    preview_path: Option<String>,
    local_source_path: Option<String>,
}

#[derive(Clone, Debug)]
struct MatchedLegacyStickerRoot {
    path: PathBuf,
    overlap: usize,
    second_best_overlap: usize,
    strong_match: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EmoticonRenderItem {
    pub(crate) id: String,
    pub(crate) md5: String,
    pub(crate) src: String,
    pub(crate) download_url: Option<String>,
    pub(crate) local_source_path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EmoticonAlbumMemberRef {
    pub(crate) md5: String,
    pub(crate) sort_order: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EmoticonAlbumCatalogItem {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) count: usize,
    pub(crate) icon: Option<String>,
    pub(crate) urls: Vec<String>,
    pub(crate) items: Vec<EmoticonRenderItem>,
    pub(crate) members: Vec<EmoticonAlbumMemberRef>,
    pub(crate) package_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EmoticonCatalogResult {
    pub(crate) mode: String,
    pub(crate) warnings: Vec<String>,
    pub(crate) favorites: Vec<String>,
    pub(crate) albums: Vec<EmoticonAlbumCatalogItem>,
}

fn build_sql_in_list(values: &[String]) -> String {
    let normalized: Vec<String> = values
        .iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect();
    if normalized.is_empty() {
        return "''".to_string();
    }

    normalized
        .iter()
        .map(|item| format!("'{}'", item.replace('"', "\"").replace('\'', "''")))
        .collect::<Vec<String>>()
        .join(", ")
}

fn query_table_columns(conn: &Connection, table: &str) -> Result<HashSet<String>, String> {
    let sql = format!("PRAGMA table_info('{table}')");
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare pragma table_info({table}): {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("query pragma table_info({table}): {e}"))?;

    let mut out = HashSet::<String>::new();
    for row in rows {
        if let Ok(name) = row {
            let normalized = name.trim().to_string();
            if !normalized.is_empty() {
                out.insert(normalized);
            }
        }
    }
    Ok(out)
}

fn pick_existing_column(columns: &HashSet<String>, candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .find(|candidate| columns.contains(**candidate))
        .map(|candidate| (*candidate).to_string())
}

fn is_package_id_like_name(value: &str, package_id: &str) -> bool {
    let normalized = value.trim();
    if normalized.is_empty() {
        return true;
    }
    if !package_id.is_empty() && normalized == package_id {
        return true;
    }
    normalized
        .to_ascii_lowercase()
        .starts_with("com.tencent.xin.emoticon.")
}

fn pick_readable_package_name(values: &[Option<String>], package_id: &str) -> Option<String> {
    for candidate in values {
        let Some(value) = candidate else { continue };
        let text = value.trim();
        if text.is_empty() || is_package_id_like_name(text, package_id) {
            continue;
        }
        return Some(text.to_string());
    }
    None
}

fn with_decrypted_emoticon_conn<T, F>(
    emoticon_db_path: &Path,
    db_key: &str,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, String>,
{
    let decrypted = decrypt_db_file_v4(emoticon_db_path, db_key)?;
    let mut tmp = NamedTempFile::new().map_err(|e| format!("failed to create temp file: {e}"))?;
    tmp.write_all(&decrypted)
        .map_err(|e| format!("failed to write temp db: {e}"))?;
    tmp.flush()
        .map_err(|e| format!("failed to flush temp db: {e}"))?;

    let conn = Connection::open(tmp.path()).map_err(|e| format!("open db: {e}"))?;
    f(&conn)
}

fn collect_favorite_url_rows_from_conn(conn: &Connection) -> Result<Vec<EmoticonUrlRow>, String> {
    let mut urls = Vec::<EmoticonUrlRow>::new();
    let mut seen_md5 = HashSet::<String>::new();

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
            let normalized_md5 = md5.trim().to_ascii_lowercase();
            if normalized_md5.is_empty() || seen_md5.contains(&normalized_md5) {
                continue;
            }
            if let Some(url) = best_emoticon_url_from_fields(&[
                cdn,
                tp,
                thumb,
                extern_url,
                encrypt_url,
            ]) {
                seen_md5.insert(normalized_md5.clone());
                urls.push(EmoticonUrlRow {
                    md5: normalized_md5,
                    url,
                });
            }
        }

        if urls.len() > before {
            break;
        }
    }

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
            let normalized_md5 = md5.trim().to_ascii_lowercase();
            if normalized_md5.is_empty() || seen_md5.contains(&normalized_md5) {
                continue;
            }
            if let Some(url) = best_emoticon_url_from_fields(&[
                cdn,
                tp,
                thumb,
                extern_url,
                encrypt_url,
            ]) {
                seen_md5.insert(normalized_md5.clone());
                urls.push(EmoticonUrlRow {
                    md5: normalized_md5,
                    url,
                });
            }
        }
    }

    Ok(urls)
}

#[derive(Clone, Debug, Default)]
struct NonStoreMemberMeta {
    download_url: Option<String>,
    encrypt_url: Option<String>,
    aes_key_hex: Option<String>,
}

fn normalize_16_byte_hex(input: &str) -> Option<[u8; 16]> {
    let trimmed = input.trim();
    if trimmed.len() != 32 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let decoded = hex::decode(trimmed).ok()?;
    if decoded.len() != 16 {
        return None;
    }
    let mut out = [0u8; 16];
    out.copy_from_slice(&decoded);
    Some(out)
}

fn collect_non_store_member_meta_map_from_conn(
    conn: &Connection,
) -> Result<HashMap<String, NonStoreMemberMeta>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT md5, aes_key, thumb_url, tp_url, cdn_url, extern_url, encrypt_url FROM kNonStoreEmoticonTable",
        )
        .map_err(|e| format!("prepare kNonStoreEmoticonTable meta: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(|e| format!("query kNonStoreEmoticonTable meta: {e}"))?;

    let mut out = HashMap::<String, NonStoreMemberMeta>::new();
    for row in rows {
        let (md5, aes_key, thumb, tp, cdn, extern_url, encrypt_url) =
            row.map_err(|e| format!("query kNonStoreEmoticonTable meta: {e}"))?;
        let normalized_md5 = md5.trim().to_ascii_lowercase();
        if normalized_md5.is_empty() {
            continue;
        }

        let download_url = best_emoticon_url_from_fields(&[
            cdn,
            tp,
            thumb,
            extern_url,
            encrypt_url.clone(),
        ]);

        let normalized_aes_key = aes_key
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| normalize_16_byte_hex(value).is_some());

        out.entry(normalized_md5).or_insert_with(|| NonStoreMemberMeta {
            download_url,
            encrypt_url: encrypt_url.map(|value| normalize_extracted_url(&value)),
            aes_key_hex: normalized_aes_key,
        });
    }

    Ok(out)
}

fn collect_active_package_ids_from_conn(conn: &Connection) -> Result<Vec<String>, String> {
    let columns = query_table_columns(conn, "kStoreEmoticonPackageTable")?;
    let package_id_col = pick_existing_column(&columns, &["package_id_", "package_id", "packageId"])
        .ok_or_else(|| "kStoreEmoticonPackageTable missing package id column".to_string())?;
    let download_status_col = pick_existing_column(&columns, &["download_status_", "download_status"]);
    let remove_time_col = pick_existing_column(&columns, &["remove_time_", "remove_time"]);

    let mut conditions = Vec::<String>::new();
    if let Some(column) = download_status_col {
        conditions.push(format!("coalesce({column}, 0) = 1"));
    }
    if let Some(column) = remove_time_col {
        conditions.push(format!("coalesce({column}, 0) = 0"));
    }

    let sql = if conditions.is_empty() {
        format!(
            "SELECT DISTINCT {package_id_col} FROM kStoreEmoticonPackageTable ORDER BY {package_id_col} ASC"
        )
    } else {
        format!(
            "SELECT DISTINCT {package_id_col} FROM kStoreEmoticonPackageTable WHERE {} ORDER BY {package_id_col} ASC",
            conditions.join(" AND ")
        )
    };

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare kStoreEmoticonPackageTable active packages: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("query kStoreEmoticonPackageTable active packages: {e}"))?;

    let mut out = Vec::<String>::new();
    for row in rows {
        let package_id = row
            .map_err(|e| format!("query kStoreEmoticonPackageTable active packages: {e}"))?
            .trim()
            .to_string();
        if !package_id.is_empty() {
            out.push(package_id);
        }
    }
    Ok(out)
}

fn decrypt_aes128_cbc_with_self_iv(data: &[u8], key: &[u8; 16]) -> Result<Vec<u8>, String> {
    type Aes128CbcDec = cbc::Decryptor<Aes128>;

    let mut buf = data.to_vec();
    let decrypted = Aes128CbcDec::new(&(*key).into(), &(*key).into())
        .decrypt_padded_mut::<NoPadding>(&mut buf)
        .map_err(|e| format!("aes-128-cbc decrypt failed: {e}"))?;

    Ok(decrypted.to_vec())
}

fn detect_image_extension(data: &[u8]) -> Option<&'static str> {
    let (start, _end, ext) = detect_embedded_image_slice(data)?;
    if start == 0 {
        Some(ext)
    } else {
        None
    }
}

fn download_bytes(client: &Client, url: &str) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .and_then(|value| value.error_for_status())
        .map_err(|e| format!("download failed: {e}"))?;

    response.bytes()
        .map(|value| value.to_vec())
        .map_err(|e| format!("read response bytes failed: {e}"))
}

fn resolve_remote_preview_cache_dir() -> Result<PathBuf, String> {
    let home_dir = home_path()?;
    let dir = home_dir.join("Library/Caches/export-wechat-emoji/album-remote-preview");
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create remote preview cache dir: {e}"))?;
    Ok(dir)
}

fn ensure_remote_member_preview_file(
    client: &Client,
    package_id: &str,
    member: &EmoticonAlbumMemberRow,
) -> Result<Option<PathBuf>, String> {
    let Some(encrypt_url) = member.encrypt_url.as_deref() else {
        return Ok(None);
    };
    let Some(aes_key_hex) = member.aes_key_hex.as_deref() else {
        return Ok(None);
    };
    let Some(key) = normalize_16_byte_hex(aes_key_hex) else {
        return Ok(None);
    };

    let cache_dir = resolve_remote_preview_cache_dir()?;
    let cache_prefix = format!("{}-{}", package_id, member.md5);
    let existing = ["gif", "png", "jpg", "webp"]
        .iter()
        .map(|ext| cache_dir.join(format!("{cache_prefix}.{ext}")))
        .find(|path| path.exists());
    if let Some(path) = existing {
        return Ok(Some(path));
    }

    let encrypted = download_bytes(client, encrypt_url)?;
    let decrypted = decrypt_aes128_cbc_with_self_iv(&encrypted, &key)?;
    let Some(ext) = detect_image_extension(&decrypted) else {
        return Ok(None);
    };

    let out_path = cache_dir.join(format!("{cache_prefix}.{ext}"));
    fs::write(&out_path, &decrypted)
        .map_err(|e| format!("failed to write remote preview cache {}: {e}", out_path.display()))?;
    Ok(Some(out_path))
}

fn collect_package_name_map_from_conn(
    conn: &Connection,
    package_ids: &[String],
) -> Result<HashMap<String, String>, String> {
    if package_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let columns = query_table_columns(conn, "kStoreEmoticonPackageTable")?;
    let package_id_col = pick_existing_column(&columns, &["package_id_", "package_id", "packageId"])
        .ok_or_else(|| "kStoreEmoticonPackageTable missing package id column".to_string())?;

    let mut select_columns = vec![package_id_col.clone()];
    for candidate in [
        "package_name_",
        "package_name",
        "title_",
        "title",
        "name_",
        "name",
        "display_name_",
        "display_name",
        "label_name_",
        "label_name",
        "desc_",
        "desc",
        "summary_",
        "summary",
    ] {
        if columns.contains(candidate) {
            select_columns.push(candidate.to_string());
        }
    }

    let sql = format!(
        "SELECT {} FROM kStoreEmoticonPackageTable WHERE {} IN ({})",
        select_columns.join(", "),
        package_id_col,
        build_sql_in_list(package_ids)
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare kStoreEmoticonPackageTable: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let package_id = row.get::<_, String>(0)?;
            let mut values = Vec::<Option<String>>::new();
            for index in 1..select_columns.len() {
                values.push(row.get::<_, Option<String>>(index)?);
            }
            Ok((package_id, values))
        })
        .map_err(|e| format!("query kStoreEmoticonPackageTable: {e}"))?;

    let mut out = HashMap::<String, String>::new();
    for row in rows {
        let (package_id, values) =
            row.map_err(|e| format!("query kStoreEmoticonPackageTable: {e}"))?;
        let normalized_package_id = package_id.trim().to_string();
        if normalized_package_id.is_empty() {
            continue;
        }
        if let Some(name) = pick_readable_package_name(&values, &normalized_package_id) {
            out.insert(normalized_package_id, name);
        }
    }

    Ok(out)
}

fn normalize_file_uri_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let encoded = text.replace('#', "%23").replace(' ', "%20");
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

fn detect_embedded_image_slice(data: &[u8]) -> Option<(usize, usize, &'static str)> {
    let mut best: Option<(usize, usize, &'static str)> = None;
    let len = data.len();
    let mut index = 0usize;
    while index < len {
        if index + 3 <= len && data[index..].starts_with(&[0xff, 0xd8, 0xff]) {
            let mut end = None;
            let mut pos = index + 2;
            while pos + 1 < len {
                if data[pos] == 0xff && data[pos + 1] == 0xd9 {
                    end = Some(pos + 2);
                    break;
                }
                pos += 1;
            }
            if let Some(image_end) = end {
                let candidate = (index, image_end, "jpg");
                if best.map(|(start, _, _)| index < start).unwrap_or(true) {
                    best = Some(candidate);
                }
                index = image_end;
                continue;
            }
        }
        if index + 6 <= len && (&data[index..index + 6] == b"GIF87a" || &data[index..index + 6] == b"GIF89a") {
            let mut end = None;
            let mut pos = index + 6;
            while pos + 1 < len {
                if data[pos] == 0x3b {
                    end = Some(pos + 1);
                    break;
                }
                pos += 1;
            }
            if let Some(image_end) = end {
                let candidate = (index, image_end, "gif");
                if best.map(|(start, _, _)| index < start).unwrap_or(true) {
                    best = Some(candidate);
                }
                index = image_end;
                continue;
            }
        }
        if index + 8 <= len && &data[index..index + 8] == b"\x89PNG\r\n\x1a\n" {
            let mut pos = index + 8;
            let mut end = None;
            while pos + 8 <= len {
                let chunk_len = u32::from_be_bytes([
                    data[pos],
                    data[pos + 1],
                    data[pos + 2],
                    data[pos + 3],
                ]) as usize;
                if pos + 12 + chunk_len > len {
                    break;
                }
                let chunk_type = &data[pos + 4..pos + 8];
                pos += 12 + chunk_len;
                if chunk_type == b"IEND" {
                    end = Some(pos);
                    break;
                }
            }
            if let Some(image_end) = end {
                let candidate = (index, image_end, "png");
                if best.map(|(start, _, _)| index < start).unwrap_or(true) {
                    best = Some(candidate);
                }
                index = image_end;
                continue;
            }
        }
        if index + 12 <= len && &data[index..index + 4] == b"RIFF" && &data[index + 8..index + 12] == b"WEBP" {
            let chunk_len = u32::from_le_bytes([
                data[index + 4],
                data[index + 5],
                data[index + 6],
                data[index + 7],
            ]) as usize;
            let image_end = index.saturating_add(8 + chunk_len);
            if image_end <= len {
                let candidate = (index, image_end, "webp");
                if best.map(|(start, _, _)| index < start).unwrap_or(true) {
                    best = Some(candidate);
                }
                index = image_end;
                continue;
            }
        }
        index += 1;
    }
    best
}

fn resolve_preview_cache_dir() -> Result<PathBuf, String> {
    let home_dir = home_path()?;
    let dir = home_dir.join("Library/Caches/export-wechat-emoji/favorite-stickers");
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create preview cache dir: {e}"))?;
    Ok(dir)
}

fn extract_local_preview_file(source_path: &Path, cache_key: &str) -> Result<Option<PathBuf>, String> {
    if !source_path.exists() {
        return Ok(None);
    }

    let data = fs::read(source_path)
        .map_err(|e| format!("failed to read local sticker source {}: {e}", source_path.display()))?;
    let Some((start, end, ext)) = detect_embedded_image_slice(&data) else {
        return Ok(None);
    };

    let cache_dir = resolve_preview_cache_dir()?;
    let out_path = cache_dir.join(format!("{cache_key}.{ext}"));
    if !out_path.exists() {
        fs::write(&out_path, &data[start..end])
            .map_err(|e| format!("failed to write preview cache {}: {e}", out_path.display()))?;
    }
    Ok(Some(out_path))
}

#[cfg(target_os = "macos")]
fn find_persistence_path(sticker_root: &Path, md5: &str) -> Option<PathBuf> {
    let path = sticker_root.join("Persistence").join(md5);
    path.exists().then_some(path)
}

#[cfg(target_os = "macos")]
fn find_thumb_path(sticker_root: &Path, md5: &str) -> Option<PathBuf> {
    let path = sticker_root.join("Thumbs").join(format!("{md5}.thumb"));
    path.exists().then_some(path)
}

#[cfg(target_os = "macos")]
fn build_local_preview_maps(
    sticker_root: &Path,
    package_ids: &[String],
    album_member_map: &HashMap<String, Vec<EmoticonAlbumMemberRow>>,
) -> Result<(HashMap<String, String>, HashMap<String, String>), String> {
    let mut preview_map = HashMap::<String, String>::new();
    let mut source_map = HashMap::<String, String>::new();

    for package_id in package_ids {
        let Some(members) = album_member_map.get(package_id) else { continue };
        for member in members {
            if preview_map.contains_key(&member.md5) {
                continue;
            }

            let persistence_path = find_persistence_path(sticker_root, &member.md5);
            let thumb_path = find_thumb_path(sticker_root, &member.md5);
            let cache_key = format!("{}-{}", package_id, member.md5);

            let mut preview_path: Option<String> = None;
            let mut preview_source_path: Option<PathBuf> = None;

            if let Some(path) = persistence_path.as_ref() {
                preview_path = extract_local_preview_file(path, &format!("{cache_key}-p"))?
                    .map(|value| normalize_file_uri_path(&value));
                if preview_path.is_some() {
                    preview_source_path = Some(path.clone());
                }
            }

            if preview_path.is_none() {
                if let Some(path) = thumb_path.as_ref() {
                    preview_path = extract_local_preview_file(path, &format!("{cache_key}-t"))?
                        .map(|value| normalize_file_uri_path(&value));
                    if preview_path.is_some() {
                        preview_source_path = Some(path.clone());
                    }
                }
            }

            if let Some(preview_path) = preview_path {
                preview_map.insert(member.md5.clone(), preview_path);
            }

            if let Some(source_path) = preview_source_path
                .or(persistence_path.clone())
                .or(thumb_path.clone())
            {
                source_map.insert(member.md5.clone(), normalize_file_uri_path(&source_path));
            }
        }
    }

    Ok((preview_map, source_map))
}

fn collect_album_members_from_conn(
    conn: &Connection,
    package_ids: &[String],
    non_store_meta_map: &HashMap<String, NonStoreMemberMeta>,
) -> Result<HashMap<String, Vec<EmoticonAlbumMemberRow>>, String> {
    if package_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let columns = query_table_columns(conn, "kStoreEmoticonFilesTable")?;
    let package_id_col = pick_existing_column(&columns, &["package_id_", "package_id", "packageId"])
        .ok_or_else(|| "kStoreEmoticonFilesTable missing package id column".to_string())?;
    let md5_col = pick_existing_column(&columns, &["md5_", "md5"])
        .ok_or_else(|| "kStoreEmoticonFilesTable missing md5 column".to_string())?;
    let sort_order_col = pick_existing_column(&columns, &["sort_order_", "sort_order"])
        .unwrap_or_else(|| "rowid".to_string());

    let store_url_columns: Vec<String> = ["cdn_url_", "cdn_url", "url_", "url", "thumb_url_", "thumb_url"]
        .iter()
        .filter(|candidate| columns.contains(**candidate))
        .map(|candidate| (*candidate).to_string())
        .collect();

    let mut select_columns = vec![package_id_col.clone(), md5_col.clone(), sort_order_col.clone()];
    select_columns.extend(store_url_columns.iter().cloned());

    let sql = format!(
        "SELECT {} \
         FROM kStoreEmoticonFilesTable \
         WHERE {package_id_col} IN ({}) \
         ORDER BY {package_id_col} ASC, {sort_order_col} ASC, {md5_col} ASC",
        select_columns.join(", "),
        build_sql_in_list(package_ids)
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare kStoreEmoticonFilesTable: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let package_id = row.get::<_, String>(0)?;
            let md5 = row.get::<_, String>(1)?;
            let sort_order = row.get::<_, i64>(2).unwrap_or(i64::MAX);
            let mut url_fields = Vec::<Option<String>>::new();
            for index in 0..store_url_columns.len() {
                url_fields.push(row.get::<_, Option<String>>(3 + index)?);
            }
            Ok((package_id, md5, sort_order, url_fields))
        })
        .map_err(|e| format!("query kStoreEmoticonFilesTable: {e}"))?;

    let mut out = HashMap::<String, Vec<EmoticonAlbumMemberRow>>::new();
    for row in rows {
        let (package_id, md5, sort_order, url_fields) =
            row.map_err(|e| format!("query kStoreEmoticonFilesTable: {e}"))?;
        let normalized_package_id = package_id.trim().to_string();
        let normalized_md5 = md5.trim().to_ascii_lowercase();
        if normalized_package_id.is_empty() || normalized_md5.is_empty() {
            continue;
        }

        let list = out.entry(normalized_package_id).or_insert_with(Vec::new);
        if list.iter().any(|item| item.md5 == normalized_md5) {
            continue;
        }

        let store_url = best_emoticon_url_from_fields(&url_fields);
        let non_store_meta = non_store_meta_map.get(&normalized_md5).cloned().unwrap_or_default();
        list.push(EmoticonAlbumMemberRow {
            md5: normalized_md5.clone(),
            sort_order,
            download_url: store_url.or(non_store_meta.download_url.clone()),
            encrypt_url: non_store_meta.encrypt_url,
            aes_key_hex: non_store_meta.aes_key_hex,
            preview_path: None,
            local_source_path: None,
        });
    }

    Ok(out)
}

#[cfg(target_os = "macos")]
fn find_v4_emoticon_db_for_wxid(wxid_dir: &str) -> Result<PathBuf, String> {
    let home_dir = home_path()?;
    let db = home_dir
        .join("Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files")
        .join(wxid_dir)
        .join("db_storage/emoticon/emoticon.db");
    if !db.exists() {
        return Err(format!("emoticon.db not found for wxid: {wxid_dir}"));
    }
    Ok(db)
}

#[cfg(target_os = "macos")]
fn collect_thumb_md5_names_recursive(dir: &Path, out: &mut HashSet<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            collect_thumb_md5_names_recursive(&path, out);
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.ends_with(".thumb") {
            continue;
        }
        let stem = name.trim_end_matches(".thumb").trim().to_ascii_lowercase();
        if stem.len() == 32 && stem.chars().all(|c| c.is_ascii_hexdigit()) {
            out.insert(stem);
        }
    }
}

#[cfg(target_os = "macos")]
fn collect_v4_thumb_md5_names(home_dir: &Path, wxid_dir: &str) -> HashSet<String> {
    let thumb_dir = home_dir
        .join("Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files")
        .join(wxid_dir)
        .join("business/emoticon/Thumb");
    let mut out = HashSet::<String>::new();
    if thumb_dir.exists() {
        collect_thumb_md5_names_recursive(&thumb_dir, &mut out);
    }
    out
}

#[cfg(target_os = "macos")]
fn find_legacy_sticker_roots(home_dir: &Path) -> Vec<PathBuf> {
    let base_dir = home_dir.join(
        "Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat",
    );
    let mut roots = Vec::<PathBuf>::new();
    let version_dirs = match std::fs::read_dir(base_dir) {
        Ok(v) => v,
        Err(_) => return roots,
    };

    for version_entry in version_dirs.flatten() {
        let version_file_type = match version_entry.file_type() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !version_file_type.is_dir() {
            continue;
        }
        let version_dir = version_entry.path();
        let account_dirs = match std::fs::read_dir(&version_dir) {
            Ok(v) => v,
            Err(_) => continue,
        };

        for account_entry in account_dirs.flatten() {
            let account_file_type = match account_entry.file_type() {
                Ok(v) => v,
                Err(_) => continue,
            };
            if !account_file_type.is_dir() {
                continue;
            }
            let sticker_root = account_entry.path().join("Stickers");
            if sticker_root.join("Thumbs").exists() {
                roots.push(sticker_root);
            }
        }
    }

    roots.sort();
    roots
}

#[cfg(target_os = "macos")]
fn count_overlap_with_v4_thumbs(thumbs_dir: &Path, v4_md5_names: &HashSet<String>) -> usize {
    let entries = match std::fs::read_dir(thumbs_dir) {
        Ok(v) => v,
        Err(_) => return 0,
    };

    let mut count = 0usize;
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(".thumb") {
            continue;
        }
        let stem = name.trim_end_matches(".thumb").trim().to_ascii_lowercase();
        if stem.len() == 32
            && stem.chars().all(|c| c.is_ascii_hexdigit())
            && v4_md5_names.contains(&stem)
        {
            count += 1;
        }
    }
    count
}

#[cfg(target_os = "macos")]
fn resolve_matching_legacy_sticker_root(
    home_dir: &Path,
    wxid_dir: &str,
) -> Result<Option<MatchedLegacyStickerRoot>, String> {
    let v4_md5_names = collect_v4_thumb_md5_names(home_dir, wxid_dir);
    if v4_md5_names.is_empty() {
        return Ok(None);
    }

    let mut best_path: Option<PathBuf> = None;
    let mut best_overlap = 0usize;
    let mut second_best_overlap = 0usize;

    for sticker_root in find_legacy_sticker_roots(home_dir) {
        let overlap = count_overlap_with_v4_thumbs(&sticker_root.join("Thumbs"), &v4_md5_names);
        if overlap > best_overlap {
            second_best_overlap = best_overlap;
            best_overlap = overlap;
            best_path = Some(sticker_root);
        } else if overlap > second_best_overlap {
            second_best_overlap = overlap;
        }
    }

    let Some(path) = best_path else {
        return Ok(None);
    };
    if best_overlap < 20 {
        return Ok(None);
    }

    let strong_match = second_best_overlap == 0 || best_overlap >= second_best_overlap.saturating_mul(5);
    Ok(Some(MatchedLegacyStickerRoot {
        path,
        overlap: best_overlap,
        second_best_overlap,
        strong_match,
    }))
}

#[cfg(target_os = "macos")]
fn collect_local_package_ids_from_sticker_root(sticker_root: &Path) -> Vec<String> {
    let thumbs_dir = sticker_root.join("Thumbs");
    let entries = match std::fs::read_dir(thumbs_dir) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    let mut package_ids = HashSet::<String>::new();
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }

        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(".thumb") {
            continue;
        }
        let package_id = name.trim_end_matches(".thumb").trim();
        if package_id
            .to_ascii_lowercase()
            .starts_with("com.tencent.xin.emoticon.")
        {
            package_ids.insert(package_id.to_string());
        }
    }

    let mut out: Vec<String> = package_ids.into_iter().collect();
    out.sort();
    out
}

#[tauri::command]
pub(crate) fn build_emoticon_catalog_v4(
    wxid_dir: String,
    db_key: String,
) -> Result<EmoticonCatalogResult, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (wxid_dir, db_key);
        return Err("build_emoticon_catalog_v4 is only supported on macOS".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let normalized_wxid = wxid_dir.trim().to_string();
        if normalized_wxid.is_empty() {
            return Err("wxid_dir is required".to_string());
        }

        let key = normalize_hex_key(&db_key)?;
        let home_dir = home_path()?;
        let emoticon_db_path = find_v4_emoticon_db_for_wxid(&normalized_wxid)?;
        let matched_root = resolve_matching_legacy_sticker_root(&home_dir, &normalized_wxid)?;

        let mut result = with_decrypted_emoticon_conn(&emoticon_db_path, &key, |conn| {
            let favorite_rows = collect_favorite_url_rows_from_conn(conn)?;
            let favorites = favorite_rows
                .iter()
                .map(|item| item.url.clone())
                .collect::<Vec<String>>();

            let mut warnings = Vec::<String>::new();
            let local_package_ids = collect_active_package_ids_from_conn(conn)?;
            let non_store_meta_map = collect_non_store_member_meta_map_from_conn(conn)?;
            let package_name_map = collect_package_name_map_from_conn(conn, &local_package_ids)?;
            let mut album_member_map = collect_album_members_from_conn(conn, &local_package_ids, &non_store_meta_map)?;

            let remote_preview_client = Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|e| format!("failed to build preview http client: {e}"))?;

            let (local_preview_map, local_source_map) = matched_root
                .as_ref()
                .map(|matched| build_local_preview_maps(&matched.path, &local_package_ids, &album_member_map))
                .transpose()?
                .unwrap_or_default();

            let mut remote_preview_failures = 0usize;
            for (package_id, members) in album_member_map.iter_mut() {
                for member in members.iter_mut() {
                    if let Ok(Some(path)) = ensure_remote_member_preview_file(&remote_preview_client, package_id, member) {
                        member.preview_path = Some(normalize_file_uri_path(&path));
                        member.local_source_path = Some(normalize_file_uri_path(&path));
                        continue;
                    } else if member.encrypt_url.is_some() && member.aes_key_hex.is_some() {
                        remote_preview_failures += 1;
                    }

                    member.preview_path = local_preview_map.get(&member.md5).cloned();
                    member.local_source_path = local_source_map.get(&member.md5).cloned();
                }
            }

            if remote_preview_failures > 0 {
                warnings.push(format!(
                    "有 {} 个专辑成员的远端真图恢复失败，已回退到本地可用预览或保留下载地址。",
                    remote_preview_failures
                ));
            }

            let mut unresolved_name_count = 0usize;
            let mut partial_album_count = 0usize;
            let mut albums = Vec::<EmoticonAlbumCatalogItem>::new();

            for package_id in &local_package_ids {
                let mut members = album_member_map.get(package_id).cloned().unwrap_or_default();
                members.sort_by(|left, right| {
                    left.sort_order
                        .cmp(&right.sort_order)
                        .then_with(|| left.md5.cmp(&right.md5))
                });

                if members.is_empty() {
                    partial_album_count += 1;
                }

                let mut urls = Vec::<String>::new();
                let mut seen_urls = HashSet::<String>::new();
                let mut render_items = Vec::<EmoticonRenderItem>::new();
                let member_refs = members
                    .iter()
                    .map(|member| EmoticonAlbumMemberRef {
                        md5: member.md5.to_ascii_lowercase(),
                        sort_order: member.sort_order,
                    })
                    .collect::<Vec<_>>();
                for member in &members {
                    let preview_src = member.preview_path.clone().or_else(|| member.download_url.clone());
                    let Some(src) = preview_src else { continue };

                    if let Some(download_url) = member.download_url.clone() {
                        if seen_urls.insert(download_url.clone()) {
                            urls.push(download_url);
                        }
                    }

                    render_items.push(EmoticonRenderItem {
                        id: format!("{}:{}", package_id, member.md5),
                        md5: member.md5.clone(),
                        src,
                        download_url: member.download_url.clone(),
                        local_source_path: member.local_source_path.clone(),
                    });
                }

                if !members.is_empty() && render_items.len() < members.len() {
                    partial_album_count += 1;
                }

                let name = match package_name_map.get(package_id) {
                    Some(name) => name.clone(),
                    None => {
                        unresolved_name_count += 1;
                        package_id.clone()
                    }
                };

                let icon = render_items
                    .first()
                    .map(|item| item.src.clone())
                    .or_else(|| urls.first().cloned());

                albums.push(EmoticonAlbumCatalogItem {
                    id: package_id.clone(),
                    name,
                    count: members.len(),
                    icon,
                    urls,
                    items: render_items,
                    members: member_refs,
                    package_id: package_id.clone(),
                });
            }

            albums.sort_by(|left, right| {
                right
                    .count
                    .cmp(&left.count)
                    .then_with(|| left.name.cmp(&right.name))
            });

            if let Some(matched) = &matched_root {
                if !matched.strong_match {
                    warnings.push(format!(
                        "已匹配到疑似专辑缓存目录，但账号映射存在歧义（交集 {}，次优 {}），专辑结果可能不完整。",
                        matched.overlap, matched.second_best_overlap
                    ));
                }
            }

            if unresolved_name_count > 0 {
                warnings.push(format!(
                    "有 {} 个专辑未恢复出可读名称，已回退显示 packageId。",
                    unresolved_name_count
                ));
            }

            if partial_album_count > 0 {
                warnings.push(format!(
                    "有 {} 个专辑包含暂不可预览或不可导出的成员，已按可用资源继续展示。",
                    partial_album_count
                ));
            }

            let mode = if !albums.is_empty() {
                if warnings.is_empty() {
                    "full".to_string()
                } else {
                    "partial".to_string()
                }
            } else if !favorites.is_empty() {
                "favorites_only".to_string()
            } else {
                "unavailable".to_string()
            };

            Ok(EmoticonCatalogResult {
                mode,
                warnings,
                favorites,
                albums,
            })
        })?;

        if matched_root.is_none() {
            result.warnings.push(
                "未能匹配当前账号的本地专辑缓存目录，已回退为个人收藏导出模式。"
                    .to_string(),
            );
            if result.mode == "full" {
                result.mode = "partial".to_string();
            } else if result.mode == "unavailable" {
                result.mode = "favorites_only".to_string();
            }
        } else if result.albums.is_empty() && !result.favorites.is_empty() {
            result.warnings.push(
                "当前账号未识别到已添加的表情专辑，已切换为个人收藏导出模式。"
                    .to_string(),
            );
            result.mode = "favorites_only".to_string();
        }

        if result.albums.is_empty() && result.favorites.is_empty() {
            result.mode = "unavailable".to_string();
            if result.warnings.is_empty() {
                result.warnings.push(
                    "未恢复出可读取的表情收藏或专辑数据，请确认微信版本与本地目录结构。"
                        .to_string(),
                );
            }
        }

        Ok(result)
    }
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WeChatCurrentAccountProfile {
    wxid: Option<String>,
    display_name: Option<String>,
    avatar_url: Option<String>,
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

fn read_varint(buf: &[u8], offset: usize) -> Option<(usize, usize)> {
    let mut value = 0usize;
    let mut length = 0usize;
    let mut shift = 0usize;
    let mut cursor = offset;

    while cursor < buf.len() && shift < (usize::BITS as usize) {
        let byte = buf[cursor];
        cursor += 1;
        value |= ((byte & 0x7f) as usize) << shift;
        length += 1;
        if (byte & 0x80) == 0 {
            return Some((value, length));
        }
        shift += 7;
    }

    None
}

fn extract_mmkv_string(buf: &[u8], key_name: &str) -> Option<String> {
    let key = key_name.as_bytes();
    let idx = buf.windows(key.len()).position(|window| window == key)?;

    let mut offset = idx + key.len();
    let (_first, first_len) = read_varint(buf, offset)?;
    offset += first_len;
    let (value_len, second_len) = read_varint(buf, offset)?;
    offset += second_len;

    if value_len == 0 || value_len > 10_000 || offset + value_len > buf.len() {
        return None;
    }

    let value = std::str::from_utf8(&buf[offset..offset + value_len]).ok()?.trim();
    if value.is_empty() {
        return None;
    }

    Some(value.to_string())
}

fn fallback_extract_http_url(buf: &[u8]) -> Option<String> {
    let http_positions = [b"https://".as_slice(), b"http://".as_slice()];
    let start = http_positions
        .iter()
        .find_map(|needle| buf.windows(needle.len()).position(|window| window == *needle))?;

    let end = buf[start..]
        .iter()
        .position(|b| *b == 0)
        .map(|i| start + i)
        .unwrap_or(buf.len());

    let value = std::str::from_utf8(&buf[start..end]).ok()?.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.to_string())
}

fn decrypt_aes128_cfb_in_place(buf: &mut [u8], key: &[u8; 16], iv: &[u8; 16]) {
    let cipher = Aes128::new_from_slice(key).expect("aes-128 key length must be 16 bytes");
    let mut feedback = *iv;

    for chunk in buf.chunks_mut(16) {
        let ciphertext = chunk.to_vec();
        let mut keystream = feedback.into();
        cipher.encrypt_block(&mut keystream);

        for (index, byte) in chunk.iter_mut().enumerate() {
            *byte ^= keystream[index];
        }

        if ciphertext.len() == 16 {
            feedback.copy_from_slice(&ciphertext);
        }
    }
}

#[cfg(target_os = "macos")]
fn parse_wechat_current_account_profile() -> Result<Option<WeChatCurrentAccountProfile>, String> {
    let home_dir = home_path()?;
    let config_path = home_dir.join(
        "Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/all_users/config/global_config",
    );

    if !config_path.exists() {
        return Ok(None);
    }

    let full_data = std::fs::read(&config_path)
        .map_err(|e| format!("failed to read {}: {e}", config_path.display()))?;
    if full_data.len() <= 4 {
        return Ok(None);
    }

    let mut decrypted = full_data[4..].to_vec();

    let mut key = [0u8; 16];
    let hardcoded = b"xwechat_crypt_key";
    let copy_len = key.len().min(hardcoded.len());
    key[..copy_len].copy_from_slice(&hardcoded[..copy_len]);
    let iv = [0u8; 16];

    decrypt_aes128_cfb_in_place(&mut decrypted, &key, &iv);

    let wxid = extract_mmkv_string(&decrypted, "mmkv_key_user_name");
    let display_name = extract_mmkv_string(&decrypted, "mmkv_key_nick_name");
    let avatar_url = extract_mmkv_string(&decrypted, "mmkv_key_head_img_url")
        .or_else(|| fallback_extract_http_url(&decrypted));

    if wxid.is_none() && display_name.is_none() && avatar_url.is_none() {
        return Ok(None);
    }

    Ok(Some(WeChatCurrentAccountProfile {
        wxid,
        display_name,
        avatar_url,
    }))
}

#[tauri::command]
fn read_current_wechat_account_profile() -> Result<Option<WeChatCurrentAccountProfile>, String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Ok(None);
    }

    #[cfg(target_os = "macos")]
    {
        parse_wechat_current_account_profile()
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
            read_current_wechat_account_profile,
            extract_fav_urls,
            extract_emoticon_urls_v4,
            build_emoticon_catalog_v4,
            stickerhub::read_stickerhub_album_cache,
            stickerhub::refresh_stickerhub_album,
            auto_dump_emoticon_urls_v4
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
