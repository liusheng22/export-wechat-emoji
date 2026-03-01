#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: generate-homebrew-formula.sh <vX.Y.Z> <arm64_sha256> <x64_sha256> [repo]}"
ARM64_SHA="${2:?usage: generate-homebrew-formula.sh <vX.Y.Z> <arm64_sha256> <x64_sha256> [repo]}"
X64_SHA="${3:?usage: generate-homebrew-formula.sh <vX.Y.Z> <arm64_sha256> <x64_sha256> [repo]}"
REPO="${4:-liusheng22/export-wechat-emoji}"
VERSION_NO_V="${VERSION#v}"

cat <<RUBY
class Wxemoticon < Formula
  desc "macOS 微信表情包工具：抓取 db key / 导出 URL / 导出表情包图片"
  homepage "https://github.com/${REPO}"
  version "${VERSION_NO_V}"
  license "MIT"

  on_arm do
    url "https://github.com/${REPO}/releases/download/${VERSION}/wxemoticon-aarch64-apple-darwin.tar.gz"
    sha256 "${ARM64_SHA}"
  end

  on_intel do
    url "https://github.com/${REPO}/releases/download/${VERSION}/wxemoticon-x86_64-apple-darwin.tar.gz"
    sha256 "${X64_SHA}"
  end

  def install
    bin.install "wxemoticon"
  end

  test do
    assert_match "wxemoticon", shell_output("#{bin}/wxemoticon --help")
  end
end
RUBY
