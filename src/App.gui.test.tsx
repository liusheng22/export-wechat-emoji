import type { ReactNode } from 'react'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { clearEmojiBinaryCacheForTests } from './services/emoji-binary-cache'

const mocks = vi.hoisted(() => {
  const emailFeedbackPostMock = vi.fn(async (..._args: unknown[]) => ({
    ok: true,
    status: 200,
    data: { schemaVersion: 1, status: 'accepted' }
  }))

  return {
    messageMock: vi.fn(async () => {}),
    openDialogMock: vi.fn(
      async (): Promise<string | Array<string> | null> => null
    ),
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
    invokeMock: vi.fn(async () => false),
    emailFeedbackPostMock,
    getClientMock: vi.fn(async () => ({
      get: vi.fn(),
      post: emailFeedbackPostMock
    })),
    findEmojiTargetsWithMetaMock: vi.fn(),
    autoDumpEmoticonUrlsV4Mock: vi.fn(),
    buildEmoticonCatalogV4Mock: vi.fn(),
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
    diagnoseWeChatEnvironmentMock: vi.fn(),
    readCurrentWeChatAccountProfileMock: vi.fn(async () => null),
    readStickerHubAlbumCacheMock: vi.fn(),
    refreshStickerHubAlbumMock: vi.fn(),
    restoreWeChatDataBookmarkMock: vi.fn(async () => null),
    saveWeChatDataBookmarkMock: vi.fn(),
    createObjectUrlMock: vi.fn(() => 'blob:stickerhub-preview'),
    revokeObjectUrlMock: vi.fn()
  }
})

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

vi.mock('@tauri-apps/api/tauri', () => ({
  invoke: mocks.invokeMock
}))

vi.mock('@tauri-apps/api/http', () => ({
  Body: {
    json: (value: unknown) => ({ type: 'Json', value })
  },
  ResponseType: {
    Binary: 3,
    JSON: 1
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
    buildEmoticonCatalogV4: mocks.buildEmoticonCatalogV4Mock,
    extractFavUrls: mocks.extractFavUrlsMock
  }
})

vi.mock('./services/downloader', () => ({
  fetchBinaryWithFallback: mocks.fetchBinaryWithFallbackMock
}))

vi.mock('./services/stickerhub', async () => {
  const actual = await vi.importActual<typeof import('./services/stickerhub')>(
    './services/stickerhub'
  )
  return {
    ...actual,
    readStickerHubAlbumCache: mocks.readStickerHubAlbumCacheMock,
    refreshStickerHubAlbum: mocks.refreshStickerHubAlbumMock
  }
})

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
  readCurrentWeChatAccountProfile: mocks.readCurrentWeChatAccountProfileMock,
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

vi.mock('./services/wechat-data-access', () => ({
  restoreWeChatDataBookmark: mocks.restoreWeChatDataBookmarkMock,
  saveWeChatDataBookmark: mocks.saveWeChatDataBookmarkMock
}))

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
    favArchivePath:
      'Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9/0123456789abcdef0123456789abcdef/Stickers/fav.archive',
    mtimeMs: 1_700_000_000_000
  }
}

