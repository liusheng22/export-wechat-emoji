import type { ISelectOption } from '../types'
import { BaseDirectory, exists, readDir } from '@tauri-apps/api/fs'
import { fileMtimeMs } from './system'

// Legacy (WeChat 3.x and earlier) path root. Real data lives in versioned subdirs like `2.0b4.0.9`.
export const WECHAT_LEGACY_BASE_DIR =
  'Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat'

// WeChat 4.x path root. Account dirs live directly under `xwechat_files`,
// but the dir name is not guaranteed to start with `wxid_`.
export const WECHAT_V4_BASE_DIR =
  'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files'

const WECHAT_V4_DB_SUFFIX = '/db_storage/emoticon/emoticon.db'

const WECHAT_V4_IGNORED_DIRS = new Set([
  'all_users',
  'Backup',
  'WMPF',
  'AppletCaches',
  'Update'
])

export type EmojiTarget =
  | { kind: 'legacy'; versionDir: string; userDir: string }
  | { kind: 'v4'; wxidDir: string }

export type EmojiTargetMeta =
  | {
      kind: 'v4'
      wxidDir: string
      emoticonDbPath: string
      mtimeMs: number | null
    }
  | {
      kind: 'legacy'
      versionDir: string
      userDir: string
      favArchivePath: string
      mtimeMs: number | null
    }

export function encodeEmojiTarget(target: EmojiTarget): string {
  if (target.kind === 'legacy') {
    return `legacy|${target.versionDir}|${target.userDir}`
  }
  return `v4|${target.wxidDir}`
}

export function parseEmojiTarget(value: string): EmojiTarget | null {
  if (!value) {
    return null
  }
  const parts = value.split('|')
  if (parts[0] === 'legacy' && parts.length === 3) {
    return { kind: 'legacy', versionDir: parts[1], userDir: parts[2] }
  }
  if (parts[0] === 'v4' && parts.length === 2) {
    return { kind: 'v4', wxidDir: parts[1] }
  }
  return null
}

export function legacyFavArchivePath(target: {
  versionDir: string
  userDir: string
}): string {
  return `${WECHAT_LEGACY_BASE_DIR}/${target.versionDir}/${target.userDir}/Stickers/fav.archive`
}

export function v4EmoticonDbPath(target: { wxidDir: string }): string {
  return `${WECHAT_V4_BASE_DIR}/${target.wxidDir}/db_storage/emoticon/emoticon.db`
}

export function shouldIgnoreWeChatV4Dir(name: string): boolean {
  if (!name) {
    return true
  }
  if (name.startsWith('.')) {
    return true
  }
  return WECHAT_V4_IGNORED_DIRS.has(name)
}

function joinRelativePath(parent: string, name: string): string {
  if (!parent) {
    return name
  }
  return `${parent}/${name}`
}

function pathHasHiddenSegment(path: string): boolean {
  return path
    .split('/')
    .filter(Boolean)
    .some((segment) => segment.startsWith('.'))
}

function extractV4AccountDirFromDbPath(path: string): string | null {
  if (!path.endsWith(WECHAT_V4_DB_SUFFIX)) {
    return null
  }
  const accountDir = path.slice(0, -WECHAT_V4_DB_SUFFIX.length)
  if (!accountDir) {
    return null
  }
  if (pathHasHiddenSegment(accountDir)) {
    return null
  }
  const topLevelDir = accountDir.split('/').filter(Boolean)[0] || ''
  if (shouldIgnoreWeChatV4Dir(topLevelDir)) {
    return null
  }
  return accountDir
}

function collectV4AccountDirsFromTree(
  entries: Awaited<ReturnType<typeof readDir>>,
  parent = '',
  out = new Set<string>()
): Set<string> {
  for (const entry of entries) {
    const name = entry?.name || ''
    if (!name) {
      continue
    }
    if (!parent && shouldIgnoreWeChatV4Dir(name)) {
      continue
    }
    if (name.startsWith('.')) {
      continue
    }

    const relativePath = joinRelativePath(parent, name)
    const accountDir = extractV4AccountDirFromDbPath(relativePath)
    if (accountDir) {
      out.add(accountDir)
    }

    if (entry.children?.length) {
      collectV4AccountDirsFromTree(entry.children, relativePath, out)
    }
  }
  return out
}

