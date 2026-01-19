import { exists, readDir, BaseDirectory } from '@tauri-apps/api/fs'

export const DEFAULT_WECHAT_DIR_PATH =
  'Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9'

export async function findStickerTargetDirs(
  weChatDirPath: string
): Promise<Array<string>> {
  const weChatDirs = await readDir(weChatDirPath, {
    dir: BaseDirectory.Home,
    recursive: false
  })

  const maybeTargetDirs = weChatDirs.filter((dir) => dir?.name?.length === 32)

  const targetDirs: Array<string> = []
  for (const file of maybeTargetDirs) {
    const stickerFile = `${weChatDirPath}/${file.name}/Stickers/fav.archive`
    const stickerExists = await exists(stickerFile, { dir: BaseDirectory.Home })
    if (stickerExists && file.name) {
      targetDirs.push(file.name)
    }
  }

  return targetDirs
}

export function favArchivePath(weChatDirPath: string, dirName: string): string {
  return `${weChatDirPath}/${dirName}/Stickers/fav.archive`
}
