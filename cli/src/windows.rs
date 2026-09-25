//! Windows 适配：从微信（Weixin.exe / WeChat.exe 4.x）进程内存中定位 emoticon db key。
//!
//! 与 Linux 版一致，扫描进程内存中的 `x'<hex>'` SQLCipher pragma 候选，
//! 并用 emoticon.db 首页 HMAC 离线验证。优先扫描正在运行的微信（无需退出）；
//! 若微信未运行，会自动拉起一个临时实例，抓到 key 或超时后清理退出。

use anyhow::{anyhow, Context};
use std::collections::HashSet;
use std::ffi::c_void;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Memory::{
    VirtualQueryEx, MEMORY_BASIC_INFORMATION, MEM_COMMIT, PAGE_EXECUTE_READ,
    PAGE_EXECUTE_READWRITE, PAGE_EXECUTE_WRITECOPY, PAGE_GUARD, PAGE_READONLY, PAGE_READWRITE,
    PAGE_WRITECOPY,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
    KEY_READ, REG_SZ,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
};

use crate::keyscan::{extract_key_candidates, read_database_page, verify_raw_key};

// 用户态地址空间上限（x64）。
const MAX_USER_ADDRESS: usize = 0x0000_7FFF_FFFF_FFFF;
const CHUNK_SIZE: usize = 1024 * 1024;
const OVERLAP: usize = 256;
// 跳过过大的区域（例如超大的内存映射文件），避免单区域扫描耗时失控。
const MAX_REGION_SIZE: usize = 1024 * 1024 * 1024;

// 微信 4.1+ 把每个已打开数据库的 key 以 x'<64hex key><32hex salt>' 形式
// 存放在 WCDB Config.Cipher 对象里，并用固定的 32 字节掩码做 XOR 混淆。
const CONFIG_CIPHER_NAME: &[u8] = b"com.Tencent.WCDB.Config.Cipher";
const CONFIG_CIPHER_XOR_MASK: [u8; 32] = [
    0xd2, 0xc7, 0x44, 0x24, 0x58, 0x02, 0x00, 0x00, 0x00, 0x48, 0x89, 0x44, 0x24, 0x50, 0x48,
    0x8b, 0x45, 0x00, 0x48, 0x84, 0x4c, 0x24, 0x48, 0x48, 0x89, 0x44, 0x25, 0x40, 0x48, 0x58,
    0x4c, 0x24,
];
const CONFIG_CIPHER_BLOB_MAX: usize = 1024;

struct HandleGuard(HANDLE);

impl Drop for HandleGuard {
    fn drop(&mut self) {
        if !is_invalid_handle(self.0) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

// 兼容不同 windows-sys 版本里 HANDLE 的具体表示：空指针与 -1（INVALID_HANDLE_VALUE）都视为无效。
fn is_invalid_handle(handle: HANDLE) -> bool {
    let raw = handle as usize;
    raw == 0 || raw == usize::MAX
}

#[derive(Debug, Clone)]
struct ProcessEntry {
    pid: u32,
    ppid: u32,
    name: String,
}

fn snapshot_processes() -> Vec<ProcessEntry> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if is_invalid_handle(snapshot) {
            return Vec::new();
        }
        let _guard = HandleGuard(snapshot);

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        let mut out = Vec::new();
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let name_len = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
                out.push(ProcessEntry {
                    pid: entry.th32ProcessID,
                    ppid: entry.th32ParentProcessID,
                    name,
                });
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        out
    }
}

pub(crate) fn is_wechat_process_name(name: &str) -> bool {
    let stem = name
        .trim()
        .to_ascii_lowercase()
        .trim_end_matches(".exe")
        .to_string();
    matches!(
        stem.as_str(),
        "weixin" | "wechat" | "wechatappex" | "wechatplayer"
    )
}

#[allow(dead_code)]
pub(crate) fn wechat_is_running() -> bool {
    snapshot_processes()
        .iter()
        .any(|entry| is_wechat_process_name(&entry.name))
}

