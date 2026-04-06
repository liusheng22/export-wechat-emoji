use reqwest::blocking::{Client, Response};
use reqwest::header::{
    ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, ETAG, IF_NONE_MATCH, RETRY_AFTER, USER_AGENT,
};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tempfile::NamedTempFile;

const STICKERHUB_BASE_URL: &str = "https://stickerhub.lius.me";
const CACHE_SCHEMA_VERSION: u8 = 1;
const CACHE_FRESH_MILLIS: i64 = 30 * 24 * 60 * 60 * 1_000;
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StickerHubAlbumMember {
    member_index: Option<i64>,
    md5: String,
    preview_url: Option<String>,
    download_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StickerHubAlbumPayload {
    schema_version: u8,
    product_id: String,
    icon_url: Option<String>,
    version: Option<String>,
    members: Vec<StickerHubAlbumMember>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StickerHubAlbumCacheEntry {
    schema_version: u8,
    product_id: String,
    version: Option<String>,
    fetched_at: i64,
    validated_at: i64,
    etag: Option<String>,
    payload: StickerHubAlbumPayload,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StickerHubCacheReadResult {
    status: &'static str,
    payload: Option<StickerHubAlbumPayload>,
    etag: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StickerHubRefreshResult {
    status: &'static str,
    payload: Option<StickerHubAlbumPayload>,
    retry_after_seconds: Option<u64>,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn validate_product_id(product_id: &str) -> bool {
    const PREFIX: &str = "com.tencent.xin.emoticon.";
    let len = product_id.len();
    if len <= PREFIX.len() || len > 512 || !product_id.starts_with(PREFIX) {
        return false;
    }
    product_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn validate_https_url(value: &Option<String>) -> bool {
    let Some(value) = value else {
        return true;
    };
    reqwest::Url::parse(value)
        .map(|url| url.scheme() == "https" && url.host_str().is_some())
        .unwrap_or(false)
}

fn validate_payload(
    payload: &mut StickerHubAlbumPayload,
    expected_product_id: &str,
) -> Result<(), String> {
    if payload.schema_version != CACHE_SCHEMA_VERSION {
        return Err("unsupported schema version".to_string());
    }
    if payload.product_id != expected_product_id {
        return Err("product id mismatch".to_string());
    }
    if !validate_https_url(&payload.icon_url) {
        return Err("invalid icon url".to_string());
    }

    for member in &mut payload.members {
        member.md5.make_ascii_lowercase();
        if member.md5.len() != 32 || !member.md5.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("invalid member md5".to_string());
        }
        if !validate_https_url(&member.preview_url) || !validate_https_url(&member.download_url) {
            return Err("invalid member url".to_string());
        }
    }
    Ok(())
}

fn cache_file_path(cache_dir: &Path, product_id: &str) -> PathBuf {
    let digest = Sha256::digest(product_id.as_bytes());
    cache_dir.join(format!("{}.json", hex::encode(digest)))
}

fn read_cache(cache_dir: &Path, product_id: &str) -> Option<StickerHubAlbumCacheEntry> {
    let path = cache_file_path(cache_dir, product_id);
    let bytes = fs::read(&path).ok()?;
    let mut entry = match serde_json::from_slice::<StickerHubAlbumCacheEntry>(&bytes) {
        Ok(entry) => entry,
        Err(_) => {
            let _ = fs::remove_file(path);
            return None;
        }
    };
    let valid = entry.schema_version == CACHE_SCHEMA_VERSION
        && entry.product_id == product_id
        && entry.payload.product_id == product_id
        && validate_payload(&mut entry.payload, product_id).is_ok();
    if valid {
        Some(entry)
    } else {
        let _ = fs::remove_file(path);
        None
    }
}

fn write_cache(cache_dir: &Path, entry: &StickerHubAlbumCacheEntry) -> Result<(), String> {
    fs::create_dir_all(cache_dir)
        .map_err(|error| format!("failed to create cache dir: {error}"))?;
    let path = cache_file_path(cache_dir, &entry.product_id);
    let mut temp = NamedTempFile::new_in(cache_dir)
        .map_err(|error| format!("failed to create cache temp file: {error}"))?;
    serde_json::to_writer(temp.as_file_mut(), entry)
        .map_err(|error| format!("failed to serialize cache: {error}"))?;
    temp.as_file_mut()
        .flush()
        .map_err(|error| format!("failed to flush cache: {error}"))?;
    temp.persist(path)
        .map_err(|error| format!("failed to persist cache: {}", error.error))?;
    Ok(())
}

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path_resolver()
        .app_data_dir()
        .map(|path| path.join("stickerhub-cache").join("v1"))
        .ok_or_else(|| "failed to resolve app data directory".to_string())
}

fn read_result(cache_dir: &Path, product_id: &str, now: i64) -> StickerHubCacheReadResult {
    let Some(entry) = read_cache(cache_dir, product_id) else {
        return StickerHubCacheReadResult {
            status: "missing",
            payload: None,
            etag: None,
        };
    };
    let age = now.saturating_sub(entry.validated_at);
    StickerHubCacheReadResult {
        status: if age <= CACHE_FRESH_MILLIS {
            "fresh"
        } else {
            "stale"
        },
        payload: Some(entry.payload),
        etag: entry.etag,
    }
}

fn cached_fallback(
    status: &'static str,
    cached: &Option<StickerHubAlbumCacheEntry>,
    retry_after_seconds: Option<u64>,
) -> StickerHubRefreshResult {
    StickerHubRefreshResult {
        status,
        payload: cached.as_ref().map(|entry| entry.payload.clone()),
        retry_after_seconds,
    }
}

fn parse_success_response(
    response: Response,
    product_id: &str,
) -> Result<(StickerHubAlbumPayload, Option<String>), String> {
    let is_json = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or_default().trim() == "application/json")
        .unwrap_or(false);
    if !is_json {
        return Err("unexpected content type".to_string());
    }
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err("response too large".to_string());
    }

    let etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "failed to read response".to_string())?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("response too large".to_string());
    }
    let mut payload = serde_json::from_slice::<StickerHubAlbumPayload>(&bytes)
        .map_err(|_| "invalid response json".to_string())?;
    validate_payload(&mut payload, product_id)?;
    Ok((payload, etag))
}

