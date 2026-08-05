use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=../tools/wechat-key-dumper/key_dumper.c");

    // This CLI only makes sense on macOS, but allow `cargo check` elsewhere without failing.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
    let out = out_dir.join("wechat_key_dumper.dylib");

    let target = env::var("TARGET").unwrap_or_default();
    let arch: String = if target.contains("aarch64-apple-darwin") {
        "arm64".to_string()
    } else if target.contains("x86_64-apple-darwin") {
        "x86_64".to_string()
    } else {
        // Fallback: build for host arch. This is mainly for local experiments.
        env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| "arm64".to_string())
    };

    let src = Path::new("../tools/wechat-key-dumper/key_dumper.c");
    if !src.exists() {
        panic!("missing key dumper source: {}", src.display());
    }

    let sdk = Command::new("xcrun")
        .args(["--sdk", "macosx", "--show-sdk-path"])
        .output()
        .expect("failed to find the macOS SDK with xcrun");
    if !sdk.status.success() {
        panic!("failed to find the macOS SDK with xcrun");
    }
    let sdk_path = String::from_utf8(sdk.stdout)
        .expect("macOS SDK path is not valid UTF-8")
        .trim()
        .to_string();

    let status = Command::new("xcrun")
        .args(["--sdk", "macosx", "clang", "-isysroot", &sdk_path])
        .args([
            "-dynamiclib",
            "-O2",
            "-fvisibility=hidden",
            "-mmacosx-version-min=11.0",
            "-arch",
            &arch,
            "-o",
        ])
        .arg(&out)
        .arg(src)
        .status()
        .expect("failed to run clang");

    if !status.success() {
        panic!("failed to build wechat_key_dumper.dylib (clang exit={status})");
    }

    println!(
        "cargo:rustc-env=WXEMOTICON_KEY_DUMPER_DYLIB_PATH={}",
        out.display()
    );
}
