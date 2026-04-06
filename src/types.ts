export interface IMaybeUrl {
  _text: string
  src: string
  fallbackIndex?: number
  downloadUrl?: string
  previewUrl?: string
  localSourcePath?: string
  md5?: string
}

export interface ISelectOption {
  label: string
  value: string
}

export interface WeChatCurrentAccountProfile {
  wxid?: string
  displayName?: string
  avatarUrl?: string
}

export type EmoticonCatalogMode =
  | 'full'
  | 'partial'
  | 'favorites_only'
  | 'unavailable'

interface EmojiTargetMetaBase {
  mtimeMs: number | null
  displayName?: string
  avatarUrl?: string
  accountWxid?: string
  isCurrentLikelyAccount?: boolean
}

export interface V4EmojiTargetMeta extends EmojiTargetMetaBase {
  kind: 'v4'
  wxidDir: string
  emoticonDbPath: string
}

export interface LegacyEmojiTargetMeta extends EmojiTargetMetaBase {
  kind: 'legacy'
  versionDir: string
  userDir: string
  favArchivePath: string
}

export type EmojiTargetMeta = V4EmojiTargetMeta | LegacyEmojiTargetMeta

export interface EmoticonRenderItem {
  id: string
  md5: string
  src: string
  downloadUrl?: string
  previewUrl?: string
  localSourcePath?: string
}

export interface EmoticonAlbumMemberRef {
  md5: string
  sortOrder: number
}

export interface EmojiAlbum {
  id: string
  name: string
  count: number
  icon?: string
  iconFallback?: string
  urls: string[]
  items?: EmoticonRenderItem[]
  members?: EmoticonAlbumMemberRef[]
  packageId?: string
}

export interface EmoticonCatalogResult {
  mode: EmoticonCatalogMode
  warnings: string[]
  favorites: string[]
  albums: EmojiAlbum[]
}