fn wechat_pids() -> Vec<u32> {
    let mut pids: Vec<u32> = snapshot_processes()
        .into_iter()
        .filter(|entry| is_wechat_process_name(&entry.name))
        .map(|entry| entry.pid)
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

fn open_process_for_read(pid: u32) -> anyhow::Result<HANDLE> {
    let mut handle =
        unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
    if is_invalid_handle(handle) {
        // 某些受限进程只允许 LIMITED_INFORMATION 查询。
        handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
                0,
                pid,
            )
        };
    }
    if is_invalid_handle(handle) {
        return Err(anyhow!("OpenProcess 失败（pid={pid}），可能权限不足"));
    }
    Ok(handle)
}

fn is_readable_protection(protect: u32) -> bool {
    if protect & PAGE_GUARD != 0 {
        return false;
    }
    let page = protect & 0xFF;
    matches!(
        page,
        PAGE_READONLY
            | PAGE_READWRITE
            | PAGE_WRITECOPY
            | PAGE_EXECUTE_READ
            | PAGE_EXECUTE_READWRITE
            | PAGE_EXECUTE_WRITECOPY
    )
}

/// 逐块读取进程可读区域，块间保留 `carry` 字节重叠，`visit(base, data)` 的 `base`
/// 是 `data[0]` 的绝对地址（含上一块尾部重叠，调用方需用 HashSet 去重绝对地址）。
/// visit 返回 false 表示提前终止；到达 deadline 后立即停止读取。
fn visit_readable_chunks(
    handle: HANDLE,
    deadline: Instant,
    mut visit: impl FnMut(usize, &[u8]) -> bool,
    carry: usize,
) -> anyhow::Result<()> {
    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut address: usize = 0;
    let mut pending: Vec<u8> = Vec::new();
    let mut pending_base: usize = 0;
    while address <= MAX_USER_ADDRESS {
        if Instant::now() >= deadline {
            return Ok(());
        }
        let mut info: MEMORY_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
        let queried = unsafe {
            VirtualQueryEx(
                handle,
                address as *const c_void,
                &mut info,
                std::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
            )
        };
        if queried == 0 {
            break;
        }
        let base = info.BaseAddress as usize;
        let size = info.RegionSize;
        let Some(next) = base.checked_add(size) else { break };
        let next = next.max(address + 1);

        if info.State == MEM_COMMIT && is_readable_protection(info.Protect) && size > 0 {
            let end = (base + size).min(MAX_USER_ADDRESS + 1);
            let mut offset = base;
            while offset < end {
                if Instant::now() >= deadline {
                    return Ok(());
                }
                let wanted = (end - offset).min(buffer.len());
                let mut read = 0usize;
                let ok = unsafe {
                    ReadProcessMemory(
                        handle,
                        offset as *const c_void,
                        buffer.as_mut_ptr() as *mut c_void,
                        wanted,
                        &mut read,
                    )
                };
                if ok == 0 || read == 0 {
                    break;
                }
                if pending.is_empty() {
                    pending_base = offset;
                }
                pending.extend_from_slice(&buffer[..read]);
                if !visit(pending_base, &pending) {
                    return Ok(());
                }
                // 保留尾部用于跨块模式匹配。
                if pending.len() > carry {
                    let drop = pending.len() - carry;
                    pending.drain(..drop);
                    pending_base += drop;
                }
                offset += read;
            }
            pending.clear();
        }
        address = next;
    }
    Ok(())
}

fn read_remote(handle: HANDLE, base: usize, size: usize) -> Option<Vec<u8>> {
    let mut buf = vec![0u8; size];
    let mut read = 0usize;
    let ok = unsafe {
        ReadProcessMemory(
            handle,
            base as *const c_void,
            buf.as_mut_ptr() as *mut c_void,
            size,
            &mut read,
        )
    };
    if ok == 0 || read != size {
        return None;
    }
    Some(buf)
}

