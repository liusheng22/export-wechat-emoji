use anyhow::{anyhow, Context};
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SESSION_TOKEN_ENV: &str = "WXEMOTICON_SESSION_TOKEN";

use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac_array;
use sha2::Sha512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MemoryRegion {
    pub(crate) start: u64,
    pub(crate) end: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct KeyCandidate {
    pub(crate) key: [u8; 32],
    pub(crate) salt: Option<[u8; 16]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessIdentity {
    pid: u32,
    process_group: u32,
    start_time: u64,
    executable: PathBuf,
}

fn xdg_documents_dir(home: &Path, config_home: Option<&Path>) -> Option<PathBuf> {
    let config_dir = config_home
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".config"));
    let config = std::fs::read_to_string(config_dir.join("user-dirs.dirs")).ok()?;
    let value = config.lines().find_map(|line| {
        line.trim()
            .strip_prefix("XDG_DOCUMENTS_DIR=")
            .map(str::trim)
    })?;
    let value = value.strip_prefix('"')?.strip_suffix('"')?;
    if let Some(relative) = value.strip_prefix("$HOME/") {
        return Some(home.join(relative));
    }
    let path = PathBuf::from(value);
    path.is_absolute().then_some(path)
}

pub(crate) fn parse_readable_regions(maps: &str) -> Vec<MemoryRegion> {
    maps.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let range = parts.next()?;
            let permissions = parts.next()?;
            if !permissions.starts_with('r') {
                return None;
            }
            let (start, end) = range.split_once('-')?;
            let start = u64::from_str_radix(start, 16).ok()?;
            let end = u64::from_str_radix(end, 16).ok()?;
            (end > start).then_some(MemoryRegion { start, end })
        })
        .collect()
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

pub(crate) fn is_wechat_process_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "wechat" | "wechatappex" | "weixin"
    )
}

fn process_name(pid: u32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|name| name.trim().to_string())
}

fn parse_process_stat(pid: u32, stat: &str, executable: PathBuf) -> Option<ProcessIdentity> {
    let close_paren = stat.rfind(')')?;
    let fields: Vec<&str> = stat.get(close_paren + 1..)?.split_whitespace().collect();
    // The slice starts at field 3 (state): pgrp is field 5, starttime is field 22.
    let process_group = fields.get(2)?.parse().ok()?;
    let start_time = fields.get(19)?.parse().ok()?;
    Some(ProcessIdentity {
        pid,
        process_group,
        start_time,
        executable,
    })
}

fn process_identity(pid: u32) -> Option<ProcessIdentity> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let executable = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    parse_process_stat(pid, &stat, executable)
}

fn process_belongs_to_current_user(pid: u32) -> bool {
    let Ok(self_uid) = std::fs::metadata("/proc/self").map(|meta| meta.uid()) else {
        return false;
    };
    std::fs::metadata(format!("/proc/{pid}"))
        .map(|meta| meta.uid() == self_uid)
        .unwrap_or(false)
}

fn wechat_pids() -> HashSet<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return HashSet::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
        })
        .filter(|pid| {
            process_belongs_to_current_user(*pid)
                && process_name(*pid)
                    .as_deref()
                    .is_some_and(is_wechat_process_name)
        })
        .collect()
}

pub(crate) fn wechat_is_running() -> bool {
    !wechat_pids().is_empty()
}

fn new_session_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{nanos}", std::process::id())
}

fn process_has_session_token(pid: u32, token: &str) -> bool {
    let Ok(environ) = std::fs::read(format!("/proc/{pid}/environ")) else {
        return false;
    };
    let expected = format!("{SESSION_TOKEN_ENV}={token}");
    environ
        .split(|byte| *byte == 0)
        .any(|entry| entry == expected.as_bytes())
}

fn session_members(token: &str, process_group: u32, install_root: &Path) -> Vec<ProcessIdentity> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut members: Vec<ProcessIdentity> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
        })
        .filter(|pid| process_belongs_to_current_user(*pid))
        .filter_map(process_identity)
        .filter(|identity| {
            identity.executable.starts_with(install_root)
                && (process_has_session_token(identity.pid, token)
                    || identity.process_group == process_group)
        })
        .collect();
    members.sort_by_key(|identity| identity.pid);
    members
}

fn read_database_page(path: &Path) -> anyhow::Result<[u8; 4096]> {
    let mut page = [0u8; 4096];
    let file =
        File::open(path).with_context(|| format!("读取 emoticon.db 失败：{}", path.display()))?;
    let bytes = file
        .read_at(&mut page, 0)
        .with_context(|| format!("读取 emoticon.db 首页失败：{}", path.display()))?;
    if bytes != page.len() {
        return Err(anyhow!("emoticon.db 小于 4096 字节：{}", path.display()));
    }
    Ok(page)
}

