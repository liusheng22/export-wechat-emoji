#![allow(unexpected_cfgs)]

use serde::Serialize;
use std::path::{Path, PathBuf};

const BOOKMARK_FILE_NAME: &str = "permissions/wechat-data.bookmark";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WeChatDataBookmarkStatus {
    path: String,
    security_scope_started: bool,
    stale: bool,
}

fn expected_wechat_data_dir() -> Result<PathBuf, String> {
    tauri::api::path::home_dir()
        .map(|home| {
            home.join("Library")
                .join("Containers")
                .join("com.tencent.xinWeChat")
                .join("Data")
        })
        .ok_or_else(|| "failed to resolve home directory".to_string())
}

fn normalize_path(path: &Path) -> PathBuf {
    path.components().collect()
}

fn validate_wechat_data_dir(path: &Path) -> Result<PathBuf, String> {
    let selected = normalize_path(path);
    let expected = normalize_path(&expected_wechat_data_dir()?);
    if selected != expected {
        return Err(format!("请选择微信数据目录：{}", expected.display()));
    }
    if !selected.is_dir() {
        return Err(format!("微信数据目录不存在：{}", selected.display()));
    }
    Ok(selected)
}

fn bookmark_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path_resolver()
        .app_data_dir()
        .map(|dir| dir.join(BOOKMARK_FILE_NAME))
        .ok_or_else(|| "failed to resolve app data directory".to_string())
}

