import { invoke } from '@tauri-apps/api/tauri'

export type WeChatRunningCheck = {
  running: boolean
  matches: Array<string>
}

export type PathAccessStatus = {
  path: string
  exists: boolean
  readable: boolean
  error: string | null
}

export type WeChatEnvironmentDiag = {
  v4DataDir: PathAccessStatus
  legacyDataDir: PathAccessStatus
  defaultWechatApp: PathAccessStatus
}

export async function checkWeChatRunning(
  wechatAppPath?: string
): Promise<WeChatRunningCheck> {
  return await invoke<WeChatRunningCheck>('check_wechat_running', {
    wechatAppPath
  })
}

export async function diagnoseWeChatEnvironment(): Promise<WeChatEnvironmentDiag> {
  return await invoke<WeChatEnvironmentDiag>('diagnose_wechat_environment')
}

export async function fileMtimeMs(path: string): Promise<number | null> {
  return await invoke<number | null>('file_mtime_ms', { path })
}
