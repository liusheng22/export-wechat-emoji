import { describe, expect, it } from 'vitest'
import {
  extFromBytes,
  getStodownloadCandidates,
  getBrowserPreviewSrc,
  shouldHydrateRemoteImage
} from './stodownload'

describe('stodownload resources', () => {
  it('tries HTTP first for vweixinf resources and keeps extension variants', () => {
    const url =
      'https://vweixinf.tc.qq.com/110/20401/stodownload?m=resource&filekey=key'
    const candidates = getStodownloadCandidates(url)

    expect(candidates[0]).toBe(
      'http://wxapp.tc.qq.com/110/20401/stodownload?m=resource&filekey=key'
    )
    expect(candidates).toContain(
      'http://wxapp.tc.qq.com/110/20401/stodownload.gif?m=resource&filekey=key'
    )
    expect(candidates).toContain(
      'https://vweixinf.tc.qq.com/110/20401/stodownload.png?m=resource&filekey=key'
    )
  })

  it('normalizes vweixinf links for browser preview', () => {
    const url =
      'https://vweixinf.tc.qq.com/110/20401/stodownload?m=resource&filekey=key'

    expect(getBrowserPreviewSrc(url)).toBe(
      'http://wxapp.tc.qq.com/110/20401/stodownload?m=resource&filekey=key'
    )
  })

  it('only hydrates Tencent thumbnails that need binary recovery', () => {
    expect(
      shouldHydrateRemoteImage(
        'https://mmbiz.qpic.cn/mmemoticon/example/0'
      )
    ).toBe(true)
    expect(
      shouldHydrateRemoteImage(
        'https://vweixinf.tc.qq.com/110/20401/stodownload?m=resource'
      )
    ).toBe(false)
    expect(
      shouldHydrateRemoteImage(
        'https://wxapp.tc.qq.com/110/20401/stodownload?m=resource'
      )
    ).toBe(false)
    expect(shouldHydrateRemoteImage('https://example.com/image.gif')).toBe(false)
  })

  it('recognizes an extensionless GIF from its binary signature', () => {
    expect(
      extFromBytes(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
    ).toBe('gif')
  })

  it('recognizes PNG, JPEG and WebP signatures without relying on a URL suffix', () => {
    expect(
      extFromBytes(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    ).toBe('png')
    expect(extFromBytes(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('jpg')
    expect(
      extFromBytes(
        new Uint8Array([
          0x52,
          0x49,
          0x46,
          0x46,
          0x00,
          0x00,
          0x00,
          0x00,
          0x57,
          0x45,
          0x42,
          0x50
        ])
      )
    ).toBe('webp')
  })
})
