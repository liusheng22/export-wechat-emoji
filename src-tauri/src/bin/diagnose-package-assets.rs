use aes::Aes256;
use cbc::cipher::block_padding::NoPadding;
use cbc::cipher::{BlockDecryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac_array;
use rusqlite::Connection;
use serde::Serialize;
use sha2::Sha512;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

#[derive(Serialize)]
struct SourceDiag {
    path: String,
    exists: bool,
    embedded: Option<String>,
    rebuild: Option<RebuildDiag>,
    size: Option<usize>,
}

#[derive(Serialize)]
struct RebuildDiag {
    width: usize,
    height: usize,
    color_type: u8,
}

#[derive(Serialize)]
struct MemberDiag {
    md5: String,
    sort_order: Option<i64>,
    thumb_offset: Option<i64>,
    thumb_size: Option<i64>,
    emoticon_offset: Option<i64>,
    emoticon_size: Option<i64>,
    legacy_thumb: SourceDiag,
    legacy_persist: SourceDiag,
    v4_thumb: SourceDiag,
    v4_persist: SourceDiag,
}

#[derive(Serialize)]
struct PackageSummary {
    package_id: String,
    package_name: String,
    member_count: usize,
    legacy_thumb_hits: usize,
    legacy_persist_hits: usize,
    v4_thumb_hits: usize,
    v4_persist_hits: usize,
    rebuildable_legacy_thumb: usize,
    rebuildable_v4_thumb: usize,
    embedded_v4_persist: usize,
}

#[derive(Serialize)]
struct Output {
    summary: PackageSummary,
    diagnostics: Vec<MemberDiag>,
}

fn normalize_hex_key(input: &str) -> anyhow::Result<String> {
    let trimmed = input.trim();
    let no_prefix = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X"));
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

fn with_decrypted_emoticon_conn<T, F>(emoticon_db_path: &Path, db_key: &str, f: F) -> anyhow::Result<T>
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

fn detect_embedded_image_slice(data: &[u8]) -> Option<&'static str> {
    if data.windows(8).any(|w| w == b"\x89PNG\r\n\x1a\n") {
        return Some("png");
    }
    if data.windows(6).any(|w| w == b"GIF87a" || w == b"GIF89a") {
        return Some("gif");
    }
    if data.windows(3).any(|w| w == [0xff, 0xd8, 0xff]) {
        return Some("jpg");
    }
    if data.windows(4).any(|w| w == b"RIFF") && data.windows(4).any(|w| w == b"WEBP") {
        return Some("webp");
    }
    None
}

fn try_rebuild_thumb(data: &[u8]) -> Option<RebuildDiag> {
    let idat_offset = data.windows(4).position(|w| w == b"IDAT")?;
    if idat_offset < 4 || data.windows(4).position(|w| w == b"IEND").is_none() {
        return None;
    }
    let idat_len = u32::from_be_bytes(data[idat_offset - 4..idat_offset].try_into().ok()?) as usize;
    let start = idat_offset + 4;
    let end = start.checked_add(idat_len)?;
    if end > data.len() {
        return None;
    }
    let raw = miniz_oxide::inflate::decompress_to_vec_zlib(&data[start..end]).ok()?;
    let candidates = [
        (120usize, 120usize, 0u8, 1usize),
        (60, 120, 4, 2),
        (40, 120, 2, 3),
        (30, 120, 6, 4),
        (241, 60, 0, 1),
        (362, 40, 0, 1),
        (483, 30, 0, 1),
        (180, 120, 4, 2),
        (90, 120, 6, 4),
    ];
    for (width, height, color_type, bpp) in candidates {
        let row_bytes = 1 + width * bpp;
        if raw.len() != row_bytes * height {
            continue;
        }
        let mut valid = true;
        let mut offset = 0usize;
        while offset < raw.len() {
            if raw[offset] > 4 {
                valid = false;
                break;
            }
            offset += row_bytes;
        }
        if valid {
            return Some(RebuildDiag { width, height, color_type });
        }
    }
    None
}

fn diag_source(path: PathBuf) -> SourceDiag {
    if !path.exists() {
        return SourceDiag {
            path: path.display().to_string(),
            exists: false,
            embedded: None,
            rebuild: None,
            size: None,
        };
    }
    let data = fs::read(&path).unwrap_or_default();
    SourceDiag {
        path: path.display().to_string(),
        exists: true,
        embedded: detect_embedded_image_slice(&data).map(|v| v.to_string()),
        rebuild: try_rebuild_thumb(&data),
        size: Some(data.len()),
    }
}

fn main() -> anyhow::Result<()> {
    let wxid = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("usage: diagnose-package-assets <wxid> <db_key_hex> <package_name_keyword>"))?;
    let key = normalize_hex_key(&std::env::args().nth(2).ok_or_else(|| anyhow::anyhow!("usage: diagnose-package-assets <wxid> <db_key_hex> <package_name_keyword>"))?)?;
    let keyword = std::env::args().nth(3).ok_or_else(|| anyhow::anyhow!("usage: diagnose-package-assets <wxid> <db_key_hex> <package_name_keyword>"))?;

    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| anyhow::anyhow!("home not found"))?;
    let emoticon_db = home
        .join("Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files")
        .join(&wxid)
        .join("db_storage/emoticon/emoticon.db");
    let legacy_sticker_root = home
        .join("Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9/f10006bbb0337947becf60e8c2b34a36/Stickers");
    let v4_thumb_root = home
        .join("Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files")
        .join(&wxid)
        .join("business/emoticon/Thumb");
    let v4_persist_root = home
        .join("Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files")
        .join(&wxid)
        .join("business/emoticon/Persist");

    let out = with_decrypted_emoticon_conn(&emoticon_db, &key, |conn| {
        let mut stmt = conn.prepare(
            "SELECT package_id_, package_name_ FROM kStoreEmoticonPackageTable WHERE package_name_ LIKE ?1 ORDER BY package_name_ ASC"
        )?;
        let package_like = format!("%{}%", keyword);
        let packages = stmt.query_map([package_like], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;

        let mut target: Option<(String, String)> = None;
        for row in packages {
            let row = row?;
            if row.1.contains(&keyword) {
                target = Some(row);
                break;
            }
            if target.is_none() {
                target = Some(row);
            }
        }
        let (package_id, package_name) = target.ok_or_else(|| anyhow::anyhow!("package not found for keyword: {}", keyword))?;

        let mut member_stmt = conn.prepare(
            "SELECT md5_, sort_order_, thumb_offset_, thumb_size_, emoticon_offset_, emoticon_size_ FROM kStoreEmoticonFilesTable WHERE package_id_ = ?1 ORDER BY sort_order_ ASC, md5_ ASC"
        )?;
        let rows = member_stmt.query_map([package_id.clone()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        })?;

        let mut diagnostics = Vec::<MemberDiag>::new();
        for row in rows {
            let (md5, sort_order, thumb_offset, thumb_size, emoticon_offset, emoticon_size) = row?;
            let md5 = md5.trim().to_ascii_lowercase();
            let prefix = &md5[0..2];
            diagnostics.push(MemberDiag {
                md5: md5.clone(),
                sort_order,
                thumb_offset,
                thumb_size,
                emoticon_offset,
                emoticon_size,
                legacy_thumb: diag_source(legacy_sticker_root.join("Thumbs").join(format!("{}.thumb", md5))),
                legacy_persist: diag_source(legacy_sticker_root.join("Persistence").join(&md5)),
                v4_thumb: diag_source(v4_thumb_root.join(prefix).join(format!("{}.thumb", md5))),
                v4_persist: diag_source(v4_persist_root.join(prefix).join(&md5)),
            });
        }

        let summary = PackageSummary {
            package_id,
            package_name,
            member_count: diagnostics.len(),
            legacy_thumb_hits: diagnostics.iter().filter(|x| x.legacy_thumb.exists).count(),
            legacy_persist_hits: diagnostics.iter().filter(|x| x.legacy_persist.exists).count(),
            v4_thumb_hits: diagnostics.iter().filter(|x| x.v4_thumb.exists).count(),
            v4_persist_hits: diagnostics.iter().filter(|x| x.v4_persist.exists).count(),
            rebuildable_legacy_thumb: diagnostics.iter().filter(|x| x.legacy_thumb.rebuild.is_some()).count(),
            rebuildable_v4_thumb: diagnostics.iter().filter(|x| x.v4_thumb.rebuild.is_some()).count(),
            embedded_v4_persist: diagnostics.iter().filter(|x| x.v4_persist.embedded.is_some()).count(),
        };

        Ok(Output { summary, diagnostics })
    })?;

    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