fn send_request(
    client: &Client,
    base_url: &str,
    product_id: &str,
    etag: Option<&str>,
) -> Result<Response, reqwest::Error> {
    let url = format!(
        "{}/api/integrations/wxemoticon/albums/{}",
        base_url.trim_end_matches('/'),
        product_id
    );
    let mut request = client.get(url).header(ACCEPT, "application/json").header(
        USER_AGENT,
        format!("wxemoticon/{}", env!("CARGO_PKG_VERSION")),
    );
    if let Some(etag) = etag {
        request = request.header(IF_NONE_MATCH, etag);
    }
    request.send()
}

fn refresh_with_client(
    cache_dir: &Path,
    product_id: &str,
    base_url: &str,
    client: &Client,
) -> StickerHubRefreshResult {
    if !validate_product_id(product_id) {
        return cached_fallback("invalid_request", &None, None);
    }

    let mut cached = read_cache(cache_dir, product_id);
    let first = send_request(
        client,
        base_url,
        product_id,
        cached.as_ref().and_then(|entry| entry.etag.as_deref()),
    );
    let mut response = match first {
        Ok(response) => response,
        Err(error) => {
            let status = if error.is_connect() || error.is_timeout() {
                "offline"
            } else {
                "error"
            };
            return cached_fallback(status, &cached, None);
        }
    };

    if response.status() == StatusCode::NOT_MODIFIED {
        if let Some(mut entry) = cached.take() {
            entry.validated_at = now_millis();
            let payload = entry.payload.clone();
            let _ = write_cache(cache_dir, &entry);
            return StickerHubRefreshResult {
                status: "ready",
                payload: Some(payload),
                retry_after_seconds: None,
            };
        }
        response = match send_request(client, base_url, product_id, None) {
            Ok(response) => response,
            Err(error) => {
                let status = if error.is_connect() || error.is_timeout() {
                    "offline"
                } else {
                    "error"
                };
                return cached_fallback(status, &None, None);
            }
        };
    }

    match response.status() {
        StatusCode::OK => match parse_success_response(response, product_id) {
            Ok((payload, etag)) => {
                let now = now_millis();
                let entry = StickerHubAlbumCacheEntry {
                    schema_version: CACHE_SCHEMA_VERSION,
                    product_id: product_id.to_string(),
                    version: payload.version.clone(),
                    fetched_at: now,
                    validated_at: now,
                    etag,
                    payload: payload.clone(),
                };
                let _ = write_cache(cache_dir, &entry);
                StickerHubRefreshResult {
                    status: "ready",
                    payload: Some(payload),
                    retry_after_seconds: None,
                }
            }
            Err(_) => cached_fallback("error", &cached, None),
        },
        StatusCode::BAD_REQUEST => cached_fallback("invalid_request", &None, None),
        StatusCode::NOT_FOUND => cached_fallback("not_found", &None, None),
        StatusCode::TOO_MANY_REQUESTS => {
            let retry_after = response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(60);
            cached_fallback("rate_limited", &cached, Some(retry_after))
        }
        status if status.is_server_error() => cached_fallback("error", &cached, None),
        _ => cached_fallback("error", &cached, None),
    }
}

