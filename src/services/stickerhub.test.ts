import type { EmojiAlbum } from '../types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/tauri', () => ({
  invoke: invokeMock
}))

import {
  buildStickerHubAlbumItems,
  refreshStickerHubAlbum,
  type StickerHubAlbumPayload
} from './stickerhub'

const productId = 'com.tencent.xin.emoticon.person.test_album'
const localMd5 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const missingMd5 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function album(): EmojiAlbum {
  return {
    id: productId,
    name: '测试专辑',
    count: 2,
    urls: [],
    packageId: productId,
    members: [
      { md5: missingMd5.toUpperCase(), sortOrder: 1 },
      { md5: localMd5, sortOrder: 2 }
    ],
    items: [
      {
        id: `${productId}:${localMd5}`,
        md5: localMd5.toUpperCase(),
        src: 'https://local.example/preview.gif',
        downloadUrl: 'https://local.example/full.gif'
      }
    ]
  }
}

function payload(): StickerHubAlbumPayload {
  return {
    schemaVersion: 1,
    productId,
    iconUrl: null,
    version: null,
    members: [
      {
        memberIndex: 1,
        md5: missingMd5,
        previewUrl: 'https://remote.example/preview.gif',
        downloadUrl: 'https://remote.example/full.gif'
      },
      {
        memberIndex: 2,
        md5: localMd5,
        previewUrl: 'https://remote.example/not-used.gif',
        downloadUrl: 'https://remote.example/not-used-full.gif'
      },
      {
        memberIndex: 3,
        md5: 'cccccccccccccccccccccccccccccccc',
        previewUrl: 'https://remote.example/extra.gif',
        downloadUrl: 'https://remote.example/extra-full.gif'
      }
    ]
  }
}

beforeEach(() => {
  invokeMock.mockReset()
})

describe('StickerHub album resources', () => {
  it('uses the complete remote album without mixing local resources', () => {
    const localAlbum = album()

    const items = buildStickerHubAlbumItems(localAlbum, payload())
    expect(items).toHaveLength(3)
    expect(items.map((item) => item.md5.toLowerCase())).toEqual([
      missingMd5,
      localMd5,
      'cccccccccccccccccccccccccccccccc'
    ])
    expect(items[0]).toMatchObject({
      src: 'https://remote.example/full.gif',
      downloadUrl: 'https://remote.example/full.gif',
      previewUrl: 'https://remote.example/preview.gif'
    })
    expect(items[1]).toMatchObject({
      src: 'https://remote.example/not-used-full.gif',
      downloadUrl: 'https://remote.example/not-used-full.gif',
      previewUrl: 'https://remote.example/not-used.gif'
    })
  })

  it('does not fall back to local album items for a mismatched payload', () => {
    const localAlbum = album()
    const mismatched = { ...payload(), productId: `${productId}_other` }
    expect(buildStickerHubAlbumItems(localAlbum, mismatched)).toEqual([])
  })

  it('coalesces concurrent refreshes for the same productId', async () => {
    let resolve!: (value: unknown) => void
    invokeMock.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )

    const first = refreshStickerHubAlbum(productId)
    const second = refreshStickerHubAlbum(productId)
    expect(first).toBe(second)
    expect(invokeMock).toHaveBeenCalledTimes(1)

    resolve({ status: 'ready', payload: payload(), retryAfterSeconds: null })
    await expect(first).resolves.toMatchObject({ status: 'ready' })
  })
})