fn remote_u64(data: &[u8], offset: usize) -> u64 {
    if offset + 8 > data.len() {
        return 0;
    }
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

/// 从 XOR 解码后的 blob 中提取 x'<hex>' 候选并验证。
fn key_from_cipher_blob(decoded: &[u8], page: &[u8; 4096], target_salt: &[u8; 16]) -> Option<[u8; 32]> {
    let mut cursor = 0usize;
    while cursor + 2 <= decoded.len() {
        let Some(rel) = decoded[cursor..]
            .windows(2)
            .position(|w| w == b"x'" || w == b"X'")
        else {
            break;
        };
        let value_start = cursor + rel + 2;
        let search_end = (value_start + 193).min(decoded.len());
        let Some(rel_end) = decoded[value_start..search_end].iter().position(|b| *b == b'\'')
        else {
            cursor = value_start;
            continue;
        };
        let value_end = value_start + rel_end;
        let value = &decoded[value_start..value_end];
        cursor = value_end + 1;
        if value.len() < 64 || value.len() % 2 != 0 || !value.iter().all(u8::is_ascii_hexdigit) {
            continue;
        }
        // 96 hex = key + salt；更长的运行段按 32 字节步进取窗口。
        let mut starts = vec![0usize];
        if value.len() > 96 {
            let mut s = 0usize;
            while s + 64 <= value.len() {
                starts.push(s);
                s += 32;
            }
            starts.push(value.len() - 64);
        }
        for &start in &starts {
            if start + 64 > value.len() {
                continue;
            }
            let Ok(key) = hex::decode(&value[start..start + 64]) else {
                continue;
            };
            let Ok(key): Result<[u8; 32], _> = key.try_into() else {
                continue;
            };
            // salt 匹配目标库时才优先验证；无 salt 或不匹配也尝试验证。
            if start + 96 <= value.len() {
                if let Ok(salt) = hex::decode(&value[start + 64..start + 96]) {
                    if let Ok(salt) = <[u8; 16]>::try_from(salt) {
                        if &salt != target_salt {
                            continue;
                        }
                    }
                }
            }
            if verify_raw_key(page, &key) {
                return Some(key);
            }
        }
    }
    None
}

/// 微信 4.1+ 主路径：定位 Config.Cipher 对象，解码被 XOR 混淆的 key blob。
fn scan_process_for_config_cipher_key(
    pid: u32,
    page: &[u8; 4096],
    target_salt: &[u8; 16],
    deadline: Instant,
) -> anyhow::Result<Option<[u8; 32]>> {
    let handle = open_process_for_read(pid)?;
    let _guard = HandleGuard(handle);

    // Pass 1: 找到 Config.Cipher 名字字符串的所有地址。
    let mut needle_addresses: HashSet<u64> = HashSet::new();
    visit_readable_chunks(
        handle,
        deadline,
        |_base, data| {
            if data.len() < CONFIG_CIPHER_NAME.len() {
                return true;
            }
            let mut pos = data
                .windows(CONFIG_CIPHER_NAME.len())
                .position(|w| w == CONFIG_CIPHER_NAME);
            while let Some(p) = pos {
                needle_addresses.insert((_base + p) as u64);
                pos = data[p + 1..]
                    .windows(CONFIG_CIPHER_NAME.len())
                    .position(|w| w == CONFIG_CIPHER_NAME)
                    .map(|rp| p + 1 + rp);
            }
            true
        },
        CONFIG_CIPHER_NAME.len() - 1,
    )?;
    if needle_addresses.is_empty() {
        return Ok(None);
    }

    // Pass 2: 找 {ptr, len} 引用结构，追踪到 config 对象与 key blob。
    let mut seen_blobs: HashSet<Vec<u8>> = HashSet::new();
    let mut found: Option<[u8; 32]> = None;
    visit_readable_chunks(
        handle,
        deadline,
        |base, data| {
            if found.is_some() || data.len() < 16 {
                // 已找到 key（或数据不足）：提前终止，不再读取剩余内存。
                return false;
            }
            for off in 0..=data.len() - 16 {
                let ptr = remote_u64(data, off);
                if !needle_addresses.contains(&ptr) {
                    continue;
                }
                if remote_u64(data, off + 8) != CONFIG_CIPHER_NAME.len() as u64 {
                    continue;
                }
                let qaddr = base + off;
                let Some(node) = read_remote(handle, qaddr.saturating_sub(0x10), 0x50) else {
                    continue;
                };
                if remote_u64(&node, 0x18) != CONFIG_CIPHER_NAME.len() as u64 {
                    continue;
                }
                let config_ptr = remote_u64(&node, 0x28) as usize;
                if !(0x10000..MAX_USER_ADDRESS).contains(&config_ptr) {
                    continue;
                }
                let Some(obj) = read_remote(handle, config_ptr + 0x88, 0x28) else {
                    continue;
                };
                let data_ptr = remote_u64(&obj, 0x8) as usize;
                let data_len = remote_u64(&obj, 0x10) as usize;
                if data_len == 0 || data_len > CONFIG_CIPHER_BLOB_MAX
                    || !(0x10000..MAX_USER_ADDRESS).contains(&data_ptr)
                {
                    continue;
                }
                let Some(blob) = read_remote(handle, data_ptr, data_len) else {
                    continue;
                };
                if !seen_blobs.insert(blob.clone()) {
                    continue;
                }
                let decoded: Vec<u8> = blob
                    .iter()
                    .enumerate()
                    .map(|(i, b)| b ^ CONFIG_CIPHER_XOR_MASK[i % CONFIG_CIPHER_XOR_MASK.len()])
                    .collect();
                if let Some(key) = key_from_cipher_blob(&decoded, page, target_salt) {
                    found = Some(key);
                    return false;
                }
            }
            true
        },
        16,
    )?;
    Ok(found)
}

fn scan_process_for_key(
    pid: u32,
    page: &[u8; 4096],
    target_salt: &[u8; 16],
    deadline: Instant,
) -> anyhow::Result<Option<[u8; 32]>> {
    let handle = open_process_for_read(pid)?;
    let _guard = HandleGuard(handle);

    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut address: usize = 0;
    while address <= MAX_USER_ADDRESS {
        if Instant::now() >= deadline {
            return Ok(None);
        }
        let mut info: MEMORY_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
        let queried = unsafe {
            VirtualQueryEx(
                handle,
                address as *const c_void,
                &mut info,
                std::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
            )
        };
        if queried == 0 {
            break;
        }
        let base = info.BaseAddress as usize;
        let size = info.RegionSize;
        let Some(next) = base.checked_add(size) else {
            break;
        };
        let next = next.max(address + 1);

        if info.State == MEM_COMMIT
            && is_readable_protection(info.Protect)
            && size > 0
            && size <= MAX_REGION_SIZE
        {
            let end = (base + size).min(MAX_USER_ADDRESS + 1);
            let mut offset = base;
            let mut tail = Vec::new();
            while offset < end {
                if Instant::now() >= deadline {
                    return Ok(None);
                }
                let wanted = (end - offset).min(CHUNK_SIZE);
                let mut read = 0usize;
                let ok = unsafe {
                    ReadProcessMemory(
                        handle,
                        offset as *const c_void,
                        buffer.as_mut_ptr() as *mut c_void,
                        wanted,
                        &mut read,
                    )
                };
                if ok == 0 || read == 0 {
                    // 区域内偶发不可读页，跳过该区域剩余部分。
                    break;
                }
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
                offset += read;
            }
        }

        address = next;
    }
    Ok(None)
}

struct LaunchedWechat {
    child: Child,
    root_pid: u32,
    tracked: HashSet<u32>,
    cleaned: bool,
}

impl LaunchedWechat {
    fn new(wechat_bin: &Path) -> anyhow::Result<Self> {
        let child = Command::new(wechat_bin)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("启动微信失败：{}", wechat_bin.display()))?;
        let root_pid = child.id();
        let mut launched = Self {
            child,
            root_pid,
            tracked: HashSet::from([root_pid]),
            cleaned: false,
        };
        launched.refresh();
        Ok(launched)
    }

    /// 返回以 root 为祖先、名字匹配微信的可执行进程（含 root 自身）。
    fn refresh(&mut self) -> Vec<u32> {
        let snapshot = snapshot_processes();
        let mut members = Vec::new();
        let mut frontier = vec![self.root_pid];
        let mut seen = HashSet::new();
        while let Some(pid) = frontier.pop() {
            if !seen.insert(pid) {
                continue;
            }
            members.push(pid);
            for entry in &snapshot {
                if entry.ppid == pid && is_wechat_process_name(&entry.name) {
                    frontier.push(entry.pid);
                }
            }
        }
        self.tracked.extend(members.iter().copied());
        members.sort_unstable();
        members.dedup();
        members
    }

    fn has_exited(&mut self) -> bool {
        if self.child.try_wait().ok().flatten().is_none() {
            return false;
        }
        self.refresh().is_empty()
    }

    fn cleanup(&mut self) {
        if self.cleaned {
            return;
        }
        self.cleaned = true;
        // taskkill /T 递归结束进程树。
        kill_process_tree(self.root_pid);
        let _ = self.child.wait();
        // 兜底：清理仍存活的后代进程。
        for pid in self.refresh() {
            if pid != self.root_pid {
                kill_process_tree(pid);
            }
        }
    }
}

