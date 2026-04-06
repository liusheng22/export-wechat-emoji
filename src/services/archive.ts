import type {
  EmoticonCatalogResult,
  EmoticonRenderItem,
  IMaybeUrl
} from '../types'
import { convertFileSrc, invoke } from '@tauri-apps/api/tauri'

export async function extractFavUrls(
  favArchivePath: string
): Promise<Array<string>> {
  return await invoke<Array<string>>('extract_fav_urls', { favArchivePath })
}

export async function extractEmoticonUrlsV4(
  emoticonDbPath: string,
  dbKey: string
): Promise<Array<string>> {
  return await invoke<Array<string>>('extract_emoticon_urls_v4', {
    emoticonDbPath,
    dbKey
  })
}

export type AutoDumpUrlsResult = {
  wxid: string
  dbKey: string
  dbKeyFile: string
  urlsFile: string
  logFile: string
  urls: Array<string>
}

export async function autoDumpEmoticonUrlsV4(
  wxidDir: string,
  wechatAppPath?: string
): Promise<AutoDumpUrlsResult> {
  return await invoke<AutoDumpUrlsResult>('auto_dump_emoticon_urls_v4', {
    wechatAppPath,
    wxidDir
  })
}

export async function buildEmoticonCatalogV4(
  wxidDir: string,
  dbKey: string
): Promise<EmoticonCatalogResult> {
  return await invoke<EmoticonCatalogResult>('build_emoticon_catalog_v4', {
    wxidDir,
    dbKey
  })
}

function isRemoteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(String(value || '').trim())
}

function decodeLocalPath(value: string): string {
  const src = String(value || '').trim()
  if (!src) {
    return ''
  }
  if (/^file:\/\//i.test(src)) {
    return decodeURI(src.replace(/^file:\/\//i, ''))
  }
  return src
}

function isLocalPathLike(value: string): boolean {
  const src = String(value || '').trim()
  return Boolean(src) && !isRemoteHttpUrl(src) && !/^data:image\//i.test(src)
}

function normalizeRenderableSrc(value: string): string {
  const src = String(value || '').trim()
  if (!src) {
    return ''
  }
  if (isRemoteHttpUrl(src) || /^data:image\//i.test(src)) {
    return src
  }
  return convertFileSrc(decodeLocalPath(src))
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

export function buildEmojiItemsFromRenderItems(
  renderItems: Array<EmoticonRenderItem>
): Array<IMaybeUrl> {
  const out: Array<IMaybeUrl> = []

  for (const item of renderItems) {
    const src = normalizeRenderableSrc(item.src)
    if (!src) {
      continue
    }
    const localSourcePath = isLocalPathLike(item.src)
      ? decodeLocalPath(item.src)
      : undefined

    out.push({
      _text: item.downloadUrl || localSourcePath || item.src || item.id,
      src,
      fallbackIndex: 0,
      downloadUrl: item.downloadUrl,
      previewUrl: item.previewUrl,
      localSourcePath: localSourcePath || item.localSourcePath,
      md5: item.md5
    })
  }

  return out
}

export function buildEmojiItems(
  rawUrls: Array<string>,
  opts: { wxappDomain: string; vweixinfDomain: string }
): Array<IMaybeUrl> {
  return rawUrls
    .filter((url) => String(url).match(/http[s]?:\/\/[^\s]+/))
    .map((url) => {
      const src = normalizeEmojiUrl(url, opts)
      return { _text: src, src, fallbackIndex: 0, downloadUrl: src }
    })
}
