#!/usr/bin/env ruby
# frozen_string_literal: true

require 'json'
require 'fileutils'
require 'sqlite3'
require 'digest'
require 'open-uri'
require 'openssl'

WXID = ARGV[0] || abort('usage: ruby scripts/validate-package-visual.rb <wxid> <package_id>')
PACKAGE_ID = ARGV[1] || abort('usage: ruby scripts/validate-package-visual.rb <wxid> <package_id>')

ROOT = File.expand_path('..', __dir__)
DB = File.join(ROOT, '.tmp', 'emoticon.db.dec.sqlite')
HOME_DIR = ENV.fetch('HOME')
EMOJI_ROOT = File.join(HOME_DIR, 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files', WXID, 'business/emoticon')
PKG_HASH = Digest::MD5.hexdigest(PACKAGE_ID)
PERSIST_STORE = File.join(EMOJI_ROOT, 'PersistStore', PKG_HASH[0, 2], PKG_HASH)
THUMB_STORE = File.join(EMOJI_ROOT, 'ThumbStore', PKG_HASH[0, 2], PKG_HASH)
ICON_STORE = File.join(EMOJI_ROOT, 'ThumbStore', PKG_HASH[0, 2], "#{PKG_HASH}.icon")

db = SQLite3::Database.new(DB)
db.results_as_hash = true

rows = db.execute(<<~SQL, [PACKAGE_ID])
  SELECT f.package_id_ AS package_id,
         p.package_name_ AS package_name,
         f.sort_order_ AS sort_order,
         lower(f.md5_) AS md5,
         f.emoticon_offset_ AS emoticon_offset,
         f.emoticon_size_ AS emoticon_size,
         f.thumb_offset_ AS thumb_offset,
         f.thumb_size_ AS thumb_size,
         n.aes_key AS aes_key,
         n.encrypt_url AS encrypt_url,
         n.cdn_url AS cdn_url,
         n.thumb_url AS thumb_url,
         n.extern_url AS extern_url
  FROM kStoreEmoticonFilesTable f
  LEFT JOIN kStoreEmoticonPackageTable p ON p.package_id_ = f.package_id_
  LEFT JOIN kNonStoreEmoticonTable n ON lower(n.md5) = lower(f.md5_)
  WHERE f.package_id_ = ?
  ORDER BY f.sort_order_ ASC, lower(f.md5_) ASC
SQL

abort("package not found: #{PACKAGE_ID}") if rows.empty?

package_name = rows.first['package_name'].to_s.strip
package_name = PACKAGE_ID if package_name.empty?
slug = PACKAGE_ID.split('.').last
out_dir = File.join(ROOT, '.tmp', 'album-validate', slug)
img_dir = File.join(out_dir, 'images')
slice_dir = File.join(out_dir, 'slices')
FileUtils.mkdir_p(img_dir)
FileUtils.mkdir_p(slice_dir)

persist_data = File.binread(PERSIST_STORE)
thumb_data = File.binread(THUMB_STORE)
icon_data = File.exist?(ICON_STORE) ? File.binread(ICON_STORE) : nil

def decrypt_aes128_cbc_with_self_iv(bytes, aes_key_hex)
  key = [aes_key_hex].pack('H*')
  cipher = OpenSSL::Cipher.new('AES-128-CBC')
  cipher.decrypt
  cipher.key = key
  cipher.iv = key
  cipher.padding = 0
  cipher.update(bytes) + cipher.final
end

def detect_ext(bytes)
  return 'gif' if bytes.start_with?('GIF87a'.b) || bytes.start_with?('GIF89a'.b)
  return 'png' if bytes.start_with?("\x89PNG\r\n\x1a\n".b)
  return 'jpg' if bytes.start_with?("\xff\xd8\xff".b)
  return 'webp' if bytes.start_with?('RIFF'.b) && bytes.byteslice(8, 4) == 'WEBP'

  nil
end

def save_bytes(path, bytes)
  File.binwrite(path, bytes)
  path
end

manifest = []

if icon_data
  save_bytes(File.join(img_dir, 'package-thumbstore-icon.bin'), icon_data)
end

rows.each do |row|
  sort_order = row['sort_order'].to_i
  md5 = row['md5']
  persist_offset = row['emoticon_offset'].to_i
  persist_size = row['emoticon_size'].to_i
  thumb_offset = row['thumb_offset'].to_i
  thumb_size = row['thumb_size'].to_i
  persist_slice = persist_data.byteslice(persist_offset, persist_size)
  thumb_slice = thumb_data.byteslice(thumb_offset, thumb_size)

  persist_slice_name = format('%02d-%s.persistslice.bin', sort_order, md5)
  thumb_slice_name = format('%02d-%s.thumbslice.bin', sort_order, md5)
  save_bytes(File.join(slice_dir, persist_slice_name), persist_slice)
  save_bytes(File.join(slice_dir, thumb_slice_name), thumb_slice)

  recovered_full = nil
  recovered_thumb = nil

  if row['encrypt_url'] && row['aes_key']
    begin
      encrypted = URI.open(row['encrypt_url'], &:read)
      plain = decrypt_aes128_cbc_with_self_iv(encrypted, row['aes_key'])
      ext = detect_ext(plain)
      if ext
        name = format('%02d-%s.full.%s', sort_order, md5, ext)
        recovered_full = File.join('images', name)
        save_bytes(File.join(img_dir, name), plain)
      end
    rescue StandardError => e
      recovered_full = "error: #{e.class}: #{e.message}"
    end
  end

  if row['thumb_url']
    begin
      bytes = URI.open(row['thumb_url'], &:read)
      ext = detect_ext(bytes)
      if ext
        name = format('%02d-%s.remote-thumb.%s', sort_order, md5, ext)
        recovered_thumb = File.join('images', name)
        save_bytes(File.join(img_dir, name), bytes)
      end
    rescue StandardError => e
      recovered_thumb = "error: #{e.class}: #{e.message}"
    end
  end

  manifest << {
    sortOrder: sort_order,
    md5: md5,
    emoticonOffset: persist_offset,
    emoticonSize: persist_size,
    thumbOffset: thumb_offset,
    thumbSize: thumb_size,
    aesKey: row['aes_key'],
    hasRemoteDecrypt: !row['encrypt_url'].to_s.empty? && !row['aes_key'].to_s.empty?,
    recoveredFull: recovered_full,
    recoveredThumb: recovered_thumb,
    persistSlice: File.join('slices', persist_slice_name),
    thumbSlice: File.join('slices', thumb_slice_name),
    cdnUrl: row['cdn_url'],
    encryptUrl: row['encrypt_url'],
    thumbUrl: row['thumb_url'],
    externUrl: row['extern_url']
  }
end

File.write(File.join(out_dir, 'manifest.json'), JSON.pretty_generate(manifest))

html = []
html << '<!doctype html><meta charset="utf-8">'
html << "<title>#{package_name} 验证页</title>"
html << <<~CSS
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0b1020;color:#e8ecf8;margin:0;padding:24px}
    h1,h2,p{margin:0 0 12px}
    .meta{color:#b8c1df;font-size:13px;line-height:1.6}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px;margin-top:20px}
    .card{background:#121938;border:1px solid #26304f;border-radius:16px;padding:14px}
    .imgbox{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
    .imgbox figure{margin:0}
    .imgbox img{width:100%;height:180px;object-fit:contain;background:#0a0f22;border-radius:10px;border:1px solid #1f2950}
    .imgbox figcaption{font-size:12px;color:#9eabd6;margin-top:6px}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#b8c1df;word-break:break-all;line-height:1.5}
    .ok{color:#7cf0a9}
    .bad{color:#ff8e8e}
    a{color:#8ec5ff}
  </style>
CSS
html << "<h1>#{package_name}</h1>"
html << "<p class=\"meta\">packageId: <code>#{PACKAGE_ID}</code><br>packageHash: <code>#{PKG_HASH}</code><br>PersistStore: <code>#{PERSIST_STORE}</code><br>ThumbStore: <code>#{THUMB_STORE}</code></p>"
html << "<p class=\"meta\">说明：这个页面只展示这个专辑本身。已解出来的真图会直接显示；没解出来的成员不会伪造图，只保留切片文件链接。</p>"
html << '<div class="grid">'

manifest.each do |item|
  html << '<div class="card">'
  html << "<h2>##{item[:sortOrder]}</h2>"
  html << "<div class=\"imgbox\">"
  if item[:recoveredFull].is_a?(String) && item[:recoveredFull].start_with?('images/')
    html << "<figure><img src=\"#{item[:recoveredFull]}\"><figcaption>已解出的完整真图</figcaption></figure>"
  else
    html << "<figure><div class=\"mono bad\">完整真图：未恢复</div><figcaption>无伪造</figcaption></figure>"
  end
  if item[:recoveredThumb].is_a?(String) && item[:recoveredThumb].start_with?('images/')
    html << "<figure><img src=\"#{item[:recoveredThumb]}\"><figcaption>远端缩略图</figcaption></figure>"
  else
    html << "<figure><div class=\"mono bad\">缩略图：未恢复</div><figcaption>无伪造</figcaption></figure>"
  end
  html << '</div>'
  html << "<div class=\"mono\">md5: #{item[:md5]}<br>persist: offset=#{item[:emoticonOffset]} size=#{item[:emoticonSize]} · <a href=\"#{item[:persistSlice]}\">slice</a><br>thumb: offset=#{item[:thumbOffset]} size=#{item[:thumbSize]} · <a href=\"#{item[:thumbSlice]}\">slice</a><br>aesKey: #{item[:aesKey] || '-'}<br>remote decrypt: <span class=\"#{item[:hasRemoteDecrypt] ? 'ok' : 'bad'}\">#{item[:hasRemoteDecrypt] ? 'yes' : 'no'}</span></div>"
  html << '</div>'
end

html << '</div>'

File.write(File.join(out_dir, 'index.html'), html.join)

puts JSON.pretty_generate({
  packageId: PACKAGE_ID,
  packageName: package_name,
  output: out_dir,
  recoveredFullCount: manifest.count { |item| item[:recoveredFull].is_a?(String) && item[:recoveredFull].start_with?('images/') },
  recoveredThumbCount: manifest.count { |item| item[:recoveredThumb].is_a?(String) && item[:recoveredThumb].start_with?('images/') }
})
