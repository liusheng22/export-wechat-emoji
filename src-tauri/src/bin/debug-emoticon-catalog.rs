use aes::Aes256;
use cbc::cipher::block_padding::NoPadding;
use cbc::cipher::{BlockDecryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac_array;
use rusqlite::Connection;
use sha2::Sha512;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

fn normalize_hex_key(input: &str) -> anyhow::Result<String> {
    let trimmed = input.trim();
    let no_prefix = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"));
    let key = no_prefix.unwrap_or(trimmed).trim().to_ascii_lowercase();
    anyhow::ensure!(key.len() == 64, "db key must be 64 hex chars (32 bytes)");
    anyhow::ensure!(key.chars().all(|c| c.is_ascii_hexdigit()), "db key must be hex");
    Ok(key)
}

fn decrypt_db_file_v4(path: &Path, pkey_hex: &str) -> anyhow::Result<Vec<u8>> {
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
    anyhow::ensure!(buf.len() >= PAGE_SIZE && buf.len() % PAGE_SIZE == 0, "invalid encrypted db size");

    let salt = buf[..SALT_SIZE].to_vec();
    let mac_salt: Vec<u8> = salt.iter().map(|b| b ^ 0x3a).collect();

    let pass = hex::decode(pkey_hex)?;
    let key = pbkdf2_hmac_array::<Sha512, KEY_SIZE>(&pass, &salt, ROUND_COUNT);
    let mac_key = pbkdf2_hmac_array::<Sha512, KEY_SIZE>(&key, &mac_salt, 2);

    let mut reserve = IV_SIZE + HMAC_SHA512_SIZE;
    if reserve % AES_BLOCK_SIZE != 0 {
        reserve = ((reserve / AES_BLOCK_SIZE) + 1) * AES_BLOCK_SIZE;
    }

    let total_pages = buf.len() / PAGE_SIZE;
    let mut decrypted = Vec::<u8>::with_capacity(buf.len());
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
        anyhow::ensure!(hmac_end <= end, "invalid db reserve region");

        let mut mac = HmacSha512::new_from_slice(&mac_key)?;
        mac.update(&buf[start + offset..iv_start + IV_SIZE]);
        mac.update(&((cur_page as u32) + 1).to_le_bytes());
        let expected = mac.finalize().into_bytes();
        anyhow::ensure!(expected.as_slice() == &buf[hmac_start..hmac_end], "db key mismatch (HMAC verification failed)");

        let iv = &buf[iv_start..iv_end];
        let decrypted_page = Aes256CbcDec::new(&key.into(), iv.into())
            .decrypt_padded_mut::<NoPadding>(&mut buf[start + offset..iv_start])
            .map_err(|e| anyhow::anyhow!("decrypt failed: {e:?}"))?;
        decrypted.extend_from_slice(decrypted_page);
        decrypted.extend_from_slice(&buf[iv_start..end]);
    }

    Ok(decrypted)
}

