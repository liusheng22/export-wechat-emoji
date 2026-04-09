import type { EmojiAlbum, EmoticonRenderItem } from '../types'
import { invoke } from '@tauri-apps/api/tauri'

export type StickerHubAlbumState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'stale'
  | 'not_found'
  | 'offline'
  | 'rate_limited'
  | 'error'

export interface StickerHubAlbumMember {
  memberIndex: number | null
  md5: string
  previewUrl: string | null
  downloadUrl: string | null
}

export interface StickerHubAlbumPayload {
  schemaVersion: 1
  productId: string
  iconUrl: string | null
  version: string | null
  members: StickerHubAlbumMember[]
}

export interface StickerHubCacheReadResult {
  status: 'fresh' | 'stale' | 'missing'
  payload: StickerHubAlbumPayload | null
  etag: string | null
}

export interface StickerHubRefreshResult {
  status:
    | 'ready'
    | 'not_found'
    | 'invalid_request'
    | 'offline'
    | 'rate_limited'
    | 'error'
  payload: StickerHubAlbumPayload | null
  retryAfterSeconds: number | null
}

const refreshTasks = new Map<string, Promise<StickerHubRefreshResult>>()

export async function readStickerHubAlbumCache(
  productId: string
): Promise<StickerHubCacheReadResult> {
  return await invoke<StickerHubCacheReadResult>(
    'read_stickerhub_album_cache',
    { productId }
  )
}

export function refreshStickerHubAlbum(
  productId: string
): Promise<StickerHubRefreshResult> {
  const active = refreshTasks.get(productId)
  if (active) {
    return active
  }

  const task = invoke<StickerHubRefreshResult>('refresh_stickerhub_album', {
    productId
  }).finally(() => {
    if (refreshTasks.get(productId) === task) {
      refreshTasks.delete(productId)
    }
  })
  refreshTasks.set(productId, task)
  return task
}

function normalizedMd5(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
}

export function buildStickerHubAlbumItems(
  album: EmojiAlbum,
  payload: StickerHubAlbumPayload | null
): EmoticonRenderItem[] {
  if (!payload || payload.productId !== album.packageId) {
    return []
  }

  const seen = new Set<string>()
  return payload.members
    .map((member, sourceIndex) => ({ member, sourceIndex }))
    .sort(
      (left, right) =>
        (left.member.memberIndex ?? Number.MAX_SAFE_INTEGER) -
          (right.member.memberIndex ?? Number.MAX_SAFE_INTEGER) ||
        left.sourceIndex - right.sourceIndex
    )
    .flatMap(({ member }) => {
      const md5 = normalizedMd5(member.md5)
      if (!md5 || seen.has(md5)) {
        return []
      }
      seen.add(md5)

      // The thumbnail host is not consistently reachable from the desktop webview.
      // The full resource URL is also the source that preserves animated GIFs.
      const downloadUrl = member.downloadUrl || undefined
      const previewUrl = member.previewUrl || undefined
      const src = downloadUrl || previewUrl
      if (!src) {
        return []
      }
      return [
        {
          id: `${album.id}:${md5}`,
          md5,
          src,
          downloadUrl,
          previewUrl
        }
      ]
    })
}