async function findWeChatV4AccountDirs(): Promise<Array<string>> {
  const dirs = await readDir(WECHAT_V4_BASE_DIR, {
    dir: BaseDirectory.Home,
    recursive: false
  })

  const directHits: Array<string> = []
  for (const dir of dirs) {
    const name = dir?.name || ''
    if (shouldIgnoreWeChatV4Dir(name)) {
      continue
    }
    const emoticonDb = v4EmoticonDbPath({ wxidDir: name })
    const ok = await exists(emoticonDb, { dir: BaseDirectory.Home })
    if (ok) {
      directHits.push(name)
    }
  }
  if (directHits.length) {
    return directHits
  }

  const tree = await readDir(WECHAT_V4_BASE_DIR, {
    dir: BaseDirectory.Home,
    recursive: true
  })

  return Array.from(collectV4AccountDirsFromTree(tree)).sort((a, b) =>
    a.localeCompare(b, 'zh-CN')
  )
}

async function findWeChatV4Targets(): Promise<
  Array<{ wxidDir: string; emoticonDbPath: string }>
> {
  const accountDirs = await findWeChatV4AccountDirs()
  return accountDirs.map((wxidDir) => ({
    wxidDir,
    emoticonDbPath: v4EmoticonDbPath({ wxidDir })
  }))
}

export async function findEmojiTargets(): Promise<Array<ISelectOption>> {
  const out: Array<ISelectOption> = []

  // WeChat 4.x
  try {
    const targets = await findWeChatV4Targets()
    for (const target of targets) {
      out.push({
        label: `新版微信（4.x）: ${target.wxidDir}`,
        value: encodeEmojiTarget({ kind: 'v4', wxidDir: target.wxidDir })
      })
    }
  } catch {
    // Ignore: WeChat 4.x folder may not exist on this machine.
  }

  // Legacy WeChat (3.x and earlier)
  try {
    const versionDirs = await readDir(WECHAT_LEGACY_BASE_DIR, {
      dir: BaseDirectory.Home,
      recursive: false
    })
    for (const version of versionDirs) {
      const versionName = version?.name || ''
      if (!versionName) {
        continue
      }
      const versionPath = `${WECHAT_LEGACY_BASE_DIR}/${versionName}`
      let subdirs: Awaited<ReturnType<typeof readDir>> = []
      try {
        subdirs = await readDir(versionPath, {
          dir: BaseDirectory.Home,
          recursive: false
        })
      } catch {
        continue
      }

      const maybeUserDirs = subdirs.filter((d) => (d?.name || '').length === 32)
      for (const user of maybeUserDirs) {
        const userName = user?.name || ''
        if (!userName) {
          continue
        }
        const fav = legacyFavArchivePath({
          versionDir: versionName,
          userDir: userName
        })
        const ok = await exists(fav, { dir: BaseDirectory.Home })
        if (ok) {
          out.push({
            label: `旧版微信（${versionName}）: ${userName}`,
            value: encodeEmojiTarget({
              kind: 'legacy',
              versionDir: versionName,
              userDir: userName
            })
          })
        }
      }
    }
  } catch {
    // Ignore: legacy folder may not exist.
  }

  return out
}

export async function findEmojiTargetsWithMeta(): Promise<
  Array<EmojiTargetMeta>
> {
  const out: Array<EmojiTargetMeta> = []

  // WeChat 4.x
  try {
    const targets = await findWeChatV4Targets()
    for (const target of targets) {
      const mtimeMs = await fileMtimeMs(`~/${target.emoticonDbPath}`)
      out.push({
        kind: 'v4',
        wxidDir: target.wxidDir,
        emoticonDbPath: target.emoticonDbPath,
        mtimeMs
      })
    }
  } catch {
    // Ignore: WeChat 4.x folder may not exist on this machine.
  }

  // Legacy WeChat (3.x and earlier)
  try {
    const versionDirs = await readDir(WECHAT_LEGACY_BASE_DIR, {
      dir: BaseDirectory.Home,
      recursive: false
    })
    for (const version of versionDirs) {
      const versionName = version?.name || ''
      if (!versionName) {
        continue
      }
      const versionPath = `${WECHAT_LEGACY_BASE_DIR}/${versionName}`
      let subdirs: Awaited<ReturnType<typeof readDir>> = []
      try {
        subdirs = await readDir(versionPath, {
          dir: BaseDirectory.Home,
          recursive: false
        })
      } catch {
        continue
      }

      const maybeUserDirs = subdirs.filter((d) => (d?.name || '').length === 32)
      for (const user of maybeUserDirs) {
        const userName = user?.name || ''
        if (!userName) {
          continue
        }
        const fav = legacyFavArchivePath({
          versionDir: versionName,
          userDir: userName
        })
        const ok = await exists(fav, { dir: BaseDirectory.Home })
        if (!ok) {
          continue
        }
        const mtimeMs = await fileMtimeMs(`~/${fav}`)
        out.push({
          kind: 'legacy',
          versionDir: versionName,
          userDir: userName,
          favArchivePath: fav,
          mtimeMs
        })
      }
    }
  } catch {
    // Ignore: legacy folder may not exist.
  }

  return out
}
