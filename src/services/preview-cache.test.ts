import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearPreviewCache,
  readPreviewCache,
  writePreviewCache
} from './preview-cache'

describe('account preview cache', () => {
  beforeEach(() => localStorage.clear())

  it('keeps caches isolated by the encoded target id', () => {
    writePreviewCache('v4|account-a', ['https://example.com/a.gif'])
    writePreviewCache('v4|account-b', ['https://example.com/b.gif'])

    expect(readPreviewCache('v4|account-a')?.urls).toEqual([
      'https://example.com/a.gif'
    ])
    clearPreviewCache('v4|account-a')
    expect(readPreviewCache('v4|account-a')).toBeNull()
    expect(readPreviewCache('v4|account-b')?.urls).toEqual([
      'https://example.com/b.gif'
    ])
  })

  it('rejects malformed or mismatched cache records', () => {
    localStorage.setItem(
      'wxemoticon_preview_cache|v4|account-a',
      JSON.stringify({
        version: 1,
        targetId: 'v4|account-b',
        urls: ['javascript:alert(1)'],
        updatedAt: '2026-07-30T00:00:00.000Z'
      })
    )

    expect(readPreviewCache('v4|account-a')).toBeNull()
  })
})