impl Drop for LaunchedWechat {
    fn drop(&mut self) {
        self.cleanup();
    }
}

fn append_log(path: &Path, message: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{message}");
    }
}

fn kill_process_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub(crate) fn dump_db_key(
    wechat_bin: &Path,
    emoticon_db: &Path,
    log_file: &Path,
    timeout: Duration,
) -> anyhow::Result<String> {
    let page = read_database_page(emoticon_db)?;
    let target_salt: [u8; 16] = page[..16].try_into().expect("fixed-size database salt");
    if let Some(parent) = log_file.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if let Ok(mut log) = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(log_file)
    {
        let _ = log.write_all(b"[info] Windows key scan started\n");
    }

    let started = Instant::now();
    let deadline = started + timeout;
    let mut launched: Option<LaunchedWechat> = None;
    let mut last_scan_error: Option<String> = None;
    let mut running_hint_shown = false;

    while Instant::now() <= deadline {
        let pids: Vec<u32> = if let Some(l) = launched.as_mut() {
            l.refresh()
        } else {
            wechat_pids()
        };

        for pid in &pids {
    // 主路径：微信 4.1+ 的 Config.Cipher 运行时扫描。
            let mut hit = match scan_process_for_config_cipher_key(*pid, &page, &target_salt, deadline) {
                Ok(key) => key,
                Err(error) => {
                    last_scan_error = Some(error.to_string());
                    append_log(log_file, &format!("[warn] {error}"));
                    None
                }
            };
            // 回退：微信 4.0.x 的 x'<hex>' 明文扫描。
            if hit.is_none() {
                hit = match scan_process_for_key(*pid, &page, &target_salt, deadline) {
                    Ok(key) => key,
                    Err(error) => {
                        last_scan_error = Some(error.to_string());
                        append_log(log_file, &format!("[warn] {error}"));
                        None
                    }
                };
            }
            if let Some(key) = hit {
                append_log(log_file, &format!("[info] matched target database in pid={pid}"));
                if let Some(mut l) = launched.take() {
                    l.cleanup();
                }
                return Ok(hex::encode(key));
            }
        }

        if Instant::now() > deadline {
            break;
        }

        if launched.is_none() {
            if pids.is_empty() {
                if !wechat_bin.is_file() {
                    if wechat_bin.as_os_str().is_empty() {
                        return Err(anyhow!(
                            "未检测到运行中的微信，且自动检测微信程序失败（已尝试运行进程/注册表 App Paths/Program Files）；请用 --wechat-bin 指定 Weixin.exe/WeChat.exe 路径"
                        ));
                    }
                    return Err(anyhow!(
                        "未找到微信程序：{}（可用 --wechat-bin 指定 Weixin.exe/WeChat.exe 路径）",
                        wechat_bin.display()
                    ));
                }
                eprintln!("未检测到运行中的微信，正在启动一个临时微信实例...");
                eprintln!("如果弹出登录窗口：请登录，并打开一次表情面板。");
                append_log(log_file, "[info] no running WeChat; launching a temporary instance");
                launched = Some(LaunchedWechat::new(wechat_bin)?);
                append_log(
                    log_file,
                    &format!("[info] launched pid={}", launched.as_ref().unwrap().root_pid),
                );
            } else if !running_hint_shown {
                eprintln!("检测到微信正在运行，正在扫描其内存获取 db key（无需退出微信）...");
                eprintln!("如果长时间未成功：请在微信里打开一次表情面板后等待重试。");
                running_hint_shown = true;
            }
        }

        if let Some(l) = launched.as_mut() {
            if l.has_exited() {
                return Err(anyhow!(
                    "临时微信实例在获取密钥前退出；请查看日志：{}",
                    log_file.display()
                ));
            }
        }

        thread::sleep(Duration::from_secs(1));
    }

    if let Some(mut l) = launched.take() {
        l.cleanup();
    }
    if let Some(error) = last_scan_error {
        append_log(log_file, &format!("[warn] {error}"));
    }
    Err(anyhow!(
        "等待 Windows 微信数据库密钥超时（{} 秒）；请确认已登录微信并打开一次表情面板。日志：{}",
        timeout.as_secs(),
        log_file.display()
    ))
}

