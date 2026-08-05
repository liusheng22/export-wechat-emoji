import { invoke } from '@tauri-apps/api/tauri'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadEmojiBinary } from './emoji-binary-cache'
import { copyEmojiFile } from './emoji-file-cache'

vi.mock('@tauri-apps/api/tauri', () => ({
  invoke: vi.fn()
}))

vi.mock('./emoji-binary-cache', () => ({
  loadEmojiBinary: vi.fn()
}))

const invokeMock = vi.mocked(invoke)
const loadEmojiBinaryMock = vi.mocked(loadEmojiBinary)

beforeEach(() => {
  invokeMock.mockReset()
  loadEmojiBinaryMock.mockReset()
})

describe('emoji file cache', () => {
  it('copies a cross-session disk cache hit without loading image bytes', async () => {
    invokeMock.mockResolvedValueOnce(true)

    await copyEmojiFile('https://example.com/stodownload?m=cached')

    expect(invokeMock).toHaveBeenCalledWith('copy_cached_emoji_file', {
      sourceUrl: 'https://example.com/stodownload?m=cached'
    })
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(loadEmojiBinaryMock).not.toHaveBeenCalled()
  })

  it('downloads once, persists the detected original format, and copies the file', async () => {
    invokeMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce('/tmp/cache/emoji.gif')
    loadEmojiBinaryMock.mockResolvedValue({
      buffer: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).buffer,
      usedUrl: 'https://example.com/stodownload.gif?m=new',
      contentType: 'image/gif',
      ext: 'gif'
    })

    await copyEmojiFile('https://example.com/stodownload?m=new')

    expect(loadEmojiBinaryMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'cache_and_copy_emoji_file', {
      sourceUrl: 'https://example.com/stodownload?m=new',
      bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
      ext: 'gif'
    })
  })
})
