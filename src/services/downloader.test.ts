import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  get: vi.fn()
}))

vi.mock('@tauri-apps/api/http', () => ({
  ResponseType: { Binary: 3 },
  getClient: mocks.getClient
}))

vi.mock('@tauri-apps/api/fs', () => ({
  readBinaryFile: vi.fn()
}))

import { fetchBinaryWithFallback } from './downloader'

describe('fetchBinaryWithFallback', () => {
  beforeEach(() => {
    mocks.getClient.mockReset()
    mocks.get.mockReset()
    mocks.getClient.mockResolvedValue({ get: mocks.get })
    vi.stubGlobal('fetch', undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders an extensionless GIF served by the HTTP Tencent endpoint', async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x3b])
    mocks.get.mockResolvedValue({
      status: 200,
      data: gif.buffer,
      headers: { 'content-type': 'application/octet-stream' }
    })

    const result = await fetchBinaryWithFallback(
      'https://vweixinf.tc.qq.com/110/20401/stodownload?m=resource&filekey=key'
    )

    expect(result).toMatchObject({
      ok: true,
      usedUrl:
        'http://wxapp.tc.qq.com/110/20401/stodownload?m=resource&filekey=key'
    })
    if (result.ok) {
      expect(new Uint8Array(result.buffer)).toEqual(gif)
    }
    expect(mocks.get).toHaveBeenCalledWith(
      'http://wxapp.tc.qq.com/110/20401/stodownload?m=resource&filekey=key',
      { responseType: 3 }
    )
  })

  it('hydrates an mmbiz GIF without relying on a file extension', async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x3b])
    const url = 'https://mmbiz.qpic.cn/mmemoticon/example/0'
    mocks.get.mockResolvedValue({
      status: 200,
      data: gif.buffer,
      headers: { 'content-type': 'image/gif' }
    })

    const result = await fetchBinaryWithFallback(url)

    expect(result).toMatchObject({ ok: true, usedUrl: url })
    if (result.ok) {
      expect(new Uint8Array(result.buffer)).toEqual(gif)
    }
  })

  it('uses browser CORS for mmbiz before falling back to Tauri HTTP', async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x3b])
    const url = 'https://mmbiz.qpic.cn/mmemoticon/example/0'
    const browserFetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'image/gif' },
      arrayBuffer: async () => gif.buffer
    }))
    vi.stubGlobal('fetch', browserFetch)
    mocks.getClient.mockRejectedValue(new Error('Tauri HTTP should not run'))

    const result = await fetchBinaryWithFallback(url)

    expect(result).toMatchObject({ ok: true, usedUrl: url })
    expect(browserFetch).toHaveBeenCalledWith(url, {
      headers: { Accept: 'image/*' }
    })
    expect(mocks.getClient).not.toHaveBeenCalled()
  })

  it('stops a hanging image request after the global timeout', async () => {
    vi.useFakeTimers()
    try {
      mocks.get.mockReturnValue(new Promise(() => {}))
      const resultPromise = fetchBinaryWithFallback(
        'https://mmbiz.qpic.cn/mmemoticon/example/0'
      )

      await vi.advanceTimersByTimeAsync(8000)

      await expect(resultPromise).resolves.toMatchObject({ ok: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips non-image responses and continues with the next resource variant', async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x3b])
    mocks.get
      .mockResolvedValueOnce({
        status: 404,
        data: new TextEncoder().encode('not found').buffer,
        headers: { 'content-type': 'text/plain' }
      })
      .mockResolvedValueOnce({
        status: 200,
        data: gif.buffer,
        headers: { 'content-type': 'application/octet-stream' }
      })

    const result = await fetchBinaryWithFallback(
      'https://vweixinf.tc.qq.com/110/20401/stodownload?m=resource&filekey=key'
    )

    expect(result).toMatchObject({
      ok: true,
      usedUrl:
        'http://wxapp.tc.qq.com/110/20401/stodownload.gif?m=resource&filekey=key'
    })
    expect(mocks.get).toHaveBeenCalledTimes(2)
  })
})
