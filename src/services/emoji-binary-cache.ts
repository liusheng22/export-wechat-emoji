import { fetchBinaryWithFallback } from './downloader'
import {
  extFromBytes,
  extFromContentType,
  extFromUrl
} from './stodownload'

const MAX_CACHE_ENTRIES = 64
const MAX_CACHE_BYTES = 64 * 1024 * 1024

export type EmojiBinary = {
  buffer: ArrayBuffer
  usedUrl: string
  contentType: string
  ext: 'gif' | 'png' | 'webp' | 'jpg'
}

const completed = new Map<string, EmojiBinary>()
const inFlight = new Map<string, Promise<EmojiBinary>>()
let completedBytes = 0

function cacheKey(src: string): string {
  return src
    .trim()
    .replace(/\/stodownload\.(?:gif|png|webp|jpe?g)(?=\?)/i, '/stodownload')
}

function mimeTypeForExt(ext: EmojiBinary['ext']): string {
  switch (ext) {
    case 'gif':
      return 'image/gif'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'jpg':
      return 'image/jpeg'
  }
}

function cloneResult(result: EmojiBinary): EmojiBinary {
  return { ...result, buffer: result.buffer.slice(0) }
}

function touch(key: string, result: EmojiBinary) {
  completed.delete(key)
  completed.set(key, result)
}

function store(key: string, result: EmojiBinary) {
  const previous = completed.get(key)
  if (previous) {
    completedBytes -= previous.buffer.byteLength
  }
  touch(key, result)
  completedBytes += result.buffer.byteLength

  while (
    completed.size > MAX_CACHE_ENTRIES ||
    completedBytes > MAX_CACHE_BYTES
  ) {
    const oldestKey = completed.keys().next().value as string | undefined
    if (!oldestKey) {
      break
    }
    const oldest = completed.get(oldestKey)
    completed.delete(oldestKey)
    completedBytes -= oldest?.buffer.byteLength ?? 0
  }
}

async function fetchEmojiBinary(src: string): Promise<EmojiBinary> {
  const result = await fetchBinaryWithFallback(src)
  if (!result.ok) {
    throw result.error instanceof Error
      ? result.error
      : new Error('表情图片下载失败')
  }

  const detected =
    extFromBytes(result.buffer) ||
    extFromContentType(result.contentType) ||
    extFromUrl(result.usedUrl)
  const ext = detected === 'jpeg' ? 'jpg' : detected
  if (ext !== 'gif' && ext !== 'png' && ext !== 'webp' && ext !== 'jpg') {
    throw new Error('无法识别表情图片格式')
  }

  return {
    buffer: result.buffer,
    usedUrl: result.usedUrl,
    contentType: mimeTypeForExt(ext),
    ext
  }
}

export async function loadEmojiBinary(src: string): Promise<EmojiBinary> {
  const key = cacheKey(src)
  const cached = completed.get(key)
  if (cached) {
    touch(key, cached)
    return cloneResult(cached)
  }

  let pending = inFlight.get(key)
  if (!pending) {
    pending = fetchEmojiBinary(src)
      .then((result) => {
        store(key, result)
        return result
      })
      .finally(() => {
        inFlight.delete(key)
      })
    inFlight.set(key, pending)
  }

  return cloneResult(await pending)
}

export function clearEmojiBinaryCacheForTests() {
  completed.clear()
  inFlight.clear()
  completedBytes = 0
}
