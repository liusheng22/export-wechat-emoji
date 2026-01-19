import {
  createDir,
  writeBinaryFile,
  writeTextFile,
  BaseDirectory
} from '@tauri-apps/api/fs'
import { Command } from '@tauri-apps/api/shell'
import { getUrlParam } from '../utils/url'

export async function ensureExportRootDir(customEmotionsDirName: string) {
  await createDir(customEmotionsDirName, {
    dir: BaseDirectory.Download,
    recursive: true
  })
}

export async function writeUsageReadme(
  customEmotionsDirName: string,
  content: string
) {
  await writeTextFile(`${customEmotionsDirName}/使用说明.txt`, content, {
    dir: BaseDirectory.Download
  })
}

export function groupSubDirPath(
  customEmotionsDirName: string,
  index: number,
  groupSize: number
): { subDirNumber: number; subDirPath: string } {
  const subDirNumber = Math.floor(index / groupSize)
  const start = subDirNumber * groupSize + 1
  const end = (subDirNumber + 1) * groupSize
  const subDirPath = `${customEmotionsDirName}/${start}_${end}_组`
  return { subDirNumber, subDirPath }
}

export async function exportOneEmoji(options: {
  customEmotionsDirName: string
  groupSize: number
  createdSubDirs: Set<number>
  index: number
  usedUrl: string
  buffer: ArrayBuffer
  ext: string
}) {
  const { subDirNumber, subDirPath } = groupSubDirPath(
    options.customEmotionsDirName,
    options.index,
    options.groupSize
  )

  if (!options.createdSubDirs.has(subDirNumber)) {
    options.createdSubDirs.add(subDirNumber)
    await createDir(subDirPath, {
      dir: BaseDirectory.Download,
      recursive: true
    })
  }

  const fileKey = getUrlParam(options.usedUrl, 'm')
  await writeBinaryFile(
    `${subDirPath}/${fileKey}.${options.ext}`,
    new Uint8Array(options.buffer),
    { dir: BaseDirectory.Download }
  )
}

export async function openExportDir(
  downloadDirPath: string,
  customEmotionsDirName: string
) {
  const path = `${downloadDirPath}${customEmotionsDirName}`
  await new Command('open-dir', [path]).execute()
}