fn persist_bookmark(app: &tauri::AppHandle, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let destination = bookmark_file_path(app)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "bookmark path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create bookmark directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("failed to create bookmark file: {error}"))?;
    temporary
        .write_all(bytes)
        .map_err(|error| format!("failed to write bookmark file: {error}"))?;
    temporary
        .flush()
        .map_err(|error| format!("failed to flush bookmark file: {error}"))?;
    temporary
        .persist(&destination)
        .map_err(|error| format!("failed to persist bookmark file: {}", error.error))?;
    Ok(())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use cocoa::base::{id, nil, BOOL, NO, YES};
    use cocoa::foundation::{NSAutoreleasePool, NSData, NSString, NSUInteger, NSURL};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::os::raw::c_char;
    use std::sync::Mutex;

    const BOOKMARK_CREATION_WITH_SECURITY_SCOPE: NSUInteger = 1 << 11;
    const BOOKMARK_RESOLUTION_WITHOUT_UI: NSUInteger = 1 << 8;
    const BOOKMARK_RESOLUTION_WITH_SECURITY_SCOPE: NSUInteger = 1 << 10;

    static ACTIVE_SECURITY_SCOPED_URL: Mutex<Option<usize>> = Mutex::new(None);

    unsafe fn ns_string(value: id) -> String {
        if value == nil {
            return String::new();
        }
        let utf8: *const c_char = msg_send![value, UTF8String];
        if utf8.is_null() {
            return String::new();
        }
        CStr::from_ptr(utf8).to_string_lossy().into_owned()
    }

    unsafe fn error_message(error: id, fallback: &str) -> String {
        if error == nil {
            return fallback.to_string();
        }
        let description: id = msg_send![error, localizedDescription];
        let text = ns_string(description);
        if text.is_empty() {
            fallback.to_string()
        } else {
            text
        }
    }

    unsafe fn url_path(url: id) -> Result<PathBuf, String> {
        let value: id = msg_send![url, path];
        let path = ns_string(value);
        if path.is_empty() {
            Err("resolved bookmark URL has no file path".to_string())
        } else {
            Ok(PathBuf::from(path))
        }
    }

    unsafe fn bookmark_data(url: id) -> Result<Vec<u8>, String> {
        let mut error: id = nil;
        let data: id = msg_send![url,
            bookmarkDataWithOptions: BOOKMARK_CREATION_WITH_SECURITY_SCOPE
            includingResourceValuesForKeys: nil
            relativeToURL: nil
            error: &mut error
        ];
        if data == nil {
            return Err(error_message(
                error,
                "macOS failed to create a security-scoped bookmark",
            ));
        }
        let length: NSUInteger = msg_send![data, length];
        let bytes: *const u8 = msg_send![data, bytes];
        if bytes.is_null() || length == 0 {
            return Err("macOS returned empty bookmark data".to_string());
        }
        Ok(std::slice::from_raw_parts(bytes, length as usize).to_vec())
    }

    unsafe fn activate_security_scope(url: id) -> bool {
        let started: BOOL = msg_send![url, startAccessingSecurityScopedResource];
        if started != YES {
            return false;
        }

        let retained: id = msg_send![url, retain];
        let Ok(mut active) = ACTIVE_SECURITY_SCOPED_URL.lock() else {
            let _: () = msg_send![url, stopAccessingSecurityScopedResource];
            let _: () = msg_send![retained, release];
            return false;
        };
        if let Some(previous) = active.replace(retained as usize) {
            let previous = previous as id;
            let _: () = msg_send![previous, stopAccessingSecurityScopedResource];
            let _: () = msg_send![previous, release];
        }
        true
    }

    pub(super) fn save(
        app: &tauri::AppHandle,
        path: &Path,
    ) -> Result<WeChatDataBookmarkStatus, String> {
        let path = validate_wechat_data_dir(path)?;
        let path_text = path
            .to_str()
            .ok_or_else(|| "微信数据目录不是有效的 UTF-8 路径".to_string())?;

        unsafe {
            let pool = NSAutoreleasePool::new(nil);
            let ns_path = NSString::alloc(nil).init_str(path_text);
            let url = NSURL::fileURLWithPath_(nil, ns_path);
            let data = bookmark_data(url);
            let result = match data {
                Ok(data) => {
                    persist_bookmark(app, &data)?;
                    Ok(WeChatDataBookmarkStatus {
                        path: path.display().to_string(),
                        security_scope_started: activate_security_scope(url),
                        stale: false,
                    })
                }
                Err(error) => Err(error),
            };
            let _: () = msg_send![ns_path, release];
            pool.drain();
            result
        }
    }

    pub(super) fn restore(
        app: &tauri::AppHandle,
    ) -> Result<Option<WeChatDataBookmarkStatus>, String> {
        let bookmark_path = bookmark_file_path(app)?;
        let bytes = match std::fs::read(&bookmark_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("failed to read bookmark file: {error}")),
        };

        unsafe {
            let pool = NSAutoreleasePool::new(nil);
            let data = NSData::dataWithBytes_length_(
                nil,
                bytes.as_ptr().cast(),
                bytes.len() as NSUInteger,
            );
            let mut stale: BOOL = NO;
            let mut error: id = nil;
            let options = BOOKMARK_RESOLUTION_WITH_SECURITY_SCOPE | BOOKMARK_RESOLUTION_WITHOUT_UI;
            let url: id = msg_send![class!(NSURL),
                URLByResolvingBookmarkData: data
                options: options
                relativeToURL: nil
                bookmarkDataIsStale: &mut stale
                error: &mut error
            ];
            if url == nil {
                let message = error_message(
                    error,
                    "macOS failed to resolve the saved security-scoped bookmark",
                );
                pool.drain();
                return Err(message);
            }

            let path = validate_wechat_data_dir(&url_path(url)?)?;
            if stale == YES {
                persist_bookmark(app, &bookmark_data(url)?)?;
            }
            let status = WeChatDataBookmarkStatus {
                path: path.display().to_string(),
                security_scope_started: activate_security_scope(url),
                stale: stale == YES,
            };
            pool.drain();
            Ok(Some(status))
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub(super) fn save(
        _app: &tauri::AppHandle,
        _path: &Path,
    ) -> Result<WeChatDataBookmarkStatus, String> {
        Err("security-scoped bookmarks are supported only on macOS".to_string())
    }

    pub(super) fn restore(
        _app: &tauri::AppHandle,
    ) -> Result<Option<WeChatDataBookmarkStatus>, String> {
        Ok(None)
    }
}

#[tauri::command]
pub(crate) fn save_wechat_data_bookmark(
    app: tauri::AppHandle,
    path: String,
) -> Result<WeChatDataBookmarkStatus, String> {
    platform::save(&app, Path::new(&path))
}

#[tauri::command]
pub(crate) fn restore_wechat_data_bookmark(
    app: tauri::AppHandle,
) -> Result<Option<WeChatDataBookmarkStatus>, String> {
    platform::restore(&app)
}
