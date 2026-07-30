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
  writeTextMock: vi.fn(async (value: string) => {
    void value
  }),
  fsExistsMock: vi.fn(async (path: string) => {
    void path
    return false
  }),
  removeFileMock: vi.fn(async (path: string) => {
    void path
  }),
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
  exportedEmojiExistsByKeyMock: vi.fn(async (options?: { index: number }) => {
    void options
    return false
  }),
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

type LegacyTarget = {
  kind: 'legacy'
  versionDir: string
  userDir: string
  favArchivePath: string
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

function makeLegacyTarget(): LegacyTarget {
  return {
    kind: 'legacy',
    versionDir: '2.0b4.0.9',
    userDir: '0123456789abcdef0123456789abcdef',
    favArchivePath: '/Users/tester/WeChat/Stickers/fav.archive',
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
    expect(
      screen.getByRole('button', {
        name: /一键获取并预览|重新获取|正在重新获取…/
      })
    ).toBeInTheDocument()
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
  mocks.exportedEmojiExistsByKeyMock.mockImplementation(
    async (options?: { index: number }) => {
      void options
      return false
    }
  )
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
  it('opens on the preview tab without the redundant page title and routes empty export state back to preview', async () => {
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])

    const { user } = await renderApp()

    expect(screen.queryByText('导出微信表情包')).not.toBeInTheDocument()
    expect(screen.queryByText('账号')).not.toBeInTheDocument()
    expect(screen.queryByText(/该账号最后更新时间/)).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '表情预览' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await user.click(screen.getByRole('tab', { name: '导出' }))
    expect(screen.getByText('请先在“表情预览”中获取表情。')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '去获取' }))
    expect(screen.getByRole('tab', { name: '表情预览' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('shows newest emojis first by default and persists an oldest-first preference', async () => {
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
      wxid: 'wxid_test_123',
      dbKey: 'a'.repeat(64),
      dbKeyFile: '/tmp/emoticon_dbkey.txt',
      urlsFile: '/tmp/emoticon_urls.txt',
      logFile: '/tmp/emoticon_urls.log',
      urls: [
        'https://wxapp.tc.qq.com/1/stodownload?m=oldest&filekey=1',
        'https://wxapp.tc.qq.com/1/stodownload?m=newest&filekey=2'
      ]
    })

    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    expect(await screen.findByText('2 个表情包预览')).toBeInTheDocument()

    const previewSources = () =>
      Array.from(
        document.querySelectorAll<HTMLImageElement>('.img-preview img')
      ).map((img) => img.src)
    expect(previewSources()[0]).toContain('m=newest')

    await user.click(screen.getByRole('tab', { name: '高级设置' }))
    await user.click(screen.getByRole('combobox', { name: '表情排序' }))
    await user.click(screen.getByRole('option', { name: '最早添加在前' }))

    expect(localStorage.getItem('wxemoticon_emoji_sort_order')).toBe(
      'oldest-first'
    )
    await user.click(screen.getByRole('tab', { name: '表情预览' }))
    expect(previewSources()[0]).toContain('m=oldest')
  })

  it('keeps preview loading active while the user switches tabs', async () => {
    const dump = createDeferred<{
      wxid: string
      dbKey: string
      dbKeyFile: string
      urlsFile: string
      logFile: string
      urls: Array<string>
    }>()
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.autoDumpEmoticonUrlsV4Mock.mockReturnValueOnce(dump.promise)

    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    await waitFor(() =>
      expect(mocks.autoDumpEmoticonUrlsV4Mock).toHaveBeenCalledTimes(1)
    )

    await user.click(screen.getByRole('tab', { name: '导出' }))
    expect(screen.getByText('请先在“表情预览”中获取表情。')).toBeInTheDocument()

    dump.resolve({
      wxid: 'wxid_test_123',
      dbKey: 'a'.repeat(64),
      dbKeyFile: '/tmp/emoticon_dbkey.txt',
      urlsFile: '/tmp/emoticon_urls.txt',
      logFile: '/tmp/emoticon_urls.log',
      urls: ['https://wxapp.tc.qq.com/1/stodownload?m=done&filekey=1']
    })

    expect(
      await screen.findByRole('button', { name: '开始导出' })
    ).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '导出' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('restores a persisted oldest-first preference on startup', async () => {
    localStorage.setItem('wxemoticon_emoji_sort_order', 'oldest-first')
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
      wxid: 'wxid_test_123',
      dbKey: 'a'.repeat(64),
      dbKeyFile: '/tmp/emoticon_dbkey.txt',
      urlsFile: '/tmp/emoticon_urls.txt',
      logFile: '/tmp/emoticon_urls.log',
      urls: [
        'https://wxapp.tc.qq.com/1/stodownload?m=oldest&filekey=1',
        'https://wxapp.tc.qq.com/1/stodownload?m=newest&filekey=2'
      ]
    })

    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    expect(await screen.findByText('2 个表情包预览')).toBeInTheDocument()

    const firstImage =
      document.querySelector<HTMLImageElement>('.img-preview img')
    expect(firstImage?.src).toContain('m=oldest')
    await user.click(screen.getByRole('tab', { name: '高级设置' }))
    expect(
      screen.getByRole('combobox', { name: '表情排序' })
    ).toHaveTextContent('最早添加在前')
  })

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
        /未找到 WeChat\.app。请在「高级设置」里选择正确的 WeChat\.app 路径后重试。/
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
      '/Applications/WeChat.app',
      true
    )
  })

  it('auto-selects the single account and refreshes automatically when cached db key exists', async () => {
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

    await renderApp()

    expect(await screen.findByDisplayValue(/wxid_test_123/)).toBeInTheDocument()
    expect(screen.queryByLabelText('选择账号')).not.toBeInTheDocument()

    expect(await screen.findByText('1 个表情包预览')).toBeInTheDocument()
    expect(mocks.autoDumpEmoticonUrlsV4Mock).toHaveBeenCalledTimes(1)
    expect(mocks.autoDumpEmoticonUrlsV4Mock).toHaveBeenCalledWith(
      'wxid_test_123',
      '/Applications/WeChat.app',
      false
    )
    expect(mocks.checkWeChatRunningMock).not.toHaveBeenCalled()
    expect(
      screen.queryByText(/必须先完全退出微信才能继续下一步/)
    ).not.toBeInTheDocument()
  })

  it('restores the current account cache before auto-refresh and keeps it when refresh fails', async () => {
    const dump = createDeferred<{
      wxid: string
      dbKey: string
      dbKeyFile: string
      urlsFile: string
      logFile: string
      urls: Array<string>
    }>()
    const cachedUrl =
      'https://wxapp.tc.qq.com/1/stodownload?m=restored&filekey=1'
    const artifacts = {
      wxid: 'wxid_test_123',
      dbKey: 'e'.repeat(64),
      dbKeyFile: '/tmp/cached/emoticon_dbkey.txt',
      urlsFile: '/tmp/cached/emoticon_urls.txt',
      logFile: '/tmp/cached/emoticon_urls.log',
      urls: [cachedUrl]
    }
    localStorage.setItem(
      'wxemoticon_preview_cache|v4|wxid_test_123',
      JSON.stringify({
        version: 1,
        targetId: 'v4|wxid_test_123',
        urls: [cachedUrl],
        updatedAt: '2026-07-30T00:00:00.000Z',
        artifacts
      })
    )
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.autoDumpEmoticonUrlsV4Mock.mockReturnValueOnce(dump.promise)
    setExistsBehavior({ wechatApp: true, cachedKey: true })

    const { user } = await renderApp()

    expect(await screen.findByText('1 个表情包预览')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '正在重新获取…' })
    ).toBeDisabled()
    expect(mocks.autoDumpEmoticonUrlsV4Mock).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('tab', { name: '高级设置' }))
    await user.click(screen.getByRole('button', { name: '复制 db key' }))
    expect(mocks.writeTextMock).toHaveBeenCalledWith('e'.repeat(64))

    dump.reject(new Error('cached key is stale'))

    expect(
      await screen.findByText('已显示缓存，自动刷新失败，可手动重试')
    ).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '表情预览' }))
    expect(screen.getByText('1 个表情包预览')).toBeInTheDocument()
  })

  it('persists a legacy account preview and shows explicit cache information', async () => {
    const extract = createDeferred<Array<string>>()
    const cachedUrl =
      'https://wxapp.tc.qq.com/1/stodownload?m=legacy&filekey=1'
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeLegacyTarget()])
    mocks.extractFavUrlsMock.mockReturnValueOnce(extract.promise)

    const { user } = await renderApp()
    expect(
      await screen.findByDisplayValue(/旧版微信: 0123456789abcdef/)
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    expect(screen.getByRole('button', { name: '正在获取…' })).toBeDisabled()

    extract.resolve([cachedUrl])
    expect(await screen.findByText('1 个表情包预览')).toBeInTheDocument()

    const cached = JSON.parse(
      localStorage.getItem(
        'wxemoticon_preview_cache|legacy|2.0b4.0.9|0123456789abcdef0123456789abcdef'
      ) || '{}'
    ) as { targetId?: string; urls?: Array<string> }
    expect(cached.targetId).toBe(
      'legacy|2.0b4.0.9|0123456789abcdef0123456789abcdef'
    )
    expect(cached.urls).toEqual([cachedUrl])

    await user.click(screen.getByRole('tab', { name: '高级设置' }))
    expect(
      screen.getByText(/已恢复该账号的本地 URL 缓存（1 条）/)
    ).toBeInTheDocument()
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

    await user.click(screen.getByRole('tab', { name: '导出' }))
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
        'https://wxapp.tc.qq.com/1/stodownload?m=second&filekey=2',
        'https://wxapp.tc.qq.com/1/stodownload?m=first&filekey=1'
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

  it('restores all export settings after remounting', async () => {
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    localStorage.setItem(
      'wxemoticon_preview_cache|v4|wxid_test_123',
      JSON.stringify({
        version: 1,
        targetId: 'v4|wxid_test_123',
        urls: ['https://wxapp.tc.qq.com/restored'],
        updatedAt: '2026-07-30T00:00:00.000Z'
      })
    )

    const user = userEvent.setup()
    const firstRender = render(<App />)
    await user.click(await screen.findByRole('tab', { name: '导出' }))
    await user.click(
      screen.getByRole('radio', { name: '自定义分组大小' })
    )
    const customSize = screen.getByRole('spinbutton', {
      name: '自定义分组大小'
    })
    await user.type(customSize, '37', {
      initialSelectionStart: 0,
      initialSelectionEnd: 2
    })
    await user.click(
      screen.getByRole('checkbox', {
        name: '断点续跑（跳过已存在文件）'
      })
    )
    await user.click(
      screen.getByRole('checkbox', { name: '导出完成后自动打开目录' })
    )

    await waitFor(() =>
      expect(
        JSON.parse(
          localStorage.getItem('wxemoticon_export_settings') || '{}'
        )
      ).toEqual({
        version: 1,
        groupMode: 'custom',
        customGroupSize: 37,
        resume: false,
        autoOpen: false
      })
    )

    firstRender.unmount()
    render(<App />)
    await user.click(await screen.findByRole('tab', { name: '导出' }))

    expect(
      screen.getByRole('radio', { name: '自定义分组大小' })
    ).toBeChecked()
    expect(
      screen.getByRole('spinbutton', { name: '自定义分组大小' })
    ).toHaveValue(37)
    expect(
      screen.getByRole('checkbox', {
        name: '断点续跑（跳过已存在文件）'
      })
    ).not.toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: '导出完成后自动打开目录' })
    ).not.toBeChecked()
  })

  it('clears the current account cache from app and mirror directories after confirmation', async () => {
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    localStorage.setItem(
      'wxemoticon_preview_cache|v4|wxid_test_123',
      JSON.stringify({
        version: 1,
        targetId: 'v4|wxid_test_123',
        urls: ['https://wxapp.tc.qq.com/restored'],
        updatedAt: '2026-07-30T00:00:00.000Z'
      })
    )

    const { user } = await renderApp()
    expect(await screen.findByDisplayValue(/wxid_test_123/)).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: '高级设置' }))
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
        '/Users/tester/Library/Containers/com.tencent.xinWeChat/Data/Documents/export-wechat-emoji/emoticon_dbkey_wxid_test_123.txt',
        '/Users/tester/Library/Containers/com.tencent.xinWeChat/Data/Documents/export-wechat-emoji/emoticon_urls_wxid_test_123.log'
      ])
    )
    expect(
      localStorage.getItem(
        'wxemoticon_preview_cache|v4|wxid_test_123'
      )
    ).toBeNull()
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

    await user.click(screen.getByRole('tab', { name: '高级设置' }))

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

    await user.click(screen.getByRole('tab', { name: '导出' }))
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

  it('keeps an export running while the user switches back to preview', async () => {
    const download = createDeferred<{
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
      urls: ['https://wxapp.tc.qq.com/1/stodownload?m=only&filekey=1']
    })
    mocks.fetchBinaryWithFallbackMock.mockReturnValueOnce(download.promise)

    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    expect(await screen.findByText('1 个表情包预览')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '导出' }))
    await user.click(screen.getByRole('button', { name: '开始导出' }))
    await waitFor(() =>
      expect(mocks.fetchBinaryWithFallbackMock).toHaveBeenCalledTimes(1)
    )

    await user.click(screen.getByRole('tab', { name: '表情预览' }))
    expect(screen.getByRole('tab', { name: '表情预览' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    download.resolve({
      ok: true,
      buffer: new Uint8Array([71, 73, 70, 56]).buffer,
      usedUrl: 'https://wxapp.tc.qq.com/1/stodownload?m=only&filekey=1',
      contentType: 'image/gif'
    })
    expect(
      await screen.findByRole('dialog', { name: '导出完成' })
    ).toBeInTheDocument()
  })

  it('migrates legacy incomplete exports and asks before resuming with a different sort order', async () => {
    const targetValue = 'v4|wxid_test_123'
    localStorage.setItem(
      `wxemoticon_incomplete_export|${targetValue}`,
      JSON.stringify({ dirName: '旧版未完成目录', groupSize: 50 })
    )
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
      wxid: 'wxid_test_123',
      dbKey: 'f'.repeat(64),
      dbKeyFile: '/tmp/emoticon_dbkey.txt',
      urlsFile: '/tmp/emoticon_urls.txt',
      logFile: '/tmp/emoticon_urls.log',
      urls: [
        'https://wxapp.tc.qq.com/1/stodownload?m=oldest&filekey=1',
        'https://wxapp.tc.qq.com/1/stodownload?m=newest&filekey=2'
      ]
    })

    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    expect(await screen.findByText('2 个表情包预览')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '导出' }))
    await user.click(
      screen.getByRole('button', { name: '继续上次导出（断点续跑）' })
    )

    expect(
      await screen.findByRole('dialog', {
        name: '排序方式与上次导出不同'
      })
    ).toBeInTheDocument()
    expect(
      JSON.parse(
        localStorage.getItem(`wxemoticon_incomplete_export|${targetValue}`) ||
          '{}'
      )
    ).toEqual({
      dirName: '旧版未完成目录',
      groupSize: 50,
      sortOrder: 'oldest-first'
    })

    await user.click(screen.getByRole('button', { name: '按上次排序继续' }))
    expect(
      await screen.findByRole('dialog', { name: '导出完成' })
    ).toBeInTheDocument()
    expect(mocks.writeUrlsFileMock).toHaveBeenCalledWith('旧版未完成目录', [
      'https://wxapp.tc.qq.com/1/stodownload?m=oldest&filekey=1',
      'https://wxapp.tc.qq.com/1/stodownload?m=newest&filekey=2'
    ])
    expect(localStorage.getItem('wxemoticon_emoji_sort_order')).toBe(
      'newest-first'
    )
  })

  it('starts a new directory when resolving a resume sort conflict with the current order', async () => {
    const targetValue = 'v4|wxid_test_123'
    localStorage.setItem(
      `wxemoticon_incomplete_export|${targetValue}`,
      JSON.stringify({
        dirName: '不要继续写入的旧目录',
        groupSize: 50,
        sortOrder: 'oldest-first'
      })
    )
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
      wxid: 'wxid_test_123',
      dbKey: 'g'.repeat(64),
      dbKeyFile: '/tmp/emoticon_dbkey.txt',
      urlsFile: '/tmp/emoticon_urls.txt',
      logFile: '/tmp/emoticon_urls.log',
      urls: [
        'https://wxapp.tc.qq.com/1/stodownload?m=oldest&filekey=1',
        'https://wxapp.tc.qq.com/1/stodownload?m=newest&filekey=2'
      ]
    })

    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    expect(await screen.findByText('2 个表情包预览')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '导出' }))
    await user.click(
      screen.getByRole('button', { name: '继续上次导出（断点续跑）' })
    )
    await user.click(
      await screen.findByRole('button', {
        name: '按当前排序开始新的导出'
      })
    )

    expect(
      await screen.findByRole('dialog', { name: '导出完成' })
    ).toBeInTheDocument()
    expect(mocks.ensureExportRootDirMock).toHaveBeenCalledWith(
      expect.stringMatching(/^微信表情包_导出_/)
    )
    expect(mocks.ensureExportRootDirMock).not.toHaveBeenCalledWith(
      '不要继续写入的旧目录'
    )
    expect(mocks.writeUrlsFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/^微信表情包_导出_/),
      [
        'https://wxapp.tc.qq.com/1/stodownload?m=newest&filekey=2',
        'https://wxapp.tc.qq.com/1/stodownload?m=oldest&filekey=1'
      ]
    )
  })
})