fn verify_raw_key(page: &[u8; 4096], key: &[u8; 32]) -> bool {
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

fn scan_process_for_key(
    pid: u32,
    page: &[u8; 4096],
    target_salt: &[u8; 16],
    deadline: Instant,
) -> anyhow::Result<Option<[u8; 32]>> {
    const CHUNK_SIZE: usize = 1024 * 1024;
    const OVERLAP: usize = 256;

    let maps = std::fs::read_to_string(format!("/proc/{pid}/maps"))
        .with_context(|| format!("无法读取 /proc/{pid}/maps"))?;
    let mem = File::open(format!("/proc/{pid}/mem"))
        .with_context(|| format!("无法读取 /proc/{pid}/mem"))?;
    let mut buffer = vec![0u8; CHUNK_SIZE];

    for region in parse_readable_regions(&maps) {
        let mut offset = region.start;
        let mut tail = Vec::new();
        while offset < region.end {
            if Instant::now() >= deadline {
                return Ok(None);
            }
            let wanted = ((region.end - offset) as usize).min(buffer.len());
            let read = match mem.read_at(&mut buffer[..wanted], offset) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            tail.extend_from_slice(&buffer[..read]);
            for candidate in extract_key_candidates(&tail) {
                if candidate.salt.is_some_and(|salt| &salt != target_salt) {
                    continue;
                }
                if verify_raw_key(page, &candidate.key) {
                    return Ok(Some(candidate.key));
                }
            }
            if tail.len() > OVERLAP {
                tail.drain(..tail.len() - OVERLAP);
            }
            offset += read as u64;
        }
    }
    Ok(None)
}

fn send_signal(identity: &ProcessIdentity, signal: &str) {
    if process_identity(identity.pid).as_ref() != Some(identity) {
        return;
    }
    let _ = Command::new("/bin/kill")
        .args([signal, &identity.pid.to_string()])
        .status();
}

struct LaunchedWechat {
    child: Child,
    session_token: String,
    process_group: u32,
    install_root: PathBuf,
    tracked: HashMap<u32, ProcessIdentity>,
    cleaned: bool,
}

impl LaunchedWechat {
    fn refresh(&mut self) -> Vec<ProcessIdentity> {
        let members = session_members(&self.session_token, self.process_group, &self.install_root);
        for identity in &members {
            self.tracked.insert(identity.pid, identity.clone());
        }
        members
    }

    fn has_live_members(&self) -> bool {
        self.tracked
            .values()
            .any(|identity| process_identity(identity.pid).as_ref() == Some(identity))
    }

    fn cleanup(&mut self) {
        self.cleanup_with_grace(Duration::from_secs(3), Duration::from_secs(1));
    }

    fn cleanup_with_grace(&mut self, term_grace: Duration, kill_grace: Duration) {
        if self.cleaned {
            return;
        }
        self.cleaned = true;
        let deadline = Instant::now() + term_grace;
        while Instant::now() < deadline {
            for identity in self.refresh() {
                send_signal(&identity, "-TERM");
            }
            if self.child.try_wait().ok().flatten().is_some() && !self.has_live_members() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let reap_deadline = Instant::now() + kill_grace;
        while Instant::now() < reap_deadline {
            for identity in self.refresh() {
                send_signal(&identity, "-KILL");
            }
            let _ = self.child.kill();
            if self.child.try_wait().ok().flatten().is_some() && !self.has_live_members() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for LaunchedWechat {
    fn drop(&mut self) {
        self.cleanup();
    }
}

fn append_log(path: &Path, message: &str) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
    {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        let _ = writeln!(file, "{message}");
    }
}

pub(crate) fn dump_db_key(
    wechat_bin: &Path,
    emoticon_db: &Path,
    log_file: &Path,
    timeout: Duration,
) -> anyhow::Result<String> {
    if !wechat_bin.is_file() {
        return Err(anyhow!("Linux 微信程序不存在：{}", wechat_bin.display()));
    }
    let page = read_database_page(emoticon_db)?;
    let target_salt: [u8; 16] = page[..16].try_into().expect("fixed-size database salt");
    if let Some(parent) = log_file.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut log_options = OpenOptions::new();
    log_options
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600);
    if let Ok(mut log) = log_options.open(log_file) {
        let _ = std::fs::set_permissions(log_file, std::fs::Permissions::from_mode(0o600));
        let _ = log.write_all(b"[info] Linux key scan started\n");
    }

    let canonical_bin = std::fs::canonicalize(wechat_bin)
        .with_context(|| format!("解析 Linux 微信程序路径失败：{}", wechat_bin.display()))?;
    let install_root = canonical_bin
        .parent()
        .ok_or_else(|| anyhow!("无法确定 Linux 微信安装目录：{}", canonical_bin.display()))?
        .to_path_buf();
    let session_token = new_session_token();
    let child = Command::new(&canonical_bin)
        .env(SESSION_TOKEN_ENV, &session_token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .with_context(|| format!("启动 Linux 微信失败：{}", wechat_bin.display()))?;
    let root_pid = child.id();
    let mut launched = LaunchedWechat {
        child,
        session_token,
        process_group: root_pid,
        install_root,
        tracked: HashMap::new(),
        cleaned: false,
    };
    append_log(log_file, &format!("[info] launched pid={root_pid}"));
    let started = Instant::now();
    let deadline = started + timeout;
    let mut last_permission_error = None;
    let mut child_exited = false;

    while Instant::now() <= deadline {
        let members = launched.refresh();
        for identity in &members {
            match scan_process_for_key(identity.pid, &page, &target_salt, deadline) {
                Ok(Some(key)) => {
                    append_log(
                        log_file,
                        &format!("[info] matched target database in pid={}", identity.pid),
                    );
                    return Ok(hex::encode(key));
                }
                Ok(None) => {}
                Err(error) => {
                    last_permission_error = Some(error.to_string());
                }
            }
        }
        if !child_exited && launched.child.try_wait().ok().flatten().is_some() {
            child_exited = true;
        }
        if child_exited && !launched.has_live_members() {
            return Err(anyhow!(
                "Linux 微信在获取密钥前退出；请查看日志：{}",
                log_file.display()
            ));
        }
        thread::sleep(Duration::from_secs(1));
    }

    if let Some(error) = last_permission_error {
        append_log(log_file, &format!("[warn] {error}"));
    }
    Err(anyhow!(
        "等待 Linux 微信数据库密钥超时（{} 秒）；请在启动的微信中登录并打开一次表情面板。日志：{}",
        timeout.as_secs(),
        log_file.display()
    ))
}

fn discover_data_root_with_config(
    home: &Path,
    explicit: Option<&Path>,
    config_home: Option<&Path>,
) -> anyhow::Result<PathBuf> {
    if let Some(path) = explicit {
        if path.is_dir() {
            return Ok(path.to_path_buf());
        }
        return Err(anyhow!("指定的微信数据目录不存在：{}", path.display()));
    }

    let mut candidates = Vec::new();
    if let Some(documents) = xdg_documents_dir(home, config_home) {
        candidates.push(documents.join("xwechat_files"));
    }
    candidates.push(home.join("Documents/xwechat_files"));
    candidates.push(home.join("文档/xwechat_files"));
    candidates
        .into_iter()
        .find(|path| path.is_dir())
        .with_context(|| {
            format!(
                "未找到 Linux 微信数据目录；请使用 --wechat-data-dir 指定 xwechat_files 路径（HOME={}）",
                home.display()
            )
        })
}

pub(crate) fn discover_data_root(home: &Path, explicit: Option<&Path>) -> anyhow::Result<PathBuf> {
    let config_home = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    discover_data_root_with_config(home, explicit, config_home.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn data_root_prefers_explicit_directory() {
        let tmp = tempdir().unwrap();
        let explicit = tmp.path().join("custom/xwechat_files");
        fs::create_dir_all(&explicit).unwrap();

        let actual = discover_data_root(tmp.path(), Some(&explicit)).unwrap();

        assert_eq!(actual, explicit);
    }

    #[test]
    fn data_root_discovers_english_documents_directory() {
        let tmp = tempdir().unwrap();
        let expected = tmp.path().join("Documents/xwechat_files");
        fs::create_dir_all(&expected).unwrap();

        let actual = discover_data_root(tmp.path(), None).unwrap();

        assert_eq!(actual, expected);
    }

    #[test]
    fn data_root_discovers_localized_chinese_documents_directory() {
        let tmp = tempdir().unwrap();
        let expected = tmp.path().join("文档/xwechat_files");
        fs::create_dir_all(&expected).unwrap();

        let actual = discover_data_root(tmp.path(), None).unwrap();

        assert_eq!(actual, expected);
    }

    #[test]
    fn data_root_uses_xdg_documents_configuration() {
        let tmp = tempdir().unwrap();
        let expected = tmp.path().join("Документы/xwechat_files");
        fs::create_dir_all(&expected).unwrap();
        fs::create_dir_all(tmp.path().join(".config")).unwrap();
        fs::write(
            tmp.path().join(".config/user-dirs.dirs"),
            "XDG_DOCUMENTS_DIR=\"$HOME/Документы\"\n",
        )
        .unwrap();

        let actual = discover_data_root(tmp.path(), None).unwrap();

        assert_eq!(actual, expected);
    }

    #[test]
    fn data_root_uses_custom_xdg_config_home() {
        let tmp = tempdir().unwrap();
        let config_home = tmp.path().join("xdg-config");
        let expected = tmp.path().join("Docs/xwechat_files");
        fs::create_dir_all(&expected).unwrap();
        fs::create_dir_all(&config_home).unwrap();
        fs::write(
            config_home.join("user-dirs.dirs"),
            "XDG_DOCUMENTS_DIR=\"$HOME/Docs\"\n",
        )
        .unwrap();

        let actual = discover_data_root_with_config(tmp.path(), None, Some(&config_home)).unwrap();

        assert_eq!(actual, expected);
    }

    #[test]
    fn data_root_rejects_missing_explicit_directory() {
        let tmp = tempdir().unwrap();
        let missing = tmp.path().join("missing");

        let error = discover_data_root(tmp.path(), Some(&missing)).unwrap_err();

        assert!(error.to_string().contains("不存在"));
    }

    #[test]
    fn maps_parser_keeps_only_readable_regions() {
        let maps = concat!(
            "00400000-00452000 r-xp 00000000 08:02 1 /opt/wechat/wechat\n",
            "00651000-00652000 r--p 00051000 08:02 1 /opt/wechat/wechat\n",
            "00652000-00653000 -w-p 00052000 08:02 1 /opt/wechat/wechat\n",
            "7ffd0000-7ffd1000 rw-p 00000000 00:00 0 [stack]\n",
        );

        let regions = parse_readable_regions(maps);

        assert_eq!(
            regions,
            vec![
                MemoryRegion {
                    start: 0x0040_0000,
                    end: 0x0045_2000,
                },
                MemoryRegion {
                    start: 0x0065_1000,
                    end: 0x0065_2000,
                },
                MemoryRegion {
                    start: 0x7ffd_0000,
                    end: 0x7ffd_1000,
                },
            ]
        );
    }

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
    fn process_name_matching_accepts_only_wechat_binaries() {
        assert!(is_wechat_process_name("wechat"));
        assert!(is_wechat_process_name("WeChatAppEx"));
        assert!(is_wechat_process_name("weixin"));
        assert!(!is_wechat_process_name("wechat-export-helper"));
        assert!(!is_wechat_process_name("bash"));
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

    #[test]
    fn process_stat_parser_extracts_group_and_start_time() {
        let mut fields = vec!["0"; 20];
        fields[0] = "S";
        fields[1] = "1";
        fields[2] = "123";
        fields[19] = "987654";
        let stat = format!("123 (wechat) {}", fields.join(" "));

        let parsed = parse_process_stat(123, &stat, PathBuf::from("/opt/wechat/wechat")).unwrap();

        assert_eq!(parsed.pid, 123);
        assert_eq!(parsed.process_group, 123);
        assert_eq!(parsed.start_time, 987654);
    }

    #[test]
    fn session_token_tracks_a_process_after_setsid() {
        let token = new_session_token();
        let mut child = Command::new("/usr/bin/setsid")
            .args(["/bin/sleep", "10"])
            .env(SESSION_TOKEN_ENV, &token)
            .spawn()
            .unwrap();
        let mut found = false;
        let mut excluded_outside_install_root = false;
        for _ in 0..40 {
            excluded_outside_install_root = session_members(
                &token,
                u32::MAX,
                Path::new("/definitely-not-the-install-root"),
            )
            .iter()
            .all(|identity| identity.pid != child.id());
            found = session_members(&token, u32::MAX, Path::new("/usr/bin"))
                .iter()
                .any(|identity| identity.pid == child.id());
            if found {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        let _ = child.kill();
        let _ = child.wait();

        assert!(
            found,
            "setsid process was not found through its session token"
        );
        assert!(
            excluded_outside_install_root,
            "token must not include executables outside the install root"
        );
    }

    #[test]
    fn cleanup_is_bounded_even_when_root_is_not_discoverable() {
        let child = Command::new("/bin/sleep").arg("10").spawn().unwrap();
        let mut launched = LaunchedWechat {
            child,
            session_token: "missing-token".to_string(),
            process_group: u32::MAX,
            install_root: PathBuf::from("/not-used"),
            tracked: HashMap::new(),
            cleaned: false,
        };
        let started = Instant::now();

        launched.cleanup_with_grace(Duration::from_millis(25), Duration::from_millis(500));

        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(launched.child.try_wait().unwrap().is_some());
    }
}
