import { BaseDirectory } from '@tauri-apps/api/fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findEmojiTargets,
  findEmojiTargetsWithMeta,
  shouldIgnoreWeChatV4Dir,
  v4EmoticonDbPath,
  WECHAT_V4_BASE_DIR
} from './wechat'

const mocks = vi.hoisted(() => ({
  readDirMock: vi.fn(),
  existsMock: vi.fn(),
  fileMtimeMsMock: vi.fn()
}))

vi.mock('@tauri-apps/api/fs', () => ({
  BaseDirectory: {
    Home: 'Home'
  },
  readDir: mocks.readDirMock,
  exists: mocks.existsMock
}))

vi.mock('./system', () => ({
  fileMtimeMs: mocks.fileMtimeMsMock
}))

describe('wechat target discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fileMtimeMsMock.mockResolvedValue(null)
  })

  it('ignores known non-account v4 directories', () => {
    expect(shouldIgnoreWeChatV4Dir('')).toBe(true)
    expect(shouldIgnoreWeChatV4Dir('.DS_Store')).toBe(true)
    expect(shouldIgnoreWeChatV4Dir('all_users')).toBe(true)
    expect(shouldIgnoreWeChatV4Dir('Backup')).toBe(true)
    expect(shouldIgnoreWeChatV4Dir('WMPF')).toBe(true)
    expect(shouldIgnoreWeChatV4Dir('AppletCaches')).toBe(true)
    expect(shouldIgnoreWeChatV4Dir('Update')).toBe(true)
    expect(shouldIgnoreWeChatV4Dir('wxid_real')).toBe(false)
    expect(shouldIgnoreWeChatV4Dir('user_123')).toBe(false)
  })

  it('detects v4 account directories without requiring wxid prefix', async () => {
    mocks.readDirMock.mockImplementation(async (path: string) => {
      if (path === WECHAT_V4_BASE_DIR) {
        return [
          { name: 'all_users' },
          { name: '.cache' },
          { name: 'user_123' },
          { name: 'wxid_ok' },
          { name: 'Backup' }
        ]
      }
      return []
    })
    mocks.existsMock.mockImplementation(async (path: string) => {
      return (
        path === v4EmoticonDbPath({ wxidDir: 'user_123' }) ||
        path === v4EmoticonDbPath({ wxidDir: 'wxid_ok' })
      )
    })

    const targets = await findEmojiTargets()

    expect(mocks.readDirMock).toHaveBeenCalledWith(WECHAT_V4_BASE_DIR, {
      dir: BaseDirectory.Home,
      recursive: false
    })
    expect(targets).toEqual([
      {
        label: '新版微信（4.x）: user_123',
        value: 'v4|user_123'
      },
      {
        label: '新版微信（4.x）: wxid_ok',
        value: 'v4|wxid_ok'
      }
    ])
  })

  it('includes metadata for non-wxid v4 account directories with emoticon db', async () => {
    mocks.readDirMock.mockImplementation(async (path: string) => {
      if (path === WECHAT_V4_BASE_DIR) {
        return [
          { name: 'all_users' },
          { name: 'user_123' },
          { name: 'missing_db' }
        ]
      }
      return []
    })
    mocks.existsMock.mockImplementation(async (path: string) => {
      return path === v4EmoticonDbPath({ wxidDir: 'user_123' })
    })
    mocks.fileMtimeMsMock.mockResolvedValue(1_700_000_000_000)

    const targets = await findEmojiTargetsWithMeta()

    expect(targets).toEqual([
      {
        kind: 'v4',
        wxidDir: 'user_123',
        emoticonDbPath: v4EmoticonDbPath({ wxidDir: 'user_123' }),
        mtimeMs: 1_700_000_000_000
      }
    ])
    expect(mocks.fileMtimeMsMock).toHaveBeenCalledWith(
      `~/${v4EmoticonDbPath({ wxidDir: 'user_123' })}`
    )
  })

  it('falls back to recursive scan when emoticon db is nested deeper than one level', async () => {
    mocks.readDirMock.mockImplementation(
      async (_path: string, options?: { recursive?: boolean }) => {
        if (options?.recursive) {
          return [
            {
              name: 'all_users',
              children: [
                {
                  name: 'shared',
                  children: [
                    {
                      name: 'db_storage',
                      children: [
                        {
                          name: 'emoticon',
                          children: [{ name: 'emoticon.db' }]
                        }
                      ]
                    }
                  ]
                }
              ]
            },
            {
              name: 'folder_a',
              children: [
                {
                  name: 'user_nested',
                  children: [
                    {
                      name: 'db_storage',
                      children: [
                        {
                          name: 'emoticon',
                          children: [{ name: 'emoticon.db' }]
                        }
                      ]
                    }
                  ]
                }
              ]
            },
            {
              name: '.hidden',
              children: [
                {
                  name: 'ghost',
                  children: [
                    {
                      name: 'db_storage',
                      children: [
                        {
                          name: 'emoticon',
                          children: [{ name: 'emoticon.db' }]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
        return [{ name: 'folder_a' }, { name: 'all_users' }]
      }
    )
    mocks.existsMock.mockResolvedValue(false)

    const targets = await findEmojiTargets()

    expect(mocks.readDirMock).toHaveBeenNthCalledWith(1, WECHAT_V4_BASE_DIR, {
      dir: BaseDirectory.Home,
      recursive: false
    })
    expect(mocks.readDirMock).toHaveBeenNthCalledWith(2, WECHAT_V4_BASE_DIR, {
      dir: BaseDirectory.Home,
      recursive: true
    })
    expect(targets).toEqual([
      {
        label: '新版微信（4.x）: folder_a/user_nested',
        value: 'v4|folder_a/user_nested'
      }
    ])
  })
})
