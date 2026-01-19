export function getStodownloadCandidates(url: string): Array<string> {
  // WeChat sticker URLs are often `.../stodownload?...`. Some resources require a correct
  // suffix (jpg/gif/png/webp) to be served/rendered, so we try multiple variants.
  const exts = ['gif', 'jpg', 'png', 'webp'] as const

  if (!url.includes('/stodownload')) {
    return [url]
  }

  const replaceExt = (ext: (typeof exts)[number]) =>
    url.replace(/\/stodownload(?:\.[a-z0-9]+)?\?/i, `/stodownload.${ext}?`)

  const candidates = [url, ...exts.map(replaceExt)]
  return Array.from(new Set(candidates))
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

export function extFromUrl(url: string): string | null {
  const m = url.match(/\/stodownload\.([a-z0-9]+)\?/i)
  return m?.[1]?.toLowerCase() || null
}
