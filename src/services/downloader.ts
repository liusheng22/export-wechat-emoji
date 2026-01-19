import { getClient, ResponseType } from '@tauri-apps/api/http'
import { getStodownloadCandidates } from './stodownload'

export type FetchBinaryResult =
  | { ok: true; buffer: ArrayBuffer; usedUrl: string; contentType?: string }
  | { ok: false; error: unknown }

export async function fetchBinaryWithFallback(
  src: string
): Promise<FetchBinaryResult> {
  const client = await getClient()
  const candidates = getStodownloadCandidates(src)

  for (const url of candidates) {
    try {
      const res = await client.get(url, { responseType: ResponseType.Binary })
      const buffer = res.data as ArrayBuffer
      const headers = (res as unknown as { headers?: Record<string, string> })
        .headers
      const contentType = headers?.['content-type'] || headers?.['Content-Type']
      return { ok: true, buffer, usedUrl: url, contentType }
    } catch {
      // Try next candidate.
    }
  }

  return { ok: false, error: new Error('download failed for all candidates') }
}