fn with_decrypted_emoticon_conn<T, F>(
    emoticon_db_path: &Path,
    db_key: &str,
    f: F,
) -> anyhow::Result<T>
where
    F: FnOnce(&Connection) -> anyhow::Result<T>,
{
    let decrypted = decrypt_db_file_v4(emoticon_db_path, db_key)?;
    let mut tmp = NamedTempFile::new()?;
    tmp.write_all(&decrypted)?;
    tmp.flush()?;
    let conn = Connection::open(tmp.path())?;
    f(&conn)
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

fn query_table_columns(conn: &Connection, table: &str) -> anyhow::Result<HashSet<String>> {
    let sql = format!("PRAGMA table_info('{table}')");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut out = HashSet::<String>::new();
    for row in rows {
        let name = row?;
        let normalized = name.trim().to_string();
        if !normalized.is_empty() {
            out.insert(normalized);
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
    if let Some(rest) = url.strip_prefix("http://") {
        return format!("https://{rest}");
    }
    url.to_string()
}

fn score_emoticon_url(url: &str) -> i32 {
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

fn resolve_preview_cache_dir() -> anyhow::Result<PathBuf> {
    let home_dir = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("failed to resolve home directory"))?;
    let dir = home_dir.join("Library/Caches/export-wechat-emoji/favorite-stickers");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn extract_local_preview_file(source_path: &Path, cache_key: &str) -> anyhow::Result<Option<PathBuf>> {
    if !source_path.exists() {
        return Ok(None);
    }

    let data = fs::read(source_path)?;
    let Some((start, end, ext)) = detect_embedded_image_slice(&data) else {
        return Ok(None);
    };

    let cache_dir = resolve_preview_cache_dir()?;
    let out_path = cache_dir.join(format!("{cache_key}.{ext}"));
    if !out_path.exists() {
        fs::write(&out_path, &data[start..end])?;
    }
    Ok(Some(out_path))
}

fn find_persistence_path(sticker_root: &Path, md5: &str) -> Option<PathBuf> {
    let path = sticker_root.join("Persistence").join(md5);
    path.exists().then_some(path)
}

fn find_thumb_path(sticker_root: &Path, md5: &str) -> Option<PathBuf> {
    let path = sticker_root.join("Thumbs").join(format!("{md5}.thumb"));
    path.exists().then_some(path)
}

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

fn collect_v4_persist_md5_names(home_dir: &Path, wxid_dir: &str) -> HashSet<String> {
    let persist_dir = home_dir
        .join("Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files")
        .join(wxid_dir)
        .join("business/emoticon/Persist");
    let mut out = HashSet::<String>::new();
    if persist_dir.exists() {
        let entries = match std::fs::read_dir(&persist_dir) {
            Ok(v) => v,
            Err(_) => return out,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else { continue };
            if !file_type.is_dir() {
                continue;
            }
            let Ok(children) = std::fs::read_dir(path) else { continue };
            for child in children.flatten() {
                let child_path = child.path();
                let Ok(child_type) = child.file_type() else { continue };
                if !child_type.is_file() {
                    continue;
                }
                let Some(name) = child_path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                let stem = name.trim().to_ascii_lowercase();
                if stem.len() == 32 && stem.chars().all(|c| c.is_ascii_hexdigit()) {
                    out.insert(stem);
                }
            }
        }
    }
    out
}

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

fn resolve_matching_legacy_sticker_root(home_dir: &Path, wxid_dir: &str) -> Option<PathBuf> {
    let v4_md5_names = collect_v4_thumb_md5_names(home_dir, wxid_dir);
    if v4_md5_names.is_empty() {
        return None;
    }

    let mut best_path: Option<PathBuf> = None;
    let mut best_overlap = 0usize;
    for sticker_root in find_legacy_sticker_roots(home_dir) {
        let overlap = count_overlap_with_v4_thumbs(&sticker_root.join("Thumbs"), &v4_md5_names);
        if overlap > best_overlap {
            best_overlap = overlap;
            best_path = Some(sticker_root);
        }
    }

    if best_overlap < 20 {
        return None;
    }
    best_path
}

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

fn main() -> anyhow::Result<()> {
    let wxid = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("usage: debug-emoticon-catalog <wxid> <db_key_hex>"))?;
    let key = normalize_hex_key(&std::env::args().nth(2).ok_or_else(|| anyhow::anyhow!("usage: debug-emoticon-catalog <wxid> <db_key_hex>"))?)?;
    let target_package_id = std::env::args()
        .nth(3)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("home not found"))?;
    let emoticon_db = home
        .join("Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files")
        .join(&wxid)
        .join("db_storage/emoticon/emoticon.db");
    let matched_root = resolve_matching_legacy_sticker_root(&home, &wxid);
    let v4_thumb_md5_names = collect_v4_thumb_md5_names(&home, &wxid);
    let v4_persist_md5_names = collect_v4_persist_md5_names(&home, &wxid);
    println!("matched_root={:?}", matched_root);
    println!("v4_thumb_md5_names={}", v4_thumb_md5_names.len());
    println!("v4_persist_md5_names={}", v4_persist_md5_names.len());

    with_decrypted_emoticon_conn(&emoticon_db, &key, |conn| {
        let local_package_ids = matched_root
            .as_ref()
            .map(|root| collect_local_package_ids_from_sticker_root(root))
            .unwrap_or_default();
        println!("local_package_ids={}", local_package_ids.len());

        let columns = query_table_columns(conn, "kStoreEmoticonFilesTable")?;
        println!("kStoreEmoticonFilesTable columns={:?}", columns);
        let package_columns = query_table_columns(conn, "kStoreEmoticonPackageTable")?;
        println!("kStoreEmoticonPackageTable columns={:?}", package_columns);
        if let Some(first_package_id) = local_package_ids.first() {
            let mut stmt = conn.prepare("SELECT * FROM kStoreEmoticonPackageTable WHERE package_id_ = ?1 LIMIT 1")?;
            let col_count = stmt.column_count();
            let col_names: Vec<String> = stmt.column_names().iter().map(|v| (*v).to_string()).collect();
            let mut rows = stmt.query([first_package_id])?;
            if let Some(row) = rows.next()? {
                println!("sample_package_id={}", first_package_id);
                for idx in 0..col_count {
                    let value: Result<Option<String>, _> = row.get(idx);
                    println!("package_col {} {} = {:?}", idx, col_names[idx], value.ok().flatten());
                }
            }
        }
        let package_id_col = pick_existing_column(&columns, &["package_id_", "package_id", "packageId"]).unwrap();
        let md5_col = pick_existing_column(&columns, &["md5_", "md5"]).unwrap();
        let sort_order_col = pick_existing_column(&columns, &["sort_order_", "sort_order"]).unwrap_or_else(|| "rowid".to_string());
        let store_url_columns: Vec<String> = ["cdn_url_", "cdn_url", "url_", "url", "thumb_url_", "thumb_url"]
            .iter()
            .filter(|candidate| columns.contains(**candidate))
            .map(|candidate| (*candidate).to_string())
            .collect();
        println!("store_url_columns={:?}", store_url_columns);

        let thumb_offset_col = pick_existing_column(&columns, &["thumb_offset_"]).unwrap();
        let thumb_size_col = pick_existing_column(&columns, &["thumb_size_"]).unwrap();
        let emoticon_offset_col = pick_existing_column(&columns, &["emoticon_offset_"]).unwrap();
        let emoticon_size_col = pick_existing_column(&columns, &["emoticon_size_"]).unwrap();
        let mut select_columns = vec![
            package_id_col.clone(),
            md5_col.clone(),
            sort_order_col.clone(),
            thumb_offset_col.clone(),
            thumb_size_col.clone(),
            emoticon_offset_col.clone(),
            emoticon_size_col.clone()
        ];
        select_columns.extend(store_url_columns.iter().cloned());
        let sql = format!(
            "SELECT {} FROM kStoreEmoticonFilesTable WHERE {package_id_col} IN ({}) ORDER BY {package_id_col} ASC, {sort_order_col} ASC, {md5_col} ASC",
            select_columns.join(", "),
            build_sql_in_list(&local_package_ids)
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| {
            let package_id = row.get::<_, String>(0)?;
            let md5 = row.get::<_, String>(1)?;
            let sort_order = row.get::<_, i64>(2).unwrap_or(i64::MAX);
            let thumb_offset = row.get::<_, Option<i64>>(3).unwrap_or(None);
            let thumb_size = row.get::<_, Option<i64>>(4).unwrap_or(None);
            let emoticon_offset = row.get::<_, Option<i64>>(5).unwrap_or(None);
            let emoticon_size = row.get::<_, Option<i64>>(6).unwrap_or(None);
            let mut url_fields = Vec::<Option<String>>::new();
            for index in 0..store_url_columns.len() {
                url_fields.push(row.get::<_, Option<String>>(7 + index)?);
            }
            Ok((package_id, md5, sort_order, thumb_offset, thumb_size, emoticon_offset, emoticon_size, url_fields))
        })?;

        if let Some(target_package_id) = target_package_id.as_ref() {
            println!("target_package_id={}", target_package_id);
        }

        let mut printed_samples = 0usize;
        let mut package_counts = HashMap::<String, usize>::new();
        let mut package_remote_counts = HashMap::<String, usize>::new();
        let mut package_preview_counts = HashMap::<String, usize>::new();
        let mut package_offset_preview_counts = HashMap::<String, usize>::new();
        let mut package_v4_thumb_overlap_counts = HashMap::<String, usize>::new();
        let mut package_v4_persist_overlap_counts = HashMap::<String, usize>::new();
        let sticker_root = matched_root.as_ref();
        let thumb_store_root = home
            .join("Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files")
            .join(&wxid)
            .join("business/emoticon/ThumbStore");

        for row in rows {
            let (package_id, md5, sort_order, thumb_offset, thumb_size, emoticon_offset, emoticon_size, url_fields) = row?;
            let package_id = package_id.trim().to_string();
            let md5 = md5.trim().to_ascii_lowercase();
            *package_counts.entry(package_id.clone()).or_insert(0) += 1;
            if v4_thumb_md5_names.contains(&md5) {
                *package_v4_thumb_overlap_counts.entry(package_id.clone()).or_insert(0) += 1;
            }
            if v4_persist_md5_names.contains(&md5) {
                *package_v4_persist_overlap_counts.entry(package_id.clone()).or_insert(0) += 1;
            }
            if let Some(target_package_id) = target_package_id.as_ref() {
                if &package_id == target_package_id {
                    println!(
                        "target_member\t{}\t{}\t{}\t{}\t{}\t{}",
                        md5,
                        sort_order,
                        thumb_offset.map(|value| value.to_string()).unwrap_or_default(),
                        thumb_size.map(|value| value.to_string()).unwrap_or_default(),
                        emoticon_offset.map(|value| value.to_string()).unwrap_or_default(),
                        emoticon_size.map(|value| value.to_string()).unwrap_or_default()
                    );
                }
            }
            if package_id == "com.tencent.xin.emoticon.person.stiker_1477661938836f2998040ab358" && printed_samples < 6 {
                println!(
                    "sample_member md5={} thumb_offset={:?} thumb_size={:?} emoticon_offset={:?} emoticon_size={:?}",
                    md5, thumb_offset, thumb_size, emoticon_offset, emoticon_size
                );
                printed_samples += 1;
            }

            let remote = best_emoticon_url_from_fields(&url_fields);
            if remote.is_some() {
                *package_remote_counts.entry(package_id.clone()).or_insert(0) += 1;
            }

            if let Some(root) = sticker_root {
                let persistence_path = find_persistence_path(root, &md5);
                let thumb_path = find_thumb_path(root, &md5);
                let mut ok = false;
                if let Some(path) = persistence_path.as_ref() {
                    ok = extract_local_preview_file(path, &format!("debug-{package_id}-{md5}-p"))?.is_some();
                }
                if !ok {
                    if let Some(path) = thumb_path.as_ref() {
                        ok = extract_local_preview_file(path, &format!("debug-{package_id}-{md5}-t"))?.is_some();
                    }
                }
                if ok {
                    *package_preview_counts.entry(package_id.clone()).or_insert(0) += 1;
                }
            }

            let package_hash = format!("{:x}", md5::compute(package_id.as_bytes()));
            let package_file = thumb_store_root.join(&package_hash[0..2]).join(&package_hash);
            if package_file.exists() {
                if let (Some(offset), Some(size)) = (thumb_offset, thumb_size) {
                    let data = fs::read(&package_file)?;
                    let start = offset.max(0) as usize;
                    let end = start.saturating_add(size.max(0) as usize);
                    if start < data.len() && end <= data.len() {
                        let slice = &data[start..end];
                        if detect_embedded_image_slice(slice).is_some()
                            || slice.starts_with(&[0xff, 0xd8, 0xff])
                            || slice.starts_with(b"GIF87a")
                            || slice.starts_with(b"GIF89a")
                            || slice.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
                            *package_offset_preview_counts.entry(package_id.clone()).or_insert(0) += 1;
                        }
                    }
                }
            }
        }

        let mut top: Vec<_> = package_counts.clone().into_iter().collect();
        top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        for (package_id, count) in top.into_iter().take(12) {
            println!(
                "package={} total={} remote={} preview={} offset_preview={} ",
                package_id,
                count,
                package_remote_counts.get(&package_id).copied().unwrap_or(0),
                package_preview_counts.get(&package_id).copied().unwrap_or(0),
                package_offset_preview_counts.get(&package_id).copied().unwrap_or(0)
            );
        }

        let total_rows: usize = package_counts.values().sum();
        let total_v4_thumb_overlap: usize = package_v4_thumb_overlap_counts.values().sum();
        let total_v4_persist_overlap: usize = package_v4_persist_overlap_counts.values().sum();
        println!("total_rows={}", total_rows);
        println!("total_v4_thumb_overlap={}", total_v4_thumb_overlap);
        println!("total_v4_persist_overlap={}", total_v4_persist_overlap);

        let mut overlap_top: Vec<_> = package_v4_thumb_overlap_counts.into_iter().collect();
        overlap_top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        for (package_id, count) in overlap_top.into_iter().take(12) {
            println!(
                "package_v4_thumb_overlap={} count={} persist_overlap={}",
                package_id,
                count,
                package_v4_persist_overlap_counts.get(&package_id).copied().unwrap_or(0)
            );
        }

        Ok(())
    })?;

    Ok(())
}