/// 读注册表 REG_SZ 值；value_name 为 None 时读键的默认值。
fn registry_read_sz(root: HKEY, subkey: &str, value_name: Option<&str>) -> Option<String> {
    let subkey_w: Vec<u16> = format!("{subkey}\0").encode_utf16().collect();
    let value_w: Option<Vec<u16>> = value_name.map(|v| format!("{v}\0").encode_utf16().collect());
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(root, subkey_w.as_ptr(), 0, KEY_READ, &mut hkey) != 0 {
            return None;
        }
        let mut buf = [0u16; 512];
        let mut byte_len = (buf.len() * 2) as u32;
        let mut value_type = 0u32;
        let ok = RegQueryValueExW(
            hkey,
            value_w
                .as_ref()
                .map_or(std::ptr::null(), |v| v.as_ptr()),
            std::ptr::null_mut(),
            &mut value_type,
            buf.as_mut_ptr() as *mut u8,
            &mut byte_len,
        );
        RegCloseKey(hkey);
        if ok == 0 && value_type == REG_SZ {
            let chars = (byte_len as usize / 2).min(buf.len());
            let text = String::from_utf16_lossy(&buf[..chars]);
            let text = text.trim_end_matches('\0').trim().trim_matches('"');
            if text.is_empty() {
                return None;
            }
            return Some(text.to_string());
        }
    }
    None
}