function makeFavoritesCatalog(urls: string[]) {
  return {
    mode: 'favorites_only' as const,
    warnings: [],
    favorites: urls,
    albums: []
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
  await screen.findByRole('button', {
    name: /^(一键获取并预览|重新读取|正在获取…|正在重新获取…)$/
  })
  return { user }
}

async function waitForPreviewActionEnabled() {
  await waitFor(() =>
    expect(
      screen.getByRole('button', {
        name: /^(一键获取并预览|重新读取)$/
      })
    ).toBeEnabled()
  )
}

async function expectPreviewImages(count: number) {
  await waitFor(() =>
    expect(screen.getAllByAltText('emoji')).toHaveLength(count)
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  clearEmojiBinaryCacheForTests()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: mocks.createObjectUrlMock
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: mocks.revokeObjectUrlMock
  })

  mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([])
  mocks.invokeMock.mockResolvedValue(false)
  mocks.restoreWeChatDataBookmarkMock.mockResolvedValue(null)
  mocks.saveWeChatDataBookmarkMock.mockResolvedValue({
    path: '/Users/tester/Library/Containers/com.tencent.xinWeChat/Data',
    securityScopeStarted: true,
    stale: false
  })
  mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
    wxid: 'wxid_test_123',
    dbKey: 'a'.repeat(64),
    dbKeyFile: '/tmp/emoticon_dbkey.txt',
    urlsFile: '/tmp/emoticon_urls.txt',
    logFile: '/tmp/emoticon_urls.log',
    urls: []
  })
  mocks.buildEmoticonCatalogV4Mock.mockResolvedValue(makeFavoritesCatalog([]))
  mocks.extractFavUrlsMock.mockResolvedValue([])
  mocks.readStickerHubAlbumCacheMock.mockResolvedValue({
    status: 'missing',
    payload: null,
    etag: null
  })
  mocks.refreshStickerHubAlbumMock.mockResolvedValue({
    status: 'not_found',
    payload: null,
    retryAfterSeconds: null
  })
  mocks.fetchBinaryWithFallbackMock.mockReset()
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
  it('preselects the WeChat Data directory and saves a persistent access grant', async () => {
    const dataPath =
      '/Users/tester/Library/Containers/com.tencent.xinWeChat/Data'
    mocks.openDialogMock.mockResolvedValueOnce(dataPath)

    const { user } = await renderApp()
    await user.click(await screen.findByRole('button', { name: '去授权' }))
    await user.click(screen.getByRole('button', { name: '授权微信数据目录' }))

    await waitFor(() =>
      expect(mocks.openDialogMock).toHaveBeenCalledWith({
        title: '授权微信数据目录（请直接点击“打开”）',
        defaultPath: dataPath,
        multiple: false,
        directory: true
      })
    )
    expect(mocks.saveWeChatDataBookmarkMock).toHaveBeenCalledWith(dataPath)
    expect(await screen.findByText('已保存目录授权')).toBeInTheDocument()
  })

  it('explains when the WeChat data directory is readable but no account is found', async () => {
    const hint =
      '没有找到可用的微信账号。请确认已登录微信 4.x，并至少打开过一次表情面板，然后刷新。'
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

    await renderApp()

    expect(await screen.findByText(hint)).toBeInTheDocument()
  })

  it('opens on the favorites page without a tab bar and keeps settings as a separate page', async () => {
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])

    const { user } = await renderApp()

    expect(screen.queryByText('导出微信表情包')).not.toBeInTheDocument()
    expect(screen.queryByText('账号')).not.toBeInTheDocument()
    expect(screen.queryByText(/该账号最后更新时间/)).not.toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '个人收藏' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument()
    expect(screen.getByText('显示与读取')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '个人收藏' }))
    expect(
      screen.getByRole('heading', { name: '个人收藏' })
    ).toBeInTheDocument()
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
    expect(
      await screen.findByRole('button', { name: '查看表情大图 2' })
    ).toBeInTheDocument()

    const previewSources = () =>
      Array.from(
        document.querySelectorAll<HTMLImageElement>('.img-preview img')
      ).map((img) => img.src)
    expect(previewSources()[0]).toContain('m=newest')

    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('combobox', { name: '表情排序' }))
    await user.click(screen.getByRole('option', { name: '最早添加在前' }))

    expect(localStorage.getItem('wxemoticon_emoji_sort_order')).toBe(
      'oldest-first'
    )
    await user.click(screen.getByRole('button', { name: '个人收藏' }))
    expect(previewSources()[0]).toContain('m=oldest')
  })

  it('copies image data from the preview and reuses it for export while keeping overlay actions independent', async () => {
    const emojiUrl = 'https://wxapp.tc.qq.com/1/stodownload?m=shared&filekey=1'
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
      wxid: 'wxid_test_123',
      dbKey: 'a'.repeat(64),
      dbKeyFile: '/tmp/emoticon_dbkey.txt',
      urlsFile: '/tmp/emoticon_urls.txt',
      logFile: '/tmp/emoticon_urls.log',
      urls: [emojiUrl]
    })
    mocks.fetchBinaryWithFallbackMock.mockResolvedValue({
      ok: true,
      buffer: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).buffer,
      usedUrl: `${emojiUrl}&download=1`,
      contentType: 'image/gif'
    })

    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    const previewAction = await screen.findByRole('button', {
      name: '查看表情大图 1'
    })
    const copyAction = screen.getByRole('button', { name: '复制图片' })

    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByText(/个表情包预览/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '复制链接' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '打开链接' })
    ).not.toBeInTheDocument()

    await user.click(previewAction)
    expect(mocks.invokeMock).not.toHaveBeenCalled()
    expect(mocks.commandExecuteMock).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '打开图片链接' }))
    expect(mocks.commandExecuteMock).toHaveBeenCalledTimes(1)
    expect(mocks.invokeMock).not.toHaveBeenCalled()

    await user.click(copyAction)
    await waitFor(() =>
      expect(mocks.invokeMock).toHaveBeenCalledWith(
        'cache_and_copy_emoji_file',
        {
          sourceUrl: emojiUrl,
          bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
          ext: 'gif'
        }
      )
    )
    expect(mocks.writeTextMock).not.toHaveBeenCalled()
    expect(
      await screen.findByText('已复制图片，可直接粘贴到聊天窗口')
    ).toBeInTheDocument()
    expect(mocks.fetchBinaryWithFallbackMock).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '导出全部' }))
    expect(
      await screen.findByRole('dialog', { name: '导出完成' })
    ).toBeInTheDocument()
    expect(mocks.fetchBinaryWithFallbackMock).toHaveBeenCalledTimes(1)
    expect(mocks.exportOneEmojiMock).toHaveBeenCalledTimes(1)
  })

  it('keeps preview loading active while the user opens settings', async () => {
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

    await user.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument()

    dump.resolve({
      wxid: 'wxid_test_123',
      dbKey: 'a'.repeat(64),
      dbKeyFile: '/tmp/emoticon_dbkey.txt',
      urlsFile: '/tmp/emoticon_urls.txt',
      logFile: '/tmp/emoticon_urls.log',
      urls: ['https://wxapp.tc.qq.com/1/stodownload?m=done&filekey=1']
    })

    await user.click(screen.getByRole('button', { name: '个人收藏' }))
    expect(
      await screen.findByRole('button', { name: '查看表情大图 1' })
    ).toBeInTheDocument()
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
    expect(
      await screen.findByRole('button', { name: '查看表情大图 2' })
    ).toBeInTheDocument()

    const firstImage =
      document.querySelector<HTMLImageElement>('.img-preview img')
    expect(firstImage?.src).toContain('m=oldest')
    await user.click(screen.getByRole('button', { name: '设置' }))
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

    await renderApp()

    expect(
      await screen.findAllByText(/无法读取微信数据.*完全磁盘访问权限/)
    ).not.toHaveLength(0)
    expect(
      screen.getByRole('button', { name: '一键获取并预览' })
    ).toBeDisabled()
    expect(mocks.messageMock).not.toHaveBeenCalled()
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
    await waitForPreviewActionEnabled()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))

    expect(
      await screen.findByText(/必须先完全退出微信才能继续/)
    ).toBeInTheDocument()
    expect(
      await screen.findByText('必须先完全退出微信，才能继续获取表情数据。')
    ).toBeInTheDocument()
  })

  it('shows a direct error when WeChat.app path is invalid', async () => {
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    setExistsBehavior({ wechatApp: false, cachedKey: false })

    const { user } = await renderApp()
    await waitForPreviewActionEnabled()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))

    expect(
      await screen.findAllByText(
        /未找到微信应用。请在“设置”中重新选择安装位置。/
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
    mocks.buildEmoticonCatalogV4Mock.mockResolvedValue(
      makeFavoritesCatalog([
        'https://wxapp.tc.qq.com/1/stodownload?m=first&filekey=1',
        'https://wxapp.tc.qq.com/1/stodownload?m=second&filekey=2'
      ])
    )
    setExistsBehavior({ wechatApp: true, cachedKey: false })

    const { user } = await renderApp()
    await waitForPreviewActionEnabled()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))

    await expectPreviewImages(2)
    expect(screen.getByRole('button', { name: '导出全部' })).toBeInTheDocument()
    expect(mocks.autoDumpEmoticonUrlsV4Mock).toHaveBeenCalledWith(
      'wxid_test_123',
      '/Applications/WeChat.app',
      true
    )
  })

  it('does not leave mmbiz previews in a permanent loading state', async () => {
    const mmbizUrls = [
      'https://mmbiz.qpic.cn/mmemoticon/Q3auHgzwzM4A2oaOBRow3TTumt85IY8vux1aCfqKxg8xzkoGDQpAV02hLiccfl0BE/0',
      'https://mmbiz.qpic.cn/mmemoticon/ajNVdqHZLLDNuP3ULtMbeppHbom5AGuKes2gkGKHNKvicQ7iaoC9f1rs0vlXOjxkibe/0',
      'https://mmbiz.qpic.cn/mmemoticon/ajNVdqHZLLA4XqclcticIpDZqf3ibzf7HD1f2d43GSHQYYueEic6aEcPruUmePv9MR4/0'
    ]
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
      wxid: 'wxid_test_123',
      dbKey: 'mmbiz'.repeat(16),
      dbKeyFile: '/tmp/emoticon_dbkey.txt',
      urlsFile: '/tmp/emoticon_urls.txt',
      logFile: '/tmp/emoticon_urls.log',
      urls: mmbizUrls
    })
    mocks.buildEmoticonCatalogV4Mock.mockResolvedValue(
      makeFavoritesCatalog(mmbizUrls)
    )
    setExistsBehavior({ wechatApp: true, cachedKey: false })

    const { user } = await renderApp()
    await waitForPreviewActionEnabled()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))

    await expectPreviewImages(3)
    expect(mocks.fetchBinaryWithFallbackMock).toHaveBeenCalledTimes(3)
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
    mocks.buildEmoticonCatalogV4Mock.mockResolvedValue(
      makeFavoritesCatalog([
        'https://wxapp.tc.qq.com/1/stodownload?m=cached&filekey=1'
      ])
    )
    setExistsBehavior({ wechatApp: true, cachedKey: true })

    const { user } = await renderApp()

    await waitForPreviewActionEnabled()
    expect(screen.getByRole('combobox')).toHaveTextContent('wxid_test_123')
    expect(screen.queryByText('选择账号')).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', {
        name: /^(一键获取并预览|重新读取)$/
      })
    )

    await expectPreviewImages(1)
    expect(mocks.checkWeChatRunningMock).not.toHaveBeenCalled()
    expect(
      screen.queryByText(/必须先完全退出微信才能继续/)
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '刷新微信账号' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '刷新账号' })
    ).not.toBeInTheDocument()
  })

  it('loads a complete album from the API only after it is selected', async () => {
    const productId = 'com.tencent.xin.emoticon.person.complete_album'
    const md5 = '99999999999999999999999999999999'
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
      wxid: 'wxid_test_123',
      dbKey: 'album'.repeat(16),
      dbKeyFile: '/tmp/emoticon_dbkey.txt',
      urlsFile: '/tmp/emoticon_urls.txt',
      logFile: '/tmp/emoticon_urls.log',
      urls: [
        'https://wxapp.tc.qq.com/1/stodownload?m=fav1&filekey=1',
        'https://wxapp.tc.qq.com/1/stodownload?m=fav2&filekey=2'
      ]
    })
    mocks.buildEmoticonCatalogV4Mock.mockResolvedValue({
      mode: 'full',
      warnings: [],
      favorites: [
        'https://wxapp.tc.qq.com/1/stodownload?m=fav1&filekey=1',
        'https://wxapp.tc.qq.com/1/stodownload?m=fav2&filekey=2'
      ],
      albums: [
        {
          id: productId,
          name: '搞怪专辑',
          count: 1,
          urls: ['https://wxapp.tc.qq.com/1/stodownload?m=album1&filekey=3'],
          items: [
            {
              id: `${productId}:${md5}`,
              md5,
              src: 'https://wxapp.tc.qq.com/1/stodownload?m=album1&filekey=3',
              downloadUrl:
                'https://wxapp.tc.qq.com/1/stodownload?m=album1&filekey=3'
            }
          ],
          members: [{ md5, sortOrder: 1 }],
          packageId: productId
        }
      ]
    })
    mocks.refreshStickerHubAlbumMock.mockResolvedValue({
      status: 'ready',
      retryAfterSeconds: null,
      payload: {
        schemaVersion: 1,
        productId,
        iconUrl: null,
        version: null,
        members: [
          {
            memberIndex: 1,
            md5,
            previewUrl: 'https://remote.example/album-preview.gif',
            downloadUrl: 'https://remote.example/album-full.gif'
          }
        ]
      }
    })
    setExistsBehavior({ wechatApp: true, cachedKey: false })

    const { user } = await renderApp()
    await waitForPreviewActionEnabled()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))

    await expectPreviewImages(2)
    expect(mocks.readStickerHubAlbumCacheMock).not.toHaveBeenCalled()
    expect(mocks.refreshStickerHubAlbumMock).not.toHaveBeenCalled()

    await user.click(screen.getByText('搞怪专辑'))
    await expectPreviewImages(1)
    expect((screen.getByAltText('emoji') as HTMLImageElement).src).toBe(
      'https://remote.example/album-full.gif'
    )
    expect(mocks.refreshStickerHubAlbumMock).toHaveBeenCalledWith(productId)
  })

  it('uses only API members for a selected album and exports remote resources', async () => {
    const productId = 'com.tencent.xin.emoticon.person.stiker_test_album'
    const localMd5 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const missingMd5 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.autoDumpEmoticonUrlsV4Mock.mockResolvedValue({
      wxid: 'wxid_test_123',
      dbKey: 'f'.repeat(64),
      dbKeyFile: '/tmp/emoticon_dbkey.txt',
      urlsFile: '/tmp/emoticon_urls.txt',
      logFile: '/tmp/emoticon_urls.log',
      urls: ['https://favorites.example/favorite.gif']
    })
    mocks.buildEmoticonCatalogV4Mock.mockResolvedValue({
      mode: 'partial',
      warnings: [
        '有 1 个专辑包含暂不可预览或不可导出的成员，已按可用资源继续展示。'
      ],
      favorites: ['https://favorites.example/favorite.gif'],
      albums: [
        {
          id: productId,
          name: '缺图专辑',
          count: 2,
          icon: undefined,
          urls: ['https://local.example/full.gif'],
          packageId: productId,
          members: [
            { md5: missingMd5, sortOrder: 1 },
            { md5: localMd5.toUpperCase(), sortOrder: 2 }
          ],
          items: [
            {
              id: `${productId}:${localMd5}`,
              md5: localMd5,
              src: 'https://local.example/preview.gif',
              downloadUrl: 'https://local.example/full.gif'
            }
          ]
        }
      ]
    })
    mocks.refreshStickerHubAlbumMock.mockResolvedValue({
      status: 'ready',
      retryAfterSeconds: null,
      payload: {
        schemaVersion: 1,
        productId,
        iconUrl: 'https://remote.example/icon.png',
        version: 'opaque',
        members: [
          {
            memberIndex: 1,
            md5: missingMd5,
            previewUrl: 'https://remote.example/preview.gif',
            downloadUrl: 'https://remote.example/full.gif'
          },
          {
            memberIndex: 2,
            md5: localMd5,
            previewUrl: 'https://remote.example/must-not-replace.gif',
            downloadUrl: 'https://remote.example/must-not-export.gif'
          },
          {
            memberIndex: 3,
            md5: 'cccccccccccccccccccccccccccccccc',
            previewUrl: 'https://remote.example/extra.gif',
            downloadUrl: 'https://remote.example/extra-full.gif'
          }
        ]
      }
    })
    setExistsBehavior({ wechatApp: true, cachedKey: false })

    const { user } = await renderApp()
    await waitForPreviewActionEnabled()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))

    await expectPreviewImages(1)
    expect(screen.getByText('部分专辑未完整显示')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '查看专辑读取说明' })
    ).toBeInTheDocument()
    await user.hover(screen.getByRole('button', { name: '查看专辑读取说明' }))
    expect(
      await screen.findByText(
        '有 1 个专辑包含暂不可预览或不可导出的成员，已按可用资源继续展示。'
      )
    ).toBeInTheDocument()
    expect(mocks.readStickerHubAlbumCacheMock).not.toHaveBeenCalled()
    expect(mocks.refreshStickerHubAlbumMock).not.toHaveBeenCalled()

    await user.click(screen.getByText('缺图专辑'))
    await expectPreviewImages(3)

    expect(mocks.readStickerHubAlbumCacheMock).toHaveBeenCalledTimes(1)
    expect(mocks.readStickerHubAlbumCacheMock).toHaveBeenCalledWith(productId)
    expect(mocks.refreshStickerHubAlbumMock).toHaveBeenCalledTimes(1)
    expect(mocks.refreshStickerHubAlbumMock).toHaveBeenCalledWith(productId)

    const images = screen.getAllByAltText('emoji') as HTMLImageElement[]
    expect(images.map((image) => image.src)).toEqual([
      'https://remote.example/full.gif',
      'https://remote.example/must-not-export.gif',
      'https://remote.example/extra-full.gif'
    ])

    await user.click(screen.getByRole('button', { name: '导出全部' }))
    await waitFor(() =>
      expect(mocks.fetchBinaryWithFallbackMock).toHaveBeenCalledTimes(3)
    )
    expect(mocks.fetchBinaryWithFallbackMock).toHaveBeenNthCalledWith(
      1,
      'https://remote.example/full.gif'
    )
    expect(mocks.fetchBinaryWithFallbackMock).toHaveBeenNthCalledWith(
      2,
      'https://remote.example/must-not-export.gif'
    )
    expect(mocks.fetchBinaryWithFallbackMock).toHaveBeenNthCalledWith(
      3,
      'https://remote.example/extra-full.gif'
    )
  })

  it('keeps a not-found album selected instead of showing favorites', async () => {
    const productId = 'com.tencent.xin.emoticon.person.not_found_album'
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.buildEmoticonCatalogV4Mock.mockResolvedValue({
      mode: 'partial',
      warnings: [],
      favorites: ['https://favorites.example/visible-only-in-favorites.gif'],
      albums: [
        {
          id: productId,
          name: '未收录专辑',
          count: 1,
          urls: [],
          items: [],
          members: [{ md5: 'dddddddddddddddddddddddddddddddd', sortOrder: 1 }],
          packageId: productId
        }
      ]
    })

    const { user } = await renderApp()
    await waitForPreviewActionEnabled()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    await expectPreviewImages(1)

    await user.click(screen.getByText('未收录专辑'))
    expect(screen.queryAllByAltText('emoji')).toHaveLength(0)
    expect(
      await screen.findByText('这个专辑还没有收录', { selector: 'h6' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'StickerHub API' })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/专辑表情包由.*提供支持。你可以反馈这个专辑/)
    ).toBeInTheDocument()
    expect(
      screen.getByText('未收录专辑', { selector: 'h5' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '通过 GitHub 反馈' })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '邮件反馈' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '通过 GitHub 反馈' }))
    expect(await screen.findByText('确认通过 GitHub 反馈')).toBeInTheDocument()
    expect(
      screen.getByText(
        '下一步会打开浏览器中的 GitHub 新建页面。你需要登录 GitHub 并手动点击提交，客户端不会自动提交。'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '复制专辑 ID' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '打开 GitHub' })
    ).toBeInTheDocument()
    expect(mocks.commandExecuteMock).not.toHaveBeenCalled()
    const githubDialog = screen.getByRole('dialog', {
      name: '确认通过 GitHub 反馈'
    })
    await user.click(within(githubDialog).getByRole('button', { name: '取消' }))
    await waitForElementToBeRemoved(githubDialog)

    await user.click(screen.getByRole('button', { name: '邮件反馈' }))
    expect(
      await screen.findByText(
        '反馈会发送至开发者邮箱：black.liusheng@gmail.com'
      )
    ).toBeInTheDocument()
    await user.type(
      screen.getByRole('textbox', {
        name: '接收补录通知的邮箱（可选）'
      }),
      'user@example.com'
    )
    await user.click(screen.getByRole('button', { name: '发送反馈' }))
    expect(
      await screen.findByText('反馈邮件已发送给开发者')
    ).toBeInTheDocument()
    await waitForElementToBeRemoved(
      screen.getByRole('dialog', { name: '邮件反馈' })
    )
    expect(mocks.emailFeedbackPostMock).toHaveBeenCalledTimes(1)
    expect(mocks.emailFeedbackPostMock.mock.calls[0]?.[1]).toMatchObject({
      value: expect.objectContaining({
        productId,
        albumName: '未收录专辑',
        expectedMemberCount: 1,
        members: [
          {
            memberIndex: 1,
            md5: 'dddddddddddddddddddddddddddddddd'
          }
        ],
        contactEmail: 'user@example.com'
      })
    })

    await user.click(screen.getByRole('button', { name: '通过 GitHub 反馈' }))
    await user.click(screen.getByRole('button', { name: '复制专辑 ID' }))
    expect(mocks.writeTextMock).toHaveBeenCalledWith(productId)
  })

  it('uses a fresh album cache without refreshing the network resource', async () => {
    const productId = 'com.tencent.xin.emoticon.person.cached_album'
    const md5 = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.buildEmoticonCatalogV4Mock.mockResolvedValue({
      mode: 'partial',
      warnings: [],
      favorites: ['https://favorites.example/favorite.gif'],
      albums: [
        {
          id: productId,
          name: '缓存专辑',
          count: 1,
          urls: [],
          items: [],
          members: [{ md5, sortOrder: 1 }],
          packageId: productId
        }
      ]
    })
    mocks.readStickerHubAlbumCacheMock.mockResolvedValue({
      status: 'fresh',
      etag: '"cached"',
      payload: {
        schemaVersion: 1,
        productId,
        iconUrl: null,
        version: 'cached',
        members: [
          {
            memberIndex: 1,
            md5,
            previewUrl: 'https://cache.example/preview.gif',
            downloadUrl: 'https://cache.example/full.gif'
          }
        ]
      }
    })

    const { user } = await renderApp()
    await waitForPreviewActionEnabled()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    await user.click(screen.getByText('缓存专辑'))
    await expectPreviewImages(1)

    expect(mocks.readStickerHubAlbumCacheMock).toHaveBeenCalledWith(productId)
    expect(mocks.refreshStickerHubAlbumMock).not.toHaveBeenCalled()
    const image = screen.getByAltText('emoji') as HTMLImageElement
    expect(image.src).toBe('https://cache.example/full.gif')

    mocks.fetchBinaryWithFallbackMock.mockResolvedValueOnce({
      ok: false,
      error: new Error('full resource unavailable')
    })
    mocks.fetchBinaryWithFallbackMock.mockResolvedValueOnce({
      ok: true,
      buffer: new Uint8Array([71, 73, 70, 56]).buffer,
      usedUrl: 'https://cache.example/preview.gif',
      contentType: 'image/gif'
    })
    fireEvent.error(image)
    await waitFor(() =>
      expect((screen.getByAltText('emoji') as HTMLImageElement).src).toBe(
        'blob:stickerhub-preview'
      )
    )
    expect(mocks.fetchBinaryWithFallbackMock).toHaveBeenCalledWith(
      'https://cache.example/full.gif'
    )
    expect(mocks.fetchBinaryWithFallbackMock).toHaveBeenLastCalledWith(
      'https://cache.example/preview.gif'
    )
  })

  it('does not let a late album response replace the newly selected album', async () => {
    const firstId = 'com.tencent.xin.emoticon.person.first_album'
    const secondId = 'com.tencent.xin.emoticon.person.second_album'
    const firstMd5 = '11111111111111111111111111111111'
    const secondMd5 = '22222222222222222222222222222222'
    const firstRefresh = createDeferred<{
      status: 'ready'
      retryAfterSeconds: null
      payload: {
        schemaVersion: 1
        productId: string
        iconUrl: null
        version: null
        members: Array<{
          memberIndex: number
          md5: string
          previewUrl: string
          downloadUrl: string
        }>
      }
    }>()
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.buildEmoticonCatalogV4Mock.mockResolvedValue({
      mode: 'partial',
      warnings: [],
      favorites: ['https://favorites.example/favorite.gif'],
      albums: [
        {
          id: firstId,
          name: '第一个专辑',
          count: 1,
          urls: [],
          items: [],
          members: [{ md5: firstMd5, sortOrder: 1 }],
          packageId: firstId
        },
        {
          id: secondId,
          name: '第二个专辑',
          count: 1,
          urls: [],
          items: [],
          members: [{ md5: secondMd5, sortOrder: 1 }],
          packageId: secondId
        }
      ]
    })
    mocks.refreshStickerHubAlbumMock.mockImplementation((id: string) => {
      if (id === firstId) {
        return firstRefresh.promise
      }
      return Promise.resolve({
        status: 'ready',
        retryAfterSeconds: null,
        payload: {
          schemaVersion: 1,
          productId: secondId,
          iconUrl: null,
          version: null,
          members: [
            {
              memberIndex: 1,
              md5: secondMd5,
              previewUrl: 'https://second.example/preview.gif',
              downloadUrl: 'https://second.example/full.gif'
            }
          ]
        }
      })
    })

    const { user } = await renderApp()
    await waitForPreviewActionEnabled()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    await user.click(screen.getByText('第一个专辑'))
    expect(await screen.findByLabelText('正在加载专辑图片')).toBeInTheDocument()

    await user.click(screen.getByText('第二个专辑'))
    await expectPreviewImages(1)
    expect((screen.getByAltText('emoji') as HTMLImageElement).src).toBe(
      'https://second.example/full.gif'
    )

    firstRefresh.resolve({
      status: 'ready',
      retryAfterSeconds: null,
      payload: {
        schemaVersion: 1,
        productId: firstId,
        iconUrl: null,
        version: null,
        members: [
          {
            memberIndex: 1,
            md5: firstMd5,
            previewUrl: 'https://first.example/late.gif',
            downloadUrl: 'https://first.example/late-full.gif'
          }
        ]
      }
    })

    await waitFor(() =>
      expect((screen.getByAltText('emoji') as HTMLImageElement).src).toBe(
        'https://second.example/full.gif'
      )
    )
    expect(
      screen.getByText('第二个专辑', { selector: 'h5' })
    ).toBeInTheDocument()
  })

  it('shows stale cache immediately and respects rate-limit retry time', async () => {
    const productId = 'com.tencent.xin.emoticon.person.stale_album'
    const md5 = '33333333333333333333333333333333'
    const refresh = createDeferred<{
      status: 'rate_limited'
      payload: null
      retryAfterSeconds: number
    }>()
    const cachedPayload = {
      schemaVersion: 1 as const,
      productId,
      iconUrl: null,
      version: 'stale',
      members: [
        {
          memberIndex: 1,
          md5,
          previewUrl: 'https://cache.example/stale-preview.gif',
          downloadUrl: 'https://cache.example/stale-full.gif'
        }
      ]
    }
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeV4Target()])
    mocks.buildEmoticonCatalogV4Mock.mockResolvedValue({
      mode: 'partial',
      warnings: [],
      favorites: ['https://favorites.example/favorite.gif'],
      albums: [
        {
          id: productId,
          name: '旧缓存专辑',
          count: 1,
          urls: [],
          items: [],
          members: [{ md5, sortOrder: 1 }],
          packageId: productId
        }
      ]
    })
    mocks.readStickerHubAlbumCacheMock.mockResolvedValue({
      status: 'stale',
      etag: '"stale"',
      payload: cachedPayload
    })
    mocks.refreshStickerHubAlbumMock.mockReturnValue(refresh.promise)

    const { user } = await renderApp()
    await waitForPreviewActionEnabled()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    await user.click(screen.getByText('旧缓存专辑'))

    expect(
      await screen.findByText('已显示本地缓存，正在检查更新…')
    ).toBeInTheDocument()
    expect((screen.getByAltText('emoji') as HTMLImageElement).src).toBe(
      'https://cache.example/stale-full.gif'
    )

    refresh.resolve({
      status: 'rate_limited',
      payload: null,
      retryAfterSeconds: 30
    })
    expect(
      await screen.findByText('请求较频繁，请稍后再试。')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /秒后重试/ })).toBeDisabled()
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

    expect(
      await screen.findByRole('button', { name: '查看表情大图 1' })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '正在重新获取…' })).toBeDisabled()
    expect(mocks.autoDumpEmoticonUrlsV4Mock).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '复制 db key' }))
    expect(mocks.writeTextMock).toHaveBeenCalledWith('e'.repeat(64))

    dump.reject(new Error('cached key is stale'))

    expect(
      await screen.findByText('已显示缓存，自动刷新失败，可手动重试')
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '个人收藏' }))
    expect(
      screen.getByRole('button', { name: '查看表情大图 1' })
    ).toBeInTheDocument()
  })

  it('persists a legacy account preview and shows explicit cache information', async () => {
    const extract = createDeferred<Array<string>>()
    const cachedUrl = 'https://wxapp.tc.qq.com/1/stodownload?m=legacy&filekey=1'
    mocks.findEmojiTargetsWithMetaMock.mockResolvedValue([makeLegacyTarget()])
    mocks.extractFavUrlsMock.mockReturnValueOnce(extract.promise)

    const { user } = await renderApp()
    expect(
      await screen.findByText(/旧版微信: 0123456789abcdef/)
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    expect(screen.getByRole('button', { name: '正在获取…' })).toBeDisabled()

    extract.resolve([cachedUrl])
    expect(
      await screen.findByRole('button', { name: '查看表情大图 1' })
    ).toBeInTheDocument()

    const cached = JSON.parse(
      localStorage.getItem(
        'wxemoticon_preview_cache|legacy|2.0b4.0.9|0123456789abcdef0123456789abcdef'
      ) || '{}'
    ) as { targetId?: string; urls?: Array<string> }
    expect(cached.targetId).toBe(
      'legacy|2.0b4.0.9|0123456789abcdef0123456789abcdef'
    )
    expect(cached.urls).toEqual([cachedUrl])

    await user.click(screen.getByRole('button', { name: '设置' }))
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
    mocks.buildEmoticonCatalogV4Mock.mockResolvedValue(
      makeFavoritesCatalog([
        'https://wxapp.tc.qq.com/1/stodownload?m=first&filekey=1',
        'https://wxapp.tc.qq.com/1/stodownload?m=second&filekey=2'
      ])
    )
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
    await waitForPreviewActionEnabled()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    await expectPreviewImages(2)

    await user.click(screen.getByRole('button', { name: '导出全部' }))

    const completionDialog = await screen.findByRole('dialog')
    expect(within(completionDialog).getByText('导出完成')).toBeInTheDocument()
    expect(
      within(completionDialog).getByText(/文件已保存到“下载\/微信表情包_导出_/)
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

    await user.click(
      within(completionDialog).getByRole('button', { name: '打开文件夹' })
    )

    await waitForElementToBeRemoved(() => screen.queryByRole('dialog'))
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
    await user.click(await screen.findByRole('button', { name: '导出设置' }))
    await user.click(screen.getByRole('radio', { name: '自定义分组' }))
    const customSize = screen.getByRole('spinbutton', {
      name: '每组数量'
    })
    await user.type(customSize, '37', {
      initialSelectionStart: 0,
      initialSelectionEnd: 2
    })
    await user.click(
      screen.getByRole('checkbox', {
        name: '断点续跑'
      })
    )
    await user.click(screen.getByRole('checkbox', { name: '完成后打开文件夹' }))

    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem('wxemoticon_export_settings') || '{}')
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
    await user.click(await screen.findByRole('button', { name: '导出设置' }))

    expect(screen.getByRole('radio', { name: '自定义分组' })).toBeChecked()
    expect(screen.getByRole('spinbutton', { name: '每组数量' })).toHaveValue(37)
    expect(
      screen.getByRole('checkbox', {
        name: '断点续跑'
      })
    ).not.toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: '完成后打开文件夹' })
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
    await waitForPreviewActionEnabled()
    expect(screen.getByRole('combobox')).toHaveTextContent('wxid_test_123')

    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '清除缓存' }))

    expect(await screen.findByText('清除当前账号缓存？')).toBeInTheDocument()
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
      localStorage.getItem('wxemoticon_preview_cache|v4|wxid_test_123')
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
    mocks.buildEmoticonCatalogV4Mock.mockResolvedValue(
      makeFavoritesCatalog([
        'https://wxapp.tc.qq.com/1/stodownload?m=advanced&filekey=1'
      ])
    )

    const { user } = await renderApp()
    await waitForPreviewActionEnabled()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    await expectPreviewImages(1)

    await user.click(screen.getByRole('button', { name: '设置' }))
    expect(await screen.findByText('当前账号')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '复制' }))
    expect(mocks.writeTextMock).toHaveBeenCalledWith('d'.repeat(64))

    await user.click(screen.getByRole('button', { name: '诊断信息' }))

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
    mocks.buildEmoticonCatalogV4Mock.mockResolvedValue(
      makeFavoritesCatalog([
        'https://wxapp.tc.qq.com/1/stodownload?m=first&filekey=1',
        'https://wxapp.tc.qq.com/1/stodownload?m=second&filekey=2'
      ])
    )
    mocks.fetchBinaryWithFallbackMock
      .mockResolvedValueOnce({
        ok: true,
        buffer: new Uint8Array([71, 73, 70, 56]).buffer,
        usedUrl: 'https://wxapp.tc.qq.com/1/stodownload?m=first&filekey=1',
        contentType: 'image/gif'
      })
      .mockReturnValueOnce(secondFetch.promise)

    const { user } = await renderApp()
    await waitForPreviewActionEnabled()
    await user.click(screen.getByRole('button', { name: '一键获取并预览' }))
    await expectPreviewImages(2)

    await user.click(screen.getByRole('button', { name: '导出全部' }))
    await waitFor(() =>
      expect(mocks.fetchBinaryWithFallbackMock).toHaveBeenCalledTimes(2)
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '停止导出' })).toBeEnabled()
    )
    await user.click(screen.getByRole('button', { name: '停止导出' }))
    expect(
      await screen.findByRole('button', { name: '正在停止…' })
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

    expect(screen.getByRole('button', { name: '继续上次' })).toBeInTheDocument()

    mocks.exportedEmojiExistsByKeyMock.mockImplementation(
      async (input?: { index: number }) => input?.index === 0
    )
    mocks.fetchBinaryWithFallbackMock.mockResolvedValueOnce({
      ok: true,
      buffer: new Uint8Array([71, 73, 70, 56]).buffer,
      usedUrl: 'https://wxapp.tc.qq.com/1/stodownload?m=second&filekey=2',
      contentType: 'image/gif'
    })

    await user.click(screen.getByRole('button', { name: '继续上次' }))

    const completionDialog = await screen.findByRole('dialog', {
      name: '导出完成'
    })
    expect(completionDialog).toBeInTheDocument()
    expect(within(completionDialog).getByText('成功')).toBeInTheDocument()
    expect(within(completionDialog).getByText('跳过')).toBeInTheDocument()
    expect(within(completionDialog).getByText('失败')).toBeInTheDocument()
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
    expect(
      await screen.findByRole('button', { name: '查看表情大图 1' })
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '导出全部' }))
    await waitFor(() =>
      expect(mocks.fetchBinaryWithFallbackMock).toHaveBeenCalledTimes(1)
    )

    await user.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '个人收藏' }))
    expect(
      screen.getByRole('heading', { name: '个人收藏' })
    ).toBeInTheDocument()

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
    expect(
      await screen.findByRole('button', { name: '查看表情大图 2' })
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '继续上次' }))

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
    expect(
      await screen.findByRole('button', { name: '查看表情大图 2' })
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '继续上次' }))
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
