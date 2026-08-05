import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchBinaryWithFallback } from './downloader'
import {
  clearEmojiBinaryCacheForTests,
  loadEmojiBinary
} from './emoji-binary-cache'

vi.mock('./downloader', () => ({
  fetchBinaryWithFallback: vi.fn()
}))

const fetchMock = vi.mocked(fetchBinaryWithFallback)
const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])

beforeEach(() => {
  clearEmojiBinaryCacheForTests()
  fetchMock.mockReset()
})

describe('emoji binary cache', () => {
  it('deduplicates concurrent requests and normalizes stodownload suffixes', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof fetchBinaryWithFallback>>) => void
    const pending = new Promise<
      Awaited<ReturnType<typeof fetchBinaryWithFallback>>
    >((done) => {
      resolve = done
    })
    fetchMock.mockReturnValue(pending)

    const raw = 'https://wxapp.tc.qq.com/stodownload?m=same'
    const first = loadEmojiBinary(raw)
    const second = loadEmojiBinary(
      'https://wxapp.tc.qq.com/stodownload.gif?m=same'
    )
    resolve({
      ok: true,
      buffer: gifBytes.buffer,
      usedUrl: `${raw}&download=1`,
      contentType: 'application/octet-stream'
    })

    const [a, b] = await Promise.all([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a.ext).toBe('gif')
    expect(b.ext).toBe('gif')
    expect(a.buffer).not.toBe(b.buffer)
  })

  it('retries failures instead of caching them', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, error: new Error('network') })
      .mockResolvedValueOnce({
        ok: true,
        buffer: gifBytes.buffer,
        usedUrl: 'https://example.com/stodownload.gif?m=retry',
        contentType: 'image/gif'
      })

    await expect(
      loadEmojiBinary('https://example.com/stodownload?m=retry')
    ).rejects.toThrow('network')
    await expect(
      loadEmojiBinary('https://example.com/stodownload?m=retry')
    ).resolves.toMatchObject({ ext: 'gif', contentType: 'image/gif' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('serves successful results from cache without exposing mutable buffers', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      buffer: gifBytes.buffer,
      usedUrl: 'https://example.com/stodownload.gif?m=cached',
      contentType: 'image/gif'
    })

    const first = await loadEmojiBinary(
      'https://example.com/stodownload?m=cached'
    )
    new Uint8Array(first.buffer)[0] = 0
    const second = await loadEmojiBinary(
      'https://example.com/stodownload?m=cached'
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new Uint8Array(second.buffer)[0]).toBe(0x47)
  })
})