#[tauri::command]
pub(crate) fn read_stickerhub_album_cache(
    app: tauri::AppHandle,
    product_id: String,
) -> Result<StickerHubCacheReadResult, String> {
    let product_id = product_id.trim();
    if !validate_product_id(product_id) {
        return Ok(StickerHubCacheReadResult {
            status: "missing",
            payload: None,
            etag: None,
        });
    }
    Ok(read_result(&cache_dir(&app)?, product_id, now_millis()))
}

#[tauri::command]
pub(crate) async fn refresh_stickerhub_album(
    app: tauri::AppHandle,
    product_id: String,
) -> Result<StickerHubRefreshResult, String> {
    let cache_dir = cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "failed to initialize StickerHub client".to_string())?;
        Ok(refresh_with_client(
            &cache_dir,
            product_id.trim(),
            STICKERHUB_BASE_URL,
            &client,
        ))
    })
    .await
    .map_err(|_| "StickerHub refresh task failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{self, Receiver};
    use std::thread;

    const PRODUCT_ID: &str = "com.tencent.xin.emoticon.person.test_album";
    const MD5: &str = "84fca82941e003784f71b99100f672ea";

    fn payload() -> StickerHubAlbumPayload {
        StickerHubAlbumPayload {
            schema_version: 1,
            product_id: PRODUCT_ID.to_string(),
            icon_url: Some("https://cdn.example.com/icon.png".to_string()),
            version: Some("opaque-version".to_string()),
            members: vec![StickerHubAlbumMember {
                member_index: Some(1),
                md5: MD5.to_string(),
                preview_url: Some("https://cdn.example.com/preview.gif".to_string()),
                download_url: Some("https://cdn.example.com/full.gif".to_string()),
            }],
        }
    }

    fn entry(validated_at: i64) -> StickerHubAlbumCacheEntry {
        StickerHubAlbumCacheEntry {
            schema_version: 1,
            product_id: PRODUCT_ID.to_string(),
            version: Some("opaque-version".to_string()),
            fetched_at: validated_at,
            validated_at,
            etag: Some("\"etag-1\"".to_string()),
            payload: payload(),
        }
    }

    fn test_client() -> Client {
        Client::builder()
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap()
    }

    fn start_http_fixture(responses: Vec<String>) -> (String, Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0u8; 8192];
                let size = stream.read(&mut request).unwrap_or(0);
                let _ = sender.send(String::from_utf8_lossy(&request[..size]).to_string());
                stream.write_all(response.as_bytes()).unwrap();
                stream.flush().unwrap();
            }
        });
        (format!("http://{address}"), receiver)
    }

    fn json_response(payload: &StickerHubAlbumPayload) -> String {
        let body = serde_json::to_string(payload).unwrap();
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nETag: \"etag-2\"\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    #[test]
    fn validates_contract_fields() {
        let mut valid = payload();
        assert!(validate_payload(&mut valid, PRODUCT_ID).is_ok());

        let mut invalid_schema = payload();
        invalid_schema.schema_version = 2;
        assert!(validate_payload(&mut invalid_schema, PRODUCT_ID).is_err());

        let mut invalid_md5 = payload();
        invalid_md5.members[0].md5 = "not-md5".to_string();
        assert!(validate_payload(&mut invalid_md5, PRODUCT_ID).is_err());

        let mut invalid_url = payload();
        invalid_url.members[0].preview_url = Some("http://cdn.example.com/a.gif".to_string());
        assert!(validate_payload(&mut invalid_url, PRODUCT_ID).is_err());
    }

    #[test]
    fn cache_uses_hash_filename_and_reports_fresh_or_stale() {
        let dir = tempfile::tempdir().unwrap();
        let now = now_millis();
        write_cache(dir.path(), &entry(now)).unwrap();
        let path = cache_file_path(dir.path(), PRODUCT_ID);
        assert_eq!(path.file_name().unwrap().to_string_lossy().len(), 69);
        assert!(!path.to_string_lossy().contains(PRODUCT_ID));
        assert_eq!(read_result(dir.path(), PRODUCT_ID, now).status, "fresh");

        write_cache(dir.path(), &entry(now - CACHE_FRESH_MILLIS - 1)).unwrap();
        assert_eq!(read_result(dir.path(), PRODUCT_ID, now).status, "stale");
    }

    #[test]
    fn corrupt_or_mismatched_cache_is_discarded() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path()).unwrap();
        let path = cache_file_path(dir.path(), PRODUCT_ID);
        fs::write(&path, b"not-json").unwrap();
        assert!(read_cache(dir.path(), PRODUCT_ID).is_none());

        let mut mismatched = entry(now_millis());
        mismatched.product_id = "com.tencent.xin.emoticon.other".to_string();
        fs::write(&path, serde_json::to_vec(&mismatched).unwrap()).unwrap();
        assert!(read_cache(dir.path(), PRODUCT_ID).is_none());
        assert!(!path.exists());
    }

    #[test]
    fn successful_response_is_validated_and_cached() {
        let dir = tempfile::tempdir().unwrap();
        let expected = payload();
        let (base_url, requests) = start_http_fixture(vec![json_response(&expected)]);

        let result = refresh_with_client(dir.path(), PRODUCT_ID, &base_url, &test_client());
        assert_eq!(result.status, "ready");
        assert_eq!(result.payload, Some(expected));
        assert!(read_cache(dir.path(), PRODUCT_ID).is_some());
        let request = requests.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(request.starts_with(&format!(
            "GET /api/integrations/wxemoticon/albums/{PRODUCT_ID} HTTP/1.1"
        )));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
        assert!(!request.to_ascii_lowercase().contains("x-api-key:"));
    }

    #[test]
    fn stale_cache_sends_etag_and_304_revalidates_it() {
        let dir = tempfile::tempdir().unwrap();
        let old = now_millis() - CACHE_FRESH_MILLIS - 1;
        write_cache(dir.path(), &entry(old)).unwrap();
        let response = "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".to_string();
        let (base_url, requests) = start_http_fixture(vec![response]);

        let result = refresh_with_client(dir.path(), PRODUCT_ID, &base_url, &test_client());
        assert_eq!(result.status, "ready");
        assert_eq!(result.payload, Some(payload()));
        let request = requests
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .to_ascii_lowercase();
        assert!(request.contains("if-none-match: \"etag-1\""));
        assert_eq!(
            read_result(dir.path(), PRODUCT_ID, now_millis()).status,
            "fresh"
        );
    }

    #[test]
    fn cacheless_304_retries_once_without_etag() {
        let dir = tempfile::tempdir().unwrap();
        let first = "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".to_string();
        let second = json_response(&payload());
        let (base_url, requests) = start_http_fixture(vec![first, second]);

        let result = refresh_with_client(dir.path(), PRODUCT_ID, &base_url, &test_client());
        assert_eq!(result.status, "ready");
        let first_request = requests.recv_timeout(Duration::from_secs(2)).unwrap();
        let second_request = requests.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(!first_request
            .to_ascii_lowercase()
            .contains("if-none-match:"));
        assert!(!second_request
            .to_ascii_lowercase()
            .contains("if-none-match:"));
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn network_failure_keeps_stale_payload() {
        let dir = tempfile::tempdir().unwrap();
        write_cache(dir.path(), &entry(now_millis() - CACHE_FRESH_MILLIS - 1)).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);

        let result = refresh_with_client(
            dir.path(),
            PRODUCT_ID,
            &format!("http://{address}"),
            &test_client(),
        );
        assert_eq!(result.status, "offline");
        assert_eq!(result.payload, Some(payload()));
    }

    #[test]
    fn invalid_json_is_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 8\r\nConnection: close\r\n\r\nnot-json".to_string();
        let (base_url, _) = start_http_fixture(vec![response]);

        let result = refresh_with_client(dir.path(), PRODUCT_ID, &base_url, &test_client());
        assert_eq!(result.status, "error");
        assert!(result.payload.is_none());
        assert!(read_cache(dir.path(), PRODUCT_ID).is_none());
    }

    #[test]
    fn rate_limit_preserves_cache_and_retry_after() {
        let dir = tempfile::tempdir().unwrap();
        write_cache(dir.path(), &entry(now_millis() - CACHE_FRESH_MILLIS - 1)).unwrap();
        let response = "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 45\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string();
        let (base_url, _) = start_http_fixture(vec![response]);

        let result = refresh_with_client(dir.path(), PRODUCT_ID, &base_url, &test_client());
        assert_eq!(result.status, "rate_limited");
        assert_eq!(result.retry_after_seconds, Some(45));
        assert_eq!(result.payload, Some(payload()));
    }
}
