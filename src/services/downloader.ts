import { readBinaryFile } from '@tauri-apps/api/fs'
import { getClient, ResponseType } from '@tauri-apps/api/http'
import { extFromBytes, getStodownloadCandidates } from './stodownload'

const BINARY_REQUEST_TIMEOUT_MS = 8000
const BROWSER_FETCH_TIMEOUT_MS = 3000

export type FetchBinaryResult =
  | { ok: true; buffer: ArrayBuffer; usedUrl: string; contentType?: string }
  | { ok: false; error: unknown }

function extractEmbeddedImageBytes(bytes: Uint8Array): Uint8Array | null {
  const len = bytes.length
  if (extFromBytes(bytes)) {
    return bytes
  }

  for (let index = 0; index < len; index += 1) {
    if (
      index + 3 <= len &&
      bytes[index] === 0xff &&
      bytes[index + 1] === 0xd8 &&
      bytes[index + 2] === 0xff
    ) {
      for (let pos = index + 2; pos + 1 < len; pos += 1) {
        if (bytes[pos] === 0xff && bytes[pos + 1] === 0xd9) {
          return bytes.slice(index, pos + 2)
        }
      }
    }

    if (
      index + 6 <= len &&
      ((bytes[index] === 0x47 &&
        bytes[index + 1] === 0x49 &&
        bytes[index + 2] === 0x46 &&
        bytes[index + 3] === 0x38 &&
        bytes[index + 4] === 0x37 &&
        bytes[index + 5] === 0x61) ||
        (bytes[index] === 0x47 &&
          bytes[index + 1] === 0x49 &&
          bytes[index + 2] === 0x46 &&
          bytes[index + 3] === 0x38 &&
          bytes[index + 4] === 0x39 &&
          bytes[index + 5] === 0x61))
    ) {
      // Keep trailing bytes from the wrapper. GIF decoders stop at the trailer,
      // while scanning for the first 0x3b can cut valid LZW data by accident.
      return bytes.slice(index)
    }

    if (
      index + 8 <= len &&
      bytes[index] === 0x89 &&
      bytes[index + 1] === 0x50 &&
      bytes[index + 2] === 0x4e &&
      bytes[index + 3] === 0x47 &&
      bytes[index + 4] === 0x0d &&
      bytes[index + 5] === 0x0a &&
      bytes[index + 6] === 0x1a &&
      bytes[index + 7] === 0x0a
    ) {
      let pos = index + 8
      while (pos + 8 <= len) {
        const chunkLen =
          ((bytes[pos] << 24) >>> 0) |
          (bytes[pos + 1] << 16) |
          (bytes[pos + 2] << 8) |
          bytes[pos + 3]
        if (pos + 12 + chunkLen > len) {
          break
        }
        const isIend =
          bytes[pos + 4] === 0x49 &&
          bytes[pos + 5] === 0x45 &&
          bytes[pos + 6] === 0x4e &&
          bytes[pos + 7] === 0x44
        pos += 12 + chunkLen
        if (isIend) {
          return bytes.slice(index, pos)
        }
      }
    }

    if (
      index + 12 <= len &&
      bytes[index] === 0x52 &&
      bytes[index + 1] === 0x49 &&
      bytes[index + 2] === 0x46 &&
      bytes[index + 3] === 0x46 &&
      bytes[index + 8] === 0x57 &&
      bytes[index + 9] === 0x45 &&
      bytes[index + 10] === 0x42 &&
      bytes[index + 11] === 0x50
    ) {
      const chunkLen =
        (bytes[index + 4] |
          (bytes[index + 5] << 8) |
          (bytes[index + 6] << 16) |
          (bytes[index + 7] << 24)) >>>
        0
      const end = index + 8 + chunkLen
      if (end <= len) {
        return bytes.slice(index, end)
      }
    }
  }

  return extFromBytes(bytes) ? bytes : null
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('image request timed out'))
    }, timeoutMs)

    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function imageResultFromBytes(
  raw: ArrayBuffer | Uint8Array | ArrayLike<number>,
  usedUrl: string,
  contentType?: string
): FetchBinaryResult | null {
  const rawBytes =
    raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>)
  const sliced = extractEmbeddedImageBytes(rawBytes) || rawBytes
  const detectedExt = extFromBytes(sliced)
  const isImageContent = contentType?.toLowerCase().startsWith('image/')
  if (!detectedExt && !isImageContent) {
    return null
  }
  const buffer = sliced.buffer.slice(
    sliced.byteOffset,
    sliced.byteOffset + sliced.byteLength
  )
  return { ok: true, buffer, usedUrl, contentType }
}

async function fetchMmbizWithBrowser(
  url: string,
  timeoutMs: number
): Promise<FetchBinaryResult | null> {
  const browserFetch = globalThis.fetch
  if (
    typeof browserFetch !== 'function' ||
    !/^https:\/\/mmbiz\.qpic\.cn\//i.test(url)
  ) {
    return null
  }

  try {
    const response = await withTimeout(
      browserFetch(url, { headers: { Accept: 'image/*' } }),
      timeoutMs
    )
    if (!response.ok) {
      return null
    }
    const contentType = response.headers.get('content-type') || undefined
    const buffer = await withTimeout(response.arrayBuffer(), timeoutMs)
    return imageResultFromBytes(buffer, url, contentType)
  } catch {
    return null
  }
}

export async function fetchBinaryWithFallback(
  src: string
): Promise<FetchBinaryResult> {
  const normalizedSrc = String(src || '').trim()

  if (/^file:\/\//i.test(normalizedSrc)) {
    const filePath = decodeURI(normalizedSrc.replace(/^file:\/\//i, ''))
    try {
      const bytes = new Uint8Array(await readBinaryFile(filePath))
      const sliced = extractEmbeddedImageBytes(bytes) || bytes
      return {
        ok: true,
        buffer: sliced.buffer.slice(
          sliced.byteOffset,
          sliced.byteOffset + sliced.byteLength
        ),
        usedUrl: normalizedSrc
      }
    } catch {
      return { ok: false, error: new Error('read local file failed') }
    }
  }

  const candidates = getStodownloadCandidates(normalizedSrc)
  const deadline = Date.now() + BINARY_REQUEST_TIMEOUT_MS
  let client: Awaited<ReturnType<typeof getClient>> | null = null

  for (const url of candidates) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      break
    }

    const browserResult = await fetchMmbizWithBrowser(
      url,
      Math.min(BROWSER_FETCH_TIMEOUT_MS, remainingMs)
    )
    if (browserResult) {
      return browserResult
    }

    if (!client) {
      try {
        client = await withTimeout(getClient(), remainingMs)
      } catch {
        return { ok: false, error: new Error('http client unavailable') }
      }
    }

    try {
      const res = await withTimeout(
        client.get(url, { responseType: ResponseType.Binary }),
        remainingMs
      )
      const status = (res as unknown as { status?: number }).status
      if (typeof status === 'number' && (status < 200 || status >= 300)) {
        continue
      }
      const raw = res.data as ArrayBuffer | Uint8Array
      const headers = (res as unknown as { headers?: Record<string, string> })
        .headers
      const contentType = headers?.['content-type'] || headers?.['Content-Type']
      const imageResult = imageResultFromBytes(raw, url, contentType)
      if (!imageResult) {
        continue
      }
      return imageResult
    } catch {
      // Try next candidate.
    }
  }

  return { ok: false, error: new Error('download failed for all candidates') }
}
