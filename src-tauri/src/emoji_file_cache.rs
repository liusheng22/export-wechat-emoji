use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tempfile::NamedTempFile;

const EMOJI_FILE_CACHE_DIR: &str = "emoji-files/v1";
const MAX_EMOJI_FILE_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const EMOJI_FILE_EXTENSIONS: [&str; 4] = ["gif", "png", "webp", "jpg"];

#[cfg(target_os = "macos")]
fn copy_file_url_to_clipboard(path: &Path) -> Result<(), String> {
    use cocoa::appkit::NSPasteboard;
    use cocoa::base::{nil, YES};
    use cocoa::foundation::{NSArray, NSAutoreleasePool, NSString, NSURL};

    if !path.is_file() {
        return Err(format!("cached image file not found: {}", path.display()));
    }
    let path_text = path
        .to_str()
        .ok_or_else(|| "cached image path is not valid UTF-8".to_string())?;

    unsafe {
        let pool = NSAutoreleasePool::new(nil);
        let pasteboard = NSPasteboard::generalPasteboard(nil);
        let ns_path = NSString::alloc(nil).init_str(path_text);
        let file_url = NSURL::fileURLWithPath_(nil, ns_path);
        let objects = NSArray::arrayWithObject(nil, file_url);
        pasteboard.clearContents();
        let written = pasteboard.writeObjects(objects);
        pool.drain();
        if written != YES {
            return Err("macOS pasteboard rejected the cached image file".to_string());
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn copy_file_url_to_clipboard(_path: &Path) -> Result<(), String> {
    Err("copying image files is currently supported only on macOS".to_string())
}

fn normalize_emoji_file_cache_url(source_url: &str) -> Result<String, String> {
    let source_url = source_url.trim();
    if source_url.is_empty() {
        return Err("source URL is empty".to_string());
    }
    let lowercase = source_url.to_ascii_lowercase();
    if let Some(query_index) = lowercase.find('?') {
        let path = &lowercase[..query_index];
        for suffix in [".gif", ".png", ".webp", ".jpg", ".jpeg"] {
            let marker = format!("/stodownload{suffix}");
            if path.ends_with(&marker) {
                let suffix_start = query_index - suffix.len();
                return Ok(format!(
                    "{}{}",
                    &source_url[..suffix_start],
                    &source_url[query_index..]
                ));
            }
        }
    }
    Ok(source_url.to_string())
}

fn emoji_file_cache_key(source_url: &str) -> Result<String, String> {
    let normalized = normalize_emoji_file_cache_url(source_url)?;
    let digest = <sha2::Sha256 as sha2::Digest>::digest(normalized.as_bytes());
    Ok(hex::encode(digest))
}

fn image_ext_from_bytes(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("gif");
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("png");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("jpg");
    }
    None
}

fn cached_emoji_file_path(
    cache_root: &Path,
    source_url: &str,
    ext: &str,
) -> Result<PathBuf, String> {
    if !EMOJI_FILE_EXTENSIONS.contains(&ext) {
        return Err(format!("unsupported image extension: {ext}"));
    }
    Ok(cache_root.join(format!("{}.{}", emoji_file_cache_key(source_url)?, ext)))
}

fn find_cached_emoji_file(cache_root: &Path, source_url: &str) -> Result<Option<PathBuf>, String> {
    let key = emoji_file_cache_key(source_url)?;
    for ext in EMOJI_FILE_EXTENSIONS {
        let path = cache_root.join(format!("{key}.{ext}"));
        if path.is_file() {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn persist_cached_emoji_file(
    cache_root: &Path,
    source_url: &str,
    bytes: &[u8],
    expected_ext: &str,
) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("image data is empty".to_string());
    }
    let detected_ext = image_ext_from_bytes(bytes)
        .ok_or_else(|| "cached image format could not be detected".to_string())?;
    if detected_ext != expected_ext {
        return Err(format!(
            "image extension mismatch: expected {expected_ext}, detected {detected_ext}"
        ));
    }
    std::fs::create_dir_all(cache_root)
        .map_err(|e| format!("failed to create emoji cache directory: {e}"))?;
    let destination = cached_emoji_file_path(cache_root, source_url, detected_ext)?;
    if destination.is_file() {
        return Ok(destination);
    }

    let mut temporary = NamedTempFile::new_in(cache_root)
        .map_err(|e| format!("failed to create temporary emoji cache file: {e}"))?;
    temporary
        .write_all(bytes)
        .map_err(|e| format!("failed to write emoji cache file: {e}"))?;
    temporary
        .flush()
        .map_err(|e| format!("failed to flush emoji cache file: {e}"))?;
    temporary
        .persist(&destination)
        .map_err(|e| format!("failed to persist emoji cache file: {}", e.error))?;
    Ok(destination)
}

fn prune_emoji_file_cache(cache_root: &Path, protected_path: &Path, max_bytes: u64) {
    let Ok(entries) = std::fs::read_dir(cache_root) else {
        return;
    };
    let mut files = Vec::<(PathBuf, u64, u128)>::new();
    let mut total_bytes = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        if !EMOJI_FILE_EXTENSIONS.contains(&ext) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let len = metadata.len();
        let modified = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis())
            .unwrap_or(0);
        total_bytes = total_bytes.saturating_add(len);
        files.push((path, len, modified));
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, len, _) in files {
        if total_bytes <= max_bytes {
            break;
        }
        if path == protected_path {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total_bytes = total_bytes.saturating_sub(len);
        }
    }
}

fn emoji_file_cache_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path_resolver()
        .app_cache_dir()
        .map(|path| path.join(EMOJI_FILE_CACHE_DIR))
        .ok_or_else(|| "failed to resolve app cache directory".to_string())
}

