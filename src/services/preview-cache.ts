import type { AutoDumpUrlsResult } from './archive'

export type PreviewCacheV1 = {
  version: 1
  targetId: string
  urls: Array<string>
  updatedAt: string
  artifacts?: AutoDumpUrlsResult
}

const PREVIEW_CACHE_PREFIX = 'wxemoticon_preview_cache|'

function storageKey(targetId: string): string {
  return `${PREVIEW_CACHE_PREFIX}${targetId}`
}

function validUrls(value: unknown): Array<string> | null {
  if (!Array.isArray(value)) {
    return null
  }
  const urls = value.filter(
    (item): item is string =>
      typeof item === 'string' && /^https?:\/\/\S+$/.test(item.trim())
  )
  return urls.length === value.length && urls.length > 0 ? urls : null
}

function validArtifacts(value: unknown): AutoDumpUrlsResult | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const candidate = value as Partial<AutoDumpUrlsResult>
  if (
    typeof candidate.wxid !== 'string' ||
    typeof candidate.dbKey !== 'string' ||
    typeof candidate.dbKeyFile !== 'string' ||
    typeof candidate.urlsFile !== 'string' ||
    typeof candidate.logFile !== 'string' ||
    !Array.isArray(candidate.urls)
  ) {
    return undefined
  }
  return candidate as AutoDumpUrlsResult
}

export function readPreviewCache(targetId: string): PreviewCacheV1 | null {
  try {
    const raw = localStorage.getItem(storageKey(targetId))
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Partial<PreviewCacheV1>
    const urls = validUrls(parsed.urls)
    if (
      parsed.version !== 1 ||
      parsed.targetId !== targetId ||
      typeof parsed.updatedAt !== 'string' ||
      !urls
    ) {
      return null
    }
    return {
      version: 1,
      targetId,
      urls,
      updatedAt: parsed.updatedAt,
      artifacts: validArtifacts(parsed.artifacts)
    }
  } catch {
    return null
  }
}

export function writePreviewCache(
  targetId: string,
  urls: Array<string>,
  artifacts?: AutoDumpUrlsResult
): void {
  const valid = validUrls(urls)
  if (!valid) {
    return
  }
  const cache: PreviewCacheV1 = {
    version: 1,
    targetId,
    urls: valid,
    updatedAt: new Date().toISOString(),
    ...(artifacts ? { artifacts } : {})
  }
  try {
    localStorage.setItem(storageKey(targetId), JSON.stringify(cache))
  } catch {
    // Preview remains usable in memory if persistent storage is unavailable.
  }
}

export function clearPreviewCache(targetId: string): void {
  try {
    localStorage.removeItem(storageKey(targetId))
  } catch {
    // The existing on-disk cleanup still runs even if storage is unavailable.
  }
}
