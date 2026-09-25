//! Cross-platform helpers for locating and verifying WeChat 4.x emoticon db keys.
//!
//! The WeChat 4.x SQLCipher wrapper receives its key as a `x'<hex>'` pragma
//! string, so scanning process memory for that pattern yields candidate keys
//! that can be verified offline against the first page of `emoticon.db`.

use anyhow::Context;
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac_array;
use sha2::Sha512;
use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct KeyCandidate {
    pub(crate) key: [u8; 32],
    pub(crate) salt: Option<[u8; 16]>,
}

fn decode_hex_array<const N: usize>(value: &[u8]) -> Option<[u8; N]> {
    if value.len() != N * 2 || !value.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    let decoded = hex::decode(value).ok()?;
    decoded.try_into().ok()
}

pub(crate) fn extract_key_candidates(data: &[u8]) -> Vec<KeyCandidate> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = 0usize;

    while cursor + 3 <= data.len() {
        let Some(relative_start) = data[cursor..].windows(2).position(|pair| pair == b"x'") else {
            break;
        };
        let value_start = cursor + relative_start + 2;
        let search_end = (value_start + 193).min(data.len());
        let Some(relative_end) = data[value_start..search_end]
            .iter()
            .position(|byte| *byte == b'\'')
        else {
            cursor = value_start;
            continue;
        };
        let value_end = value_start + relative_end;
        let value = &data[value_start..value_end];
        cursor = value_end + 1;

        if !(64..=192).contains(&value.len()) || !value.len().is_multiple_of(2) {
            continue;
        }
        let Some(key) = decode_hex_array::<32>(&value[..64]) else {
            continue;
        };
        let salt = if value.len() >= 96 {
            decode_hex_array::<16>(&value[value.len() - 32..])
        } else {
            None
        };
        let candidate = KeyCandidate { key, salt };
        if seen.insert(candidate) {
            out.push(candidate);
        }
    }
    out
}

#[cfg(test)]
pub(crate) fn extract_key_candidates_from_chunks<I>(chunks: I) -> Vec<KeyCandidate>
where
    I: IntoIterator<Item = Vec<u8>>,
{
    const OVERLAP: usize = 256;
    let mut tail = Vec::new();
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for chunk in chunks {
        tail.extend_from_slice(&chunk);
        for candidate in extract_key_candidates(&tail) {
            if seen.insert(candidate) {
                out.push(candidate);
            }
        }
        if tail.len() > OVERLAP {
            tail.drain(..tail.len() - OVERLAP);
        }
    }
    out
}

pub(crate) fn read_database_page(path: &Path) -> anyhow::Result<[u8; 4096]> {
    let mut page = [0u8; 4096];
    let mut file =
        File::open(path).with_context(|| format!("读取 emoticon.db 失败：{}", path.display()))?;
    file.read_exact(&mut page)
        .with_context(|| format!("读取 emoticon.db 首页失败：{}", path.display()))?;
    Ok(page)
}

pub(crate) fn verify_raw_key(page: &[u8; 4096], key: &[u8; 32]) -> bool {
    const SALT_SIZE: usize = 16;
    const IV_SIZE: usize = 16;
    const HMAC_SIZE: usize = 64;
    const RESERVED_SIZE: usize = 80;

    let salt = &page[..SALT_SIZE];
    let mac_salt: Vec<u8> = salt.iter().map(|byte| byte ^ 0x3a).collect();
    let mac_key = pbkdf2_hmac_array::<Sha512, 32>(key, &mac_salt, 2);
    let iv_start = page.len() - RESERVED_SIZE;
    let stored_hmac_start = iv_start + IV_SIZE;
    let mut mac = match Hmac::<Sha512>::new_from_slice(&mac_key) {
        Ok(mac) => mac,
        Err(_) => return false,
    };
    mac.update(&page[SALT_SIZE..stored_hmac_start]);
    mac.update(&1u32.to_le_bytes());
    mac.verify_slice(&page[stored_hmac_start..stored_hmac_start + HMAC_SIZE])
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanner_extracts_raw_key_and_matching_salt() {
        let key = "11".repeat(32);
        let salt = "ab".repeat(16);
        let bytes = format!("noise x'{key}{salt}' tail");

        let candidates = extract_key_candidates(bytes.as_bytes());

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].key, [0x11; 32]);
        assert_eq!(candidates[0].salt, Some([0xab; 16]));
    }

    #[test]
    fn scanner_deduplicates_plain_raw_keys() {
        let key = "42".repeat(32);
        let bytes = format!("x'{key}' x'{key}'");

        let candidates = extract_key_candidates(bytes.as_bytes());

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].key, [0x42; 32]);
        assert_eq!(candidates[0].salt, None);
    }

    #[test]
    fn scanner_rejects_non_hex_and_wrong_length_values() {
        let bytes =
            b"x'not-a-key' x'0011' x'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'";

        assert!(extract_key_candidates(bytes).is_empty());
    }

    #[test]
    fn chunk_scanner_preserves_pattern_across_boundaries() {
        let key = "7f".repeat(32);
        let salt = "08".repeat(16);
        let bytes = format!("prefix-x'{key}{salt}'-suffix").into_bytes();
        let chunks = vec![
            bytes[..31].to_vec(),
            bytes[31..73].to_vec(),
            bytes[73..].to_vec(),
        ];

        let candidates = extract_key_candidates_from_chunks(chunks);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].key, [0x7f; 32]);
        assert_eq!(candidates[0].salt, Some([0x08; 16]));
    }

    #[test]
    fn raw_key_is_verified_against_database_page_hmac() {
        let key = [0x33; 32];
        let mut page = [0u8; 4096];
        for (index, byte) in page[..4032].iter_mut().enumerate() {
            *byte = (index % 251) as u8;
        }
        let salt = page[..16].to_vec();
        let mac_salt: Vec<u8> = salt.iter().map(|byte| byte ^ 0x3a).collect();
        let mac_key = pbkdf2_hmac_array::<Sha512, 32>(&key, &mac_salt, 2);
        let mut mac = Hmac::<Sha512>::new_from_slice(&mac_key).unwrap();
        mac.update(&page[16..4032]);
        mac.update(&1u32.to_le_bytes());
        page[4032..].copy_from_slice(&mac.finalize().into_bytes());

        assert!(verify_raw_key(&page, &key));
        assert!(!verify_raw_key(&page, &[0x44; 32]));
    }
}
