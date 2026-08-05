import type { ReactNode } from 'react'
import {
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

const mocks = vi.hoisted(() => ({
  messageMock: vi.fn(async () => {}),
  openDialogMock: vi.fn(async () => null),
  listenMock: vi.fn(async () => () => {}),
  writeTextMock: vi.fn(async (_value: string) => {}),
  fsExistsMock: vi.fn(async (_path: string) => false),
  removeFileMock: vi.fn(async (_path: string) => {}),
  createDirMock: vi.fn(async () => {}),
  writeBinaryFileMock: vi.fn(async () => {}),
  writeTextFileMock: vi.fn(async () => {}),
  pathJoinMock: vi.fn(async (...parts: string[]) =>
    parts.join('/').replace(/\/+/g, '/')
  ),
  dirnameMock: vi.fn(
    async (input: string) => input.split('/').slice(0, -1).join('/') || '/'
  ),
  downloadDirMock: vi.fn(async () => '/Users/tester/Downloads'),
  homeDirMock: vi.fn(async () => '/Users/tester'),
  appDataDirMock: vi.fn(
    async () => '/Users/tester/Library/Application Support/me.lius.wxemoticon'
  ),
  commandExecuteMock: vi.fn(async () => ({})),
  getClientMock: vi.fn(async () => ({
    get: vi.fn()
  })),
  findEmojiTargetsWithMetaMock: vi.fn(),
  autoDumpEmoticonUrlsV4Mock: vi.fn(),
  extractFavUrlsMock: vi.fn(),
  fetchBinaryWithFallbackMock: vi.fn(),
  ensureExportRootDirMock: vi.fn(async () => {}),
  writeUsageReadmeMock: vi.fn(async () => {}),
  writeUrlsFileMock: vi.fn(async () => {}),
  writeDbKeyFileMock: vi.fn(async () => {}),
  exportedEmojiExistsByKeyMock: vi.fn(
    async (_options?: { index: number }) => false
  ),
  exportOneEmojiMock: vi.fn(async () => {}),
  openExportDirMock: vi.fn(async () => {}),
  checkWeChatRunningMock: vi.fn(),
  diagnoseWeChatEnvironmentMock: vi.fn()
}))

vi.mock('@tauri-apps/api/dialog', () => ({
  message: mocks.messageMock,
  open: mocks.openDialogMock
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listenMock
}))

vi.mock('@tauri-apps/api/clipboard', () => ({
  writeText: mocks.writeTextMock
}))

vi.mock('@tauri-apps/api/fs', () => ({
  BaseDirectory: {
    Home: 'Home',
    Download: 'Download'
  },
  exists: mocks.fsExistsMock,
  removeFile: mocks.removeFileMock,
  createDir: mocks.createDirMock,
  writeBinaryFile: mocks.writeBinaryFileMock,
  writeTextFile: mocks.writeTextFileMock,
  readDir: vi.fn(async () => [])
}))

vi.mock('@tauri-apps/api/path', () => ({
  join: mocks.pathJoinMock,
  dirname: mocks.dirnameMock,
  downloadDir: mocks.downloadDirMock,
  homeDir: mocks.homeDirMock,
  appDataDir: mocks.appDataDirMock
}))

vi.mock('@tauri-apps/api/shell', () => ({
  Command: class {
    constructor(
      public command: string,
      public args: Array<string>
    ) {}

    execute = mocks.commandExecuteMock
  }
}))

vi.mock('@tauri-apps/api/http', () => ({
  ResponseType: {
    Binary: 3
  },
  getClient: mocks.getClientMock
}))

vi.mock('react-photo-view', () => ({
  PhotoProvider: ({ children }: { children: ReactNode }) => children,
  PhotoView: ({ children }: { children: ReactNode }) => children
}))

vi.mock('./services/archive', async () => {
  const actual =
    await vi.importActual<typeof import('./services/archive')>(
      './services/archive'
    )
  return {
    ...actual,
    autoDumpEmoticonUrlsV4: mocks.autoDumpEmoticonUrlsV4Mock,
    extractFavUrls: mocks.extractFavUrlsMock
  }
})

vi.mock('./services/downloader', () => ({
  fetchBinaryWithFallback: mocks.fetchBinaryWithFallbackMock
}))

vi.mock('./services/exporter', async () => {
  const actual = await vi.importActual<typeof import('./services/exporter')>(
    './services/exporter'
  )
  return {
    ...actual,
    ensureExportRootDir: mocks.ensureExportRootDirMock,
    writeUsageReadme: mocks.writeUsageReadmeMock,
    writeUrlsFile: mocks.writeUrlsFileMock,
    writeDbKeyFile: mocks.writeDbKeyFileMock,
    exportedEmojiExistsByKey: mocks.exportedEmojiExistsByKeyMock,
    exportOneEmoji: mocks.exportOneEmojiMock,
    openExportDir: mocks.openExportDirMock
  }
})

vi.mock('./services/system', () => ({
  checkWeChatRunning: mocks.checkWeChatRunningMock,
  diagnoseWeChatEnvironment: mocks.diagnoseWeChatEnvironmentMock,
  fileMtimeMs: vi.fn(async () => null)
}))

vi.mock('./services/wechat', async () => {
  const actual =
    await vi.importActual<typeof import('./services/wechat')>(
      './services/wechat'
    )
  return {
    ...actual,
    findEmojiTargetsWithMeta: mocks.findEmojiTargetsWithMetaMock
  }
})

type V4Target = {
  kind: 'v4'
  wxidDir: string
  emoticonDbPath: string
  mtimeMs: number | null
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeV4Target(wxid = 'wxid_test_123'): V4Target {
  return {
    kind: 'v4',
    wxidDir: wxid,
    emoticonDbPath: `Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/${wxid}/db_storage/emoticon/emoticon.db`,
    mtimeMs: 1_700_000_000_000
  }
}

function setExistsBehavior(options?: {
  wechatApp?: boolean
  cachedKey?: boolean
}) {
  const wechatApp = options?.wechatApp ?? true
  const cachedKey = options?.cachedKey ?? false
  mocks.fsExistsMock.mockImplementation(async (input: string) => {
    if (input.includes('emoticon_dbkey')) {
      return cachedKey
    }
    if (input === '/Applications/WeChat.app') {
      return wechatApp
    }
    return false
  })
}

async function renderApp() {
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '一键获取并预览' })).toBeEnabled()
  )
  return { user }
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()

  mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([])
  mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
    wxid: 'wxid_test_123',
    dbKey: 'a'.repeat(64),
    dbKeyFile: '/tmp/emoticon_dbkey.txt',
    urlsFile: '/tmp/emoticon_urls.txt',
    logFile: '/tmp/emoticon_urls.log',
    urls: []
  })
  mocks.extractFavUrlsMock.mockResolvedValue([])
  mocks.fetchBinaryWithFallbackMock.mockResolvedValue({
    ok: true,
    buffer: new Uint8Array([71, 73, 70, 56]).buffer,
    usedUrl: 'https://wxapp.tc.qq.com/1/stodownload?m=first&filekey=1',
    contentType: 'image/gif'
  })
  mocks.checkWeChatRunningMock.mockResolvedValue({
    running: false,
    matches: []
  })
  mocks.diagnoseWeChatEnvironmentMock.mockResolvedValue({
    v4DataDir: {
      path: '/Users/tester/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files',
      exists: true,
      readable: true,
      error: null
    },
    legacyDataDir: {
      path: '/Users/tester/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat',
      exists: true,
      readable: true,
      error: null
    },
    defaultWechatApp: {
      path: '/Applications/WeChat.app',
      exists: true,
      readable: true,
      error: null
    }
  })
  setExistsBehavior()
})

