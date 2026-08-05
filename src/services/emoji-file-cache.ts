import { invoke } from '@tauri-apps/api/tauri'
import { loadEmojiBinary } from './emoji-binary-cache'

export async function copyEmojiFile(src: string): Promise<void> {
  const copiedFromDisk = await invoke<boolean>('copy_cached_emoji_file', {
    sourceUrl: src
  })
  if (copiedFromDisk) {
    return
  }

  const result = await loadEmojiBinary(src)
  await invoke<string>('cache_and_copy_emoji_file', {
    sourceUrl: src,
    bytes: Array.from(new Uint8Array(result.buffer)),
    ext: result.ext
  })
}
