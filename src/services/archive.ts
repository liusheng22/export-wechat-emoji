import type { IMaybeUrl } from '../types'
import { invoke } from '@tauri-apps/api/tauri'

export async function extractFavUrls(
  favArchivePath: string
): Promise<Array<string>> {
  return await invoke<Array<string>>('extract_fav_urls', { favArchivePath })
}

export function normalizeEmojiUrl(
  url: string,
  opts: { wxappDomain: string; vweixinfDomain: string }
): string {
  let src = url

  // Normalize scheme.
  if (src.startsWith('http://')) {
    src = src.replace('http://', 'https://')
  }

  // Some URLs are returned with http + wxapp domain.
  if (src.includes(opts.wxappDomain)) {
    src = src.replace(
      `http://${opts.wxappDomain}`,
      `https://${opts.wxappDomain}`
    )
  }

  // Normalize domain to wxapp.
  if (src.includes(opts.vweixinfDomain)) {
    src = src.replace(opts.vweixinfDomain, opts.wxappDomain)
    // Ensure https after host replacement.
    if (src.startsWith('http://')) {
      src = src.replace('http://', 'https://')
    }
  }

  return src
}

export function buildEmojiItems(
  rawUrls: Array<string>,
  opts: { wxappDomain: string; vweixinfDomain: string }
): Array<IMaybeUrl> {
  return rawUrls
    .filter((url) => String(url).match(/http[s]?:\/\/[^\s]+/))
    .map((url) => {
      const src = normalizeEmojiUrl(url, opts)
      return { _text: src, src, fallbackIndex: 0 }
    })
}
