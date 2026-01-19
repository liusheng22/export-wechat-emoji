// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use plist::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![greet, extract_fav_urls])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