describe('App GUI flow', () => {
  it('shows a clear message when no account data is found', async () => {
    mocks.diagnoseWeChatEnvironmentMock.mockResolvedValue({
      v4DataDir: {
        path: '/Users/tester/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files',
        exists: true,
        readable: false,
        error: 'Operation not permitted'
      },
      legacyDataDir: {
        path: '/Users/tester/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat',
        exists: true,
        readable: true,
        error: null
      },
      defaultWechatApp: {
        path: '/Applications/WeChat.app',
        exists: true,
        readable: true,
        error: null
      }
    })

    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))

    await waitFor(() =>
      expect(mocks.messageMock).toHaveBeenCalledWith(
        expect.stringContaining('完全磁盘访问权限'),
        expect.objectContaining({ type: 'warning' })
      )
    )
    expect(
      await screen.findAllByText(/无法读取微信数据目录：.*完全磁盘访问权限/)
    ).not.toHaveLength(0)
  })

  it('shows a more specific hint when data directories are readable but no account db is found', async () => {
    mocks.diagnoseWeChatEnvironmentMock.mockResolvedValue({
      v4DataDir: {
        path: '/Users/tester/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files',
        exists: true,
        readable: true,
        error: null
      },
      legacyDataDir: {
        path: '/Users/tester/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat',
        exists: true,
        readable: true,
        error: null
      },
      defaultWechatApp: {
        path: '/Applications/WeChat.app',
        exists: true,
        readable: true,
        error: null
      }
    })

    const { user } = await renderApp()

    expect(
      await screen.findByText(/但没有找到任何包含 emoticon\.db 的账号目录/)
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))

    await waitFor(() =>
      expect(mocks.messageMock).toHaveBeenCalledWith(
        expect.stringContaining('没有找到任何包含 emoticon.db 的账号目录'),
        expect.objectContaining({ type: 'warning' })
      )
    )
  })

  it('shows an explicit warning when WeChat is still running', async () => {
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.checkWeChatRunningMock.mockResolvedValue({
      running: true,
      matches: [
        '38508 /Users/tester/Applications/WeChat-PreserveRecall.app/Contents/MacOS/WeChat'
      ]
    })
    setExistsBehavior({ wechatApp: true, cachedKey: false })

    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))

    expect(
      await screen.findByText(/必须先完全退出微信才能继续下一步/)
    ).toBeInTheDocument()
    expect(
      await screen.findByText('必须先完全退出微信，才能继续获取表情数据。')
    ).toBeInTheDocument()
  })

  it('shows a direct error when WeChat.app path is invalid', async () => {
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    setExistsBehavior({ wechatApp: false, cachedKey: false })

    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))

    expect(
      await screen.findAllByText(
        /未找到 WeChat\.app。请在「高级选项」里选择正确的 WeChat\.app 路径后重试。/
      )
    ).not.toHaveLength(0)
  })

  it('renders preview results after a successful auto dump', async () => {
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
      wxid: 'wxid_test_123',
      dbKey: 'a'.repeat(64),
      dbKeyFile: '/tmp/emoticon_dbkey.txt',
      urlsFile: '/tmp/emoticon_urls.txt',
      logFile: '/tmp/emoticon_urls.log',
      urls: [
        'https://wxapp.tc.qq.com/1/stodownload?m=first&filekey=1',
        'https://wxapp.tc.qq.com/1/stodownload?m=second&filekey=2'
      ]
    })
    setExistsBehavior({ wechatApp: true, cachedKey: false })

    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))

    expect(await screen.findByText('2 个表情包预览')).toBeInTheDocument()
    expect(mocks.autoDumpEmoticonUrlsV4Mock).toHaveBeenCalledWith(
      'wxid_test_123',
      '/Applications/WeChat.app'
    )
  })

  it('auto-selects the single account and skips quit check when cached db key exists', async () => {
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.checkWeChatRunningMock.mockResolvedValue({
      running: true,
      matches: ['9999 /Applications/WeChat.app/Contents/MacOS/WeChat']
    })
    mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
      wxid: 'wxid_test_123',
      dbKey: 'b'.repeat(64),
      dbKeyFile: '/tmp/emoticon_dbkey.txt',
      urlsFile: '/tmp/emoticon_urls.txt',
      logFile: '/tmp/emoticon_urls.log',
      urls: ['https://wxapp.tc.qq.com/1/stodownload?m=cached&filekey=1']
    })
    setExistsBehavior({ wechatApp: true, cachedKey: true })

    const { user } = await renderApp()

    expect(await screen.findByDisplayValue(/wxid_test_123/)).toBeInTheDocument()
    expect(screen.queryByLabelText('选择账号')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))

    expect(await screen.findByText('1 个表情包预览')).toBeInTheDocument()
    expect(mocks.checkWeChatRunningMock).not.toHaveBeenCalled()
    expect(
      screen.queryByText(/必须先完全退出微信才能继续下一步/)
    ).not.toBeInTheDocument()
  })

  it('writes export metadata and closes the completion dialog after opening the directory', async () => {
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
      wxid: 'wxid_test_123',
      dbKey: 'c'.repeat(64),
      dbKeyFile: '/tmp/emoticon_dbkey.txt',
      urlsFile: '/tmp/emoticon_urls.txt',
      logFile: '/tmp/emoticon_urls.log',
      urls: [
        'https://wxapp.tc.qq.com/1/stodownload?m=first&filekey=1',
        'https://wxapp.tc.qq.com/1/stodownload?m=second&filekey=2'
      ]
    })
    mocks.fetchBinaryWithFallbackMock
      .mockResolvedValueOnce({
        ok: true,
        buffer: new Uint8Array([71, 73, 70, 56]).buffer,
        usedUrl: 'https://wxapp.tc.qq.com/1/stodownload?m=first&filekey=1',
        contentType: 'image/gif'
      })
      .mockResolvedValueOnce({
        ok: true,
        buffer: new Uint8Array([71, 73, 70, 56]).buffer,
        usedUrl: 'https://wxapp.tc.qq.com/1/stodownload?m=second&filekey=2',
        contentType: 'image/gif'
      })
    setExistsBehavior({ wechatApp: true, cachedKey: false })

    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    expect(await screen.findByText('2 个表情包预览')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '开始导出' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(
      await screen.findByText(/导出目录：下载\/微信表情包_导出_/)
    ).toBeInTheDocument()
    expect(mocks.ensureExportRootDirMock).toHaveBeenCalledTimes(1)
    expect(mocks.writeUsageReadmeMock).toHaveBeenCalledTimes(1)
    expect(mocks.writeUrlsFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/^微信表情包_导出_/),
      [
        'https://wxapp.tc.qq.com/1/stodownload?m=first&filekey=1',
        'https://wxapp.tc.qq.com/1/stodownload?m=second&filekey=2'
      ]
    )
    expect(mocks.writeDbKeyFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/^微信表情包_导出_/),
      'c'.repeat(64)
    )
    expect(mocks.exportOneEmojiMock).toHaveBeenCalledTimes(2)
    expect(mocks.openExportDirMock).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '打开目录' }))

    await waitFor(() =>
      expect(screen.queryByText('导出完成')).not.toBeInTheDocument()
    )
    expect(mocks.openExportDirMock).toHaveBeenCalledTimes(2)
  })

  it('clears the current account cache from app and mirror directories after confirmation', async () => {
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])

    const { user } = await renderApp()
    expect(await screen.findByDisplayValue(/wxid_test_123/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '展开高级选项' }))
    await user.click(screen.getByRole('button', { name: '清除当前账号缓存' }))

    expect(await screen.findByText('确认清除缓存？')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '清除' }))

    await waitFor(() => expect(mocks.removeFileMock).toHaveBeenCalled())
    const removedPaths = (
      mocks.removeFileMock.mock.calls as Array<[string]>
    ).map(([path]) => path)
    expect(removedPaths).toEqual(
      expect.arrayContaining([
        '/Users/tester/Library/Application Support/me.lius.wxemoticon/export-wechat-emoji/emoticon_dbkey_wxid_test_123.txt',
        '/Users/tester/Library/Application Support/me.lius.wxemoticon/export-wechat-emoji/emoticon_urls_wxid_test_123.txt',
        '/Users/tester/Library/Containers/com.tencent.xinWeChat/Data/Documents/export-wechat-emoji/emoticon_dbkey.txt',
        '/Users/tester/Library/Containers/com.tencent.xinWeChat/Data/Documents/export-wechat-emoji/emoticon_urls.log'
      ])
    )
    expect(await screen.findByText('已清除当前账号缓存')).toBeInTheDocument()
  })

  it('exposes advanced artifact actions for copy and open log directory', async () => {
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
      wxid: 'wxid_test_123',
      dbKey: 'd'.repeat(64),
      dbKeyFile: '/tmp/export-wechat-emoji/emoticon_dbkey.txt',
      urlsFile: '/tmp/export-wechat-emoji/emoticon_urls.txt',
      logFile: '/tmp/export-wechat-emoji/emoticon_urls.log',
      urls: ['https://wxapp.tc.qq.com/1/stodownload?m=advanced&filekey=1']
    })

    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    expect(await screen.findByText('1 个表情包预览')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '展开高级选项' }))

    await user.click(screen.getByRole('button', { name: '复制 db key' }))
    await user.click(screen.getByRole('button', { name: '复制 URL 文件路径' }))
    await user.click(screen.getByRole('button', { name: '复制日志文件路径' }))
    await user.click(screen.getByRole('button', { name: '打开日志目录' }))

    expect(
      (mocks.writeTextMock.mock.calls as Array<[string]>).map(
        ([value]) => value
      )
    ).toEqual([
      'd'.repeat(64),
      '/tmp/export-wechat-emoji/emoticon_urls.txt',
      '/tmp/export-wechat-emoji/emoticon_urls.log'
    ])
    expect(mocks.commandExecuteMock).toHaveBeenCalledTimes(1)
  })

  it('supports canceling an export and continuing the incomplete export', async () => {
    const secondFetch = createDeferred<{
      ok: boolean
      buffer: ArrayBuffer
      usedUrl: string
      contentType: string
    }>()

    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
      wxid: 'wxid_test_123',
      dbKey: 'e'.repeat(64),
      dbKeyFile: '/tmp/emoticon_dbkey.txt',
      urlsFile: '/tmp/emoticon_urls.txt',
      logFile: '/tmp/emoticon_urls.log',
      urls: [
        'https://wxapp.tc.qq.com/1/stodownload?m=first&filekey=1',
        'https://wxapp.tc.qq.com/1/stodownload?m=second&filekey=2'
      ]
    })
    mocks.fetchBinaryWithFallbackMock
      .mockResolvedValueOnce({
        ok: true,
        buffer: new Uint8Array([71, 73, 70, 56]).buffer,
        usedUrl: 'https://wxapp.tc.qq.com/1/stodownload?m=first&filekey=1',
        contentType: 'image/gif'
      })
      .mockReturnValueOnce(secondFetch.promise)

    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    expect(await screen.findByText('2 个表情包预览')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '开始导出' }))
    await waitFor(() =>
      expect(mocks.fetchBinaryWithFallbackMock).toHaveBeenCalledTimes(2)
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '取消导出' })).toBeEnabled()
    )
    await user.click(screen.getByRole('button', { name: '取消导出' }))
    expect(
      await screen.findByRole('button', { name: '正在取消…' })
    ).toBeInTheDocument()
    secondFetch.resolve({
      ok: true,
      buffer: new Uint8Array([71, 73, 70, 56]).buffer,
      usedUrl: 'https://wxapp.tc.qq.com/1/stodownload?m=second&filekey=2',
      contentType: 'image/gif'
    })

    expect(await screen.findByText('导出已取消')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '关闭' }))
    await waitForElementToBeRemoved(() => screen.queryByRole('dialog'))

    expect(
      screen.getByRole('button', { name: '继续上次导出（断点续跑）' })
    ).toBeInTheDocument()

    mocks.exportedEmojiExistsByKeyMock.mockImplementation(
      async (input?: { index: number }) => input?.index === 0
    )
    mocks.fetchBinaryWithFallbackMock.mockResolvedValueOnce({
      ok: true,
      buffer: new Uint8Array([71, 73, 70, 56]).buffer,
      usedUrl: 'https://wxapp.tc.qq.com/1/stodownload?m=second&filekey=2',
      contentType: 'image/gif'
    })

    await user.click(
      screen.getByRole('button', { name: '继续上次导出（断点续跑）' })
    )

    const completionDialog = await screen.findByRole('dialog', {
      name: '导出完成'
    })
    expect(completionDialog).toBeInTheDocument()
    expect(
      within(completionDialog).getByText(/总数：2，成功：1，跳过：1，失败：0/)
    ).toBeInTheDocument()
    expect(mocks.openExportDirMock).toHaveBeenCalledTimes(1)
  })
})