/// 腾讯注册表的 InstallPath（实测 Weixin 4.x 写在 HKCU\Software\Tencent\Weixin，
/// 值为安装目录；官方安装器不注册 App Paths）。
fn registry_tencent_bin() -> Option<PathBuf> {
    for (subkey, exe) in [
        ("Software\\Tencent\\Weixin", "Weixin.exe"),
        ("Software\\Tencent\\WeChat", "WeChat.exe"),
    ] {
        for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            if let Some(dir) = registry_read_sz(root, subkey, Some("InstallPath")) {
                let path = PathBuf::from(dir).join(exe);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// 注册表 App Paths 的 exe 完整路径（ShellExecute 同款机制，微信通常不注册，兜底用）。
fn registry_app_path(exe_name: &str) -> Option<PathBuf> {
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let subkey = format!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe_name}");
        if let Some(text) = registry_read_sz(root, &subkey, None) {
            let path = PathBuf::from(text);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// 运行中的微信主进程镜像路径（最可靠：无论装在哪都能拿到）。
fn running_wechat_bin() -> Option<PathBuf> {
    let processes = snapshot_processes();
    let entry = processes
        .iter()
        .find(|p| p.name.eq_ignore_ascii_case("weixin.exe"))
        .or_else(|| processes.iter().find(|p| p.name.eq_ignore_ascii_case("wechat.exe")))?;
    let handle = open_process_for_read(entry.pid).ok()?;
    let _guard = HandleGuard(handle);
    let mut buf = [0u16; 1024];
    let mut size = buf.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size) };
    if ok == 0 {
        return None;
    }
    let path = PathBuf::from(String::from_utf16_lossy(&buf[..size as usize]));
    path.is_file().then_some(path)
}

pub(crate) fn discover_wechat_bin() -> Option<PathBuf> {
    // 1) 运行中的微信进程镜像路径。
    if let Some(path) = running_wechat_bin() {
        return Some(path);
    }
    // 2) 腾讯注册表 InstallPath（官方安装器实际写入的位置）。
    if let Some(path) = registry_tencent_bin() {
        return Some(path);
    }
    // 3) 注册表 App Paths（兜底）。
    for exe_name in ["Weixin.exe", "WeChat.exe"] {
        if let Some(path) = registry_app_path(exe_name) {
            return Some(path);
        }
    }
    // 4) Program Files 常规位置（微信 4.x 官方名为 Weixin；保留旧版 WeChat 兼容）。
    for env_key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(program_files) = std::env::var_os(env_key) {
            let program_files = PathBuf::from(&program_files);
            for rel in ["Tencent/Weixin/Weixin.exe", "Tencent/WeChat/WeChat.exe"] {
                let path = program_files.join(rel);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn discover_data_root_with_candidates(
    home: &Path,
    explicit: Option<&Path>,
    candidates: &[PathBuf],
) -> anyhow::Result<PathBuf> {
    if let Some(path) = explicit {
        if path.is_dir() {
            return Ok(path.to_path_buf());
        }
        return Err(anyhow!("指定的微信数据目录不存在：{}", path.display()));
    }

    candidates
        .iter()
        .find(|path| path.is_dir())
        .cloned()
        .with_context(|| {
            format!(
                "未找到 Windows 微信数据目录；请使用 --wechat-data-dir 指定 xwechat_files 路径（USERPROFILE={}）",
                home.display()
            )
        })
}

pub(crate) fn discover_data_root(home: &Path, explicit: Option<&Path>) -> anyhow::Result<PathBuf> {
    // 微信 4.x Windows 默认把 xwechat_files 放在用户目录；保留 Documents 变体兼容自定义。
    discover_data_root_with_candidates(
        home,
        explicit,
        &[
            home.join("xwechat_files"),
            home.join("Documents/xwechat_files"),
        ],
    )
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
    fn data_root_discovers_profile_directory() {
        let tmp = tempdir().unwrap();
        let expected = tmp.path().join("xwechat_files");
        fs::create_dir_all(&expected).unwrap();

        let actual = discover_data_root(tmp.path(), None).unwrap();

        assert_eq!(actual, expected);
    }

    #[test]
    fn data_root_falls_back_to_documents_directory() {
        let tmp = tempdir().unwrap();
        let expected = tmp.path().join("Documents/xwechat_files");
        fs::create_dir_all(&expected).unwrap();

        let actual = discover_data_root_with_candidates(
            tmp.path(),
            None,
            &[tmp.path().join("xwechat_files"), expected.clone()],
        )
        .unwrap();

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
    fn process_name_matching_accepts_only_wechat_binaries() {
        assert!(is_wechat_process_name("Weixin.exe"));
        assert!(is_wechat_process_name("WECHAT.EXE"));
        assert!(is_wechat_process_name("WeChatAppEx.exe"));
        assert!(!is_wechat_process_name("wxemoticon.exe"));
        assert!(!is_wechat_process_name("explorer.exe"));
    }

    #[test]
    fn tencent_registry_detection_matches_local_install() {
        // 本机装有 Weixin 时应能通过 HKCU\Software\Tencent\Weixin 定位；
        // 未安装微信的环境跳过（键不存在）。
        if let Some(bin) = registry_tencent_bin() {
            assert!(bin.is_file(), "注册表定位的微信程序应存在：{}", bin.display());
            let name = bin
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_ascii_lowercase();
            assert!(name == "weixin.exe" || name == "wechat.exe");
        }
    }

    #[test]
    fn chunk_visitor_stops_early_and_respects_deadline() {
        // 用自身进程验证遍历契约：visitor 返回 false 立即停止；
        // deadline 已过期时不产生任何 visit 调用。
        let pid = std::process::id();
        let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
        assert!(!is_invalid_handle(handle));
        let _guard = HandleGuard(handle);

        let mut calls = 0usize;
        visit_readable_chunks(
            handle,
            Instant::now() + Duration::from_secs(30),
            |_base, _data| {
                calls += 1;
                false // 第一次调用即终止
            },
            16,
        )
        .unwrap();
        assert_eq!(calls, 1, "visitor 返回 false 后必须立即停止遍历");

        let mut expired_calls = 0usize;
        visit_readable_chunks(
            handle,
            Instant::now() - Duration::from_secs(1), // 已过期
            |_base, _data| {
                expired_calls += 1;
                true
            },
            16,
        )
        .unwrap();
        assert_eq!(expired_calls, 0, "deadline 已过期时不应有任何读取");
    }

    #[test]
    fn readable_protection_filters_guarded_and_noaccess_pages() {
        assert!(is_readable_protection(PAGE_READONLY));
        assert!(is_readable_protection(PAGE_READWRITE));
        assert!(!is_readable_protection(PAGE_GUARD | PAGE_READWRITE));
        assert!(!is_readable_protection(0x01)); // PAGE_NOACCESS
    }
}