#[tauri::command]
pub(crate) fn copy_cached_emoji_file(
    app: tauri::AppHandle,
    source_url: String,
) -> Result<bool, String> {
    let cache_root = emoji_file_cache_root(&app)?;
    let Some(path) = find_cached_emoji_file(&cache_root, &source_url)? else {
        return Ok(false);
    };
    copy_file_url_to_clipboard(&path)?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn cache_and_copy_emoji_file(
    app: tauri::AppHandle,
    source_url: String,
    bytes: Vec<u8>,
    ext: String,
) -> Result<String, String> {
    let cache_root = emoji_file_cache_root(&app)?;
    let path = persist_cached_emoji_file(&cache_root, &source_url, &bytes, &ext)?;
    prune_emoji_file_cache(&cache_root, &path, MAX_EMOJI_FILE_CACHE_BYTES);
    copy_file_url_to_clipboard(&path)?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_original_image_formats() {
        assert_eq!(image_ext_from_bytes(b"GIF89a"), Some("gif"));
        assert_eq!(
            image_ext_from_bytes(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
            Some("png")
        );
        assert_eq!(image_ext_from_bytes(b"RIFF1234WEBP"), Some("webp"));
        assert_eq!(image_ext_from_bytes(&[0xff, 0xd8, 0xff]), Some("jpg"));
        assert_eq!(image_ext_from_bytes(b"not-an-image"), None);
    }

    #[test]
    fn persists_and_finds_a_stable_cross_session_cache_file() {
        let cache_root = tempfile::tempdir().unwrap();
        let source_url = "https://example.com/stodownload?m=stable";
        let bytes = b"GIF89a";

        let path = persist_cached_emoji_file(cache_root.path(), source_url, bytes, "gif")
            .expect("cache write should succeed");

        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("gif")
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(
            find_cached_emoji_file(cache_root.path(), source_url).unwrap(),
            Some(path)
        );
    }

    #[test]
    fn normalizes_stodownload_suffixes_to_the_same_disk_cache_key() {
        let raw = emoji_file_cache_key("https://example.com/stodownload?m=same").unwrap();
        let suffixed = emoji_file_cache_key("https://example.com/stodownload.gif?m=same").unwrap();

        assert_eq!(raw, suffixed);
    }

    #[test]
    fn rejects_an_extension_that_does_not_match_the_file_bytes() {
        let cache_root = tempfile::tempdir().unwrap();
        let error = persist_cached_emoji_file(
            cache_root.path(),
            "https://example.com/stodownload?m=mismatch",
            b"GIF89a",
            "png",
        )
        .unwrap_err();

        assert!(error.contains("expected png, detected gif"));
    }

    #[test]
    fn prunes_old_files_without_removing_the_file_being_copied() {
        let cache_root = tempfile::tempdir().unwrap();
        let old_a = cache_root.path().join("old-a.gif");
        let old_b = cache_root.path().join("old-b.gif");
        let protected = cache_root.path().join("protected.gif");
        std::fs::write(&old_a, b"GIF89a").unwrap();
        std::fs::write(&old_b, b"GIF89a").unwrap();
        std::fs::write(&protected, b"GIF89a").unwrap();

        prune_emoji_file_cache(cache_root.path(), &protected, 6);

        assert!(protected.is_file());
        assert!(!old_a.exists());
        assert!(!old_b.exists());
    }
}
