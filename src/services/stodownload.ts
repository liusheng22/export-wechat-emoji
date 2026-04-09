export function getStodownloadCandidates(url: string): Array<string> {
  // Some Tencent sticker hosts expose the same resource over only one scheme and
  // omit the file extension. Try the wxapp HTTP endpoint, both schemes, and
  // common image suffixes.
  const exts = ['gif', 'jpg', 'png', 'webp'] as const

  if (!url.includes('/stodownload')) {
    return [url]
  }

  const schemeCandidates: string[] = []
  try {
    const original = new URL(url)
    const hosts =
      original.hostname === 'vweixinf.tc.qq.com'
        ? ['wxapp.tc.qq.com', 'vweixinf.tc.qq.com']
        : original.hostname === 'wxapp.tc.qq.com'
          ? ['wxapp.tc.qq.com']
          : []

    if (hosts.length) {
      for (const hostname of hosts) {
        const httpUrl = new URL(original)
        httpUrl.protocol = 'http:'
        httpUrl.hostname = hostname
        schemeCandidates.push(httpUrl.toString())

        if (original.protocol === 'https:') {
          const httpsUrl = new URL(original)
          httpsUrl.protocol = 'https:'
          httpsUrl.hostname = hostname
          schemeCandidates.push(httpsUrl.toString())
        }
      }
    } else {
      schemeCandidates.push(url)
    }
  } catch {
    // Keep the original URL when it is not a valid absolute URL.
    schemeCandidates.push(url)
  }

  const candidates = schemeCandidates.flatMap((candidate) => {
    const replaceExt = (ext: (typeof exts)[number]) =>
      candidate.replace(
        /\/stodownload(?:\.[a-z0-9]+)?\?/i,
        `/stodownload.${ext}?`
      )
    return [candidate, ...exts.map(replaceExt)]
  })
  return Array.from(new Set(candidates))
}

export function getBrowserPreviewSrc(url: string | undefined): string {
  const normalizedUrl = String(url || '').trim()
  if (!normalizedUrl) {
    return ''
  }

  try {
    const parsed = new URL(normalizedUrl)
    if (
      parsed.hostname === 'vweixinf.tc.qq.com' &&
      parsed.pathname.includes('/stodownload')
    ) {
      return getStodownloadCandidates(normalizedUrl)[0] || normalizedUrl
    }
  } catch {
    return normalizedUrl
  }

  return normalizedUrl
}

export function shouldHydrateRemoteImage(url: string | undefined): boolean {
  if (!url) {
    return false
  }
  try {
    const parsed = new URL(url)
    return parsed.hostname === 'mmbiz.qpic.cn'
  } catch {
    return false
  }
}

export function extFromContentType(
  contentType: string | undefined
): string | null {
  if (!contentType) {
    return null
  }
  const ct = contentType.toLowerCase()
  if (ct.includes('image/gif')) {
    return 'gif'
  }
  if (ct.includes('image/png')) {
    return 'png'
  }
  if (ct.includes('image/webp')) {
    return 'webp'
  }
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) {
    return 'jpg'
  }
  return null
}

export function extFromBytes(
  raw: ArrayBuffer | Uint8Array | ArrayLike<number> | undefined
): string | null {
  if (!raw) {
    return null
  }
  const bytes =
    raw instanceof Uint8Array
      ? raw
      : raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : new Uint8Array(Array.from(raw))

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x39 || bytes[4] === 0x37) &&
    bytes[5] === 0x61
  ) {
    return 'gif'
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp'
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'jpg'
  }
  return null
}

export function extFromUrl(url: string): string | null {
  const m = url.match(/\/stodownload\.([a-z0-9]+)\?/i)
  return m?.[1]?.toLowerCase() || null
}
