export const EXPORT_SETTINGS_STORAGE_KEY = 'wxemoticon_export_settings'

export type ExportGroupMode = 'recommended' | 'none' | 'custom'

export type PersistedExportSettingsV1 = {
  version: 1
  groupMode: ExportGroupMode
  customGroupSize: number
  resume: boolean
  autoOpen: boolean
}

export const DEFAULT_EXPORT_SETTINGS: PersistedExportSettingsV1 = {
  version: 1,
  groupMode: 'recommended',
  customGroupSize: 50,
  resume: true,
  autoOpen: true
}

type ExportSettingsStorage = Pick<Storage, 'getItem' | 'setItem'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGroupMode(value: unknown): value is ExportGroupMode {
  return value === 'recommended' || value === 'none' || value === 'custom'
}

export function normalizeCustomGroupSize(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 1 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    return DEFAULT_EXPORT_SETTINGS.customGroupSize
  }
  return Math.floor(value)
}

export function normalizeExportSettings(
  value: unknown
): PersistedExportSettingsV1 {
  if (!isRecord(value) || value.version !== 1) {
    return { ...DEFAULT_EXPORT_SETTINGS }
  }

  return {
    version: 1,
    groupMode: isGroupMode(value.groupMode)
      ? value.groupMode
      : DEFAULT_EXPORT_SETTINGS.groupMode,
    customGroupSize: normalizeCustomGroupSize(value.customGroupSize),
    resume:
      typeof value.resume === 'boolean'
        ? value.resume
        : DEFAULT_EXPORT_SETTINGS.resume,
    autoOpen:
      typeof value.autoOpen === 'boolean'
        ? value.autoOpen
        : DEFAULT_EXPORT_SETTINGS.autoOpen
  }
}

function browserStorage(): ExportSettingsStorage | null {
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

export function writeExportSettings(
  value: unknown,
  storage: ExportSettingsStorage | null = browserStorage()
): PersistedExportSettingsV1 {
  const normalized = normalizeExportSettings(value)
  try {
    storage?.setItem(EXPORT_SETTINGS_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // Storage can be unavailable; keep the normalized in-memory value usable.
  }
  return normalized
}

export function readExportSettings(
  storage: ExportSettingsStorage | null = browserStorage()
): PersistedExportSettingsV1 {
  let parsed: unknown
  try {
    const raw = storage?.getItem(EXPORT_SETTINGS_STORAGE_KEY)
    parsed = raw ? JSON.parse(raw) : undefined
  } catch {
    parsed = undefined
  }

  return writeExportSettings(parsed, storage)
}
