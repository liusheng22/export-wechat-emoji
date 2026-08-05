import { invoke } from '@tauri-apps/api/tauri'

export type WeChatDataAccessStatus = {
  path: string
  securityScopeStarted: boolean
  stale: boolean
}

export async function restoreWeChatDataBookmark(): Promise<WeChatDataAccessStatus | null> {
  return invoke<WeChatDataAccessStatus | null>(
    'restore_wechat_data_bookmark'
  )
}

export async function saveWeChatDataBookmark(
  path: string
): Promise<WeChatDataAccessStatus> {
  return invoke<WeChatDataAccessStatus>('save_wechat_data_bookmark', { path })
}
