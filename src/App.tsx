import type { IMaybeUrl } from './types'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import CircularProgress from '@mui/material/CircularProgress'
import Container from '@mui/material/Container'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import ImageList from '@mui/material/ImageList'
import ImageListItem from '@mui/material/ImageListItem'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import LinearProgress from '@mui/material/LinearProgress'
import MenuItem from '@mui/material/MenuItem'
import Pagination from '@mui/material/Pagination'
import Paper from '@mui/material/Paper'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Select, { type SelectChangeEvent } from '@mui/material/Select'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import Step from '@mui/material/Step'
import StepLabel from '@mui/material/StepLabel'
import Stepper from '@mui/material/Stepper'
import Switch from '@mui/material/Switch'
import SvgIcon from '@mui/material/SvgIcon'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { writeText } from '@tauri-apps/api/clipboard'
import { message, open } from '@tauri-apps/api/dialog'
import { listen } from '@tauri-apps/api/event'
import { exists as fsExists, removeFile } from '@tauri-apps/api/fs'
import {
  appDataDir,
  dirname,
  downloadDir,
  homeDir,
  join
} from '@tauri-apps/api/path'
import { Command } from '@tauri-apps/api/shell'
import { useEffect, useMemo, useRef, useState } from 'react'
import { PhotoProvider, PhotoView } from 'react-photo-view'
import { text } from './consts/text'
import {
  autoDumpEmoticonUrlsV4,
  buildEmojiItems,
  extractFavUrls,
  type AutoDumpUrlsResult
} from './services/archive'
import { loadEmojiBinary } from './services/emoji-binary-cache'
import { copyEmojiFile } from './services/emoji-file-cache'
import {
  buildUniqueFileKeys,
  ensureExportRootDir,
  exportedEmojiExistsByKey,
  exportOneEmoji,
  openExportDir,
  writeDbKeyFile,
  writeUrlsFile,
  writeUsageReadme
} from './services/exporter'
import { getStodownloadCandidates } from './services/stodownload'
import {
  checkWeChatRunning,
  diagnoseWeChatEnvironment,
  type WeChatEnvironmentDiag
} from './services/system'
import {
  clearPreviewCache,
  readPreviewCache,
  writePreviewCache
} from './services/preview-cache'
import {
  normalizeCustomGroupSize,
  readExportSettings,
  writeExportSettings
} from './services/export-settings'
import {
  encodeEmojiTarget,
  findEmojiTargetsWithMeta,
  type EmojiTargetMeta
} from './services/wechat'
import {
  restoreWeChatDataBookmark,
  saveWeChatDataBookmark,
  type WeChatDataAccessStatus
} from './services/wechat-data-access'
import './App.css'

type FlowStage =
  | 'idle'
  | 'checkingWechat'
  | 'preparingWeChatCopy'
  | 'waitingForKey'
  | 'offlineParsing'
  | 'ready'
  | 'error'

type WxEmoticonFlowEvent = {
  wxid: string
  stage:
    | 'preparing_wechat_copy'
    | 'waiting_for_key'
    | 'offline_parsing'
    | 'writing_files'
    | 'done'
  message: string
}

type ExportResult = {
  dirName: string
  total: number
  ok: number
  skipped: number
  failed: number
  canceled: boolean
  groupSize: number
}

type AppTab = 'preview' | 'export' | 'advanced'

type EmojiSortOrder = 'newest-first' | 'oldest-first'

type PreviewTaskIntent = 'initial' | 'refresh' | 'auto-refresh'

type LoadPreviewOptions = {
  target?: EmojiTargetMeta
  intent?: PreviewTaskIntent
  activationGeneration?: number
  cachedPreview?: boolean
}

type IncompleteExport = {
  dirName: string
  groupSize: number
  sortOrder: EmojiSortOrder
}

type ToastState = {
  open: boolean
  message: string
  severity: 'success' | 'info' | 'warning' | 'error'
}

const EMOJI_SORT_ORDER_STORAGE_KEY = 'wxemoticon_emoji_sort_order'

function isEmojiSortOrder(value: unknown): value is EmojiSortOrder {
  return value === 'newest-first' || value === 'oldest-first'
}

function orderUrls(
  urls: Array<string>,
  sortOrder: EmojiSortOrder
): Array<string> {
  return sortOrder === 'newest-first' ? [...urls].reverse() : [...urls]
}

function ZoomInIcon() {
  return (
    <SvgIcon fontSize="small" viewBox="0 0 24 24">
      <path d="M9.5 3a6.5 6.5 0 1 0 3.98 11.64L19.85 21 21 19.85l-6.36-6.37A6.5 6.5 0 0 0 9.5 3Zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9ZM9 7v2H7v1h2v2h1v-2h2V9h-2V7H9Z" />
    </SvgIcon>
  )
}

function LinkIcon() {
  return (
    <SvgIcon fontSize="small" viewBox="0 0 24 24">
      <path d="M10.6 13.4a1 1 0 0 1 0-1.4l3.2-3.2a3 3 0 1 1 4.2 4.2l-2.2 2.2a3 3 0 0 1-4.2 0 1 1 0 1 1 1.4-1.4 1 1 0 0 0 1.4 0l2.2-2.2a1 1 0 1 0-1.4-1.4L12 13.4a1 1 0 0 1-1.4 0Zm2.8-2.8a1 1 0 0 1 0 1.4l-3.2 3.2A3 3 0 1 1 6 11l2.2-2.2a3 3 0 0 1 4.2 0A1 1 0 1 1 11 10.2a1 1 0 0 0-1.4 0l-2.2 2.2a1 1 0 1 0 1.4 1.4l3.2-3.2a1 1 0 0 1 1.4 0Z" />
    </SvgIcon>
  )
}

function App() {
  // wxapp 域名
  const wxappDomain = 'wxapp.tc.qq.com'
  // vweixinf 域名
  const vweixinfDomain = 'vweixinf.tc.qq.com'
  const [targets, setTargets] = useState<Array<EmojiTargetMeta>>([])
  const [targetsLoading, setTargetsLoading] = useState(false)
  const [targetsError, setTargetsError] = useState<string | null>(null)
  const [targetsHint, setTargetsHint] = useState<string | null>(null)
  const [selectedTargetValue, setSelectedTargetValue] = useState('')

  // 预览/下载数据（来源统一为 URL 列表，但对用户隐藏）
  const [rawUrls, setRawUrls] = useState<Array<string>>([])
  const [showImgList, setShowImgList] = useState<Array<IMaybeUrl>>([])
  const [copyingEmojiKeys, setCopyingEmojiKeys] = useState<Set<string>>(
    () => new Set()
  )
  const [previewPage, setPreviewPage] = useState(1)
  const previewPageSize = 50
  const [activeTab, setActiveTab] = useState<AppTab>('preview')
  const [emojiSortOrder, setEmojiSortOrder] = useState<EmojiSortOrder>(() => {
    const saved = localStorage.getItem(EMOJI_SORT_ORDER_STORAGE_KEY)
    return isEmojiSortOrder(saved) ? saved : 'newest-first'
  })

  // 导出状态
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportOk, setExportOk] = useState(0)
  const [exportSkipped, setExportSkipped] = useState(0)
  const [exportFailed, setExportFailed] = useState(0)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [exportResult, setExportResult] = useState<ExportResult | null>(null)
  const [lastExportDir, setLastExportDir] = useState<string | null>(null)
  const [incompleteExport, setIncompleteExport] =
    useState<IncompleteExport | null>(null)

  // 导出设置（尽量“傻瓜”）
  const [exportSettings, setExportSettings] = useState(() =>
    readExportSettings()
  )
  const {
    groupMode: exportGroupMode,
    customGroupSize: exportCustomGroupSize,
    resume: exportResume,
    autoOpen: exportAutoOpen
  } = exportSettings

  // download 目录路径（用于 open）
  const [downloadDirPath, setDownloadDirPath] = useState('')
  const [homeDirPath, setHomeDirPath] = useState('')
  const [appDataDirPath, setAppDataDirPath] = useState('')
  const [wechatDataAccess, setWechatDataAccess] =
    useState<WeChatDataAccessStatus | null>(null)
  const [wechatDataAccessLoading, setWechatDataAccessLoading] = useState(true)
  const [wechatDataAccessError, setWechatDataAccessError] = useState<
    string | null
  >(null)

  // 自动抓取状态（带步骤）
  const [flowStage, setFlowStage] = useState<FlowStage>('idle')
  const [flowHint, setFlowHint] = useState('')
  const [flowError, setFlowError] = useState<string | null>(null)
  const [previewTaskIntent, setPreviewTaskIntent] =
    useState<PreviewTaskIntent | null>(null)
  const [wechatMustQuit, setWechatMustQuit] = useState(false)
  const [wechatRunningMatches, setWeChatRunningMatches] = useState<
    Array<string>
  >([])

  const [lastDumpResult, setLastDumpResult] =
    useState<AutoDumpUrlsResult | null>(null)

  const [toast, setToast] = useState<ToastState>({
    open: false,
    message: '',
    severity: 'info'
  })
  const [confirmClearCacheOpen, setConfirmClearCacheOpen] = useState(false)
  const [resumeSortConflictOpen, setResumeSortConflictOpen] = useState(false)

  const [wechatAppPath, setWechatAppPath] = useState('/Applications/WeChat.app')
  const cancelExportRef = useRef(false)
  const createdSubDirsRef = useRef<Set<number>>(new Set())
  const copyingEmojiKeysRef = useRef<Set<string>>(new Set())
  const activeFlowWxidRef = useRef<string | null>(null)
  const flowActiveRef = useRef(false)
  const activeTargetIdRef = useRef('')
  const activationGenerationRef = useRef(0)
  const lastActivatedTargetIdRef = useRef('')
  const activePreviewTaskRef = useRef<{
    targetId: string
    generation: number
  } | null>(null)

  const valueOfTarget = (t: EmojiTargetMeta) =>
    t.kind === 'v4'
      ? encodeEmojiTarget({ kind: 'v4', wxidDir: t.wxidDir })
      : encodeEmojiTarget({
          kind: 'legacy',
          versionDir: t.versionDir,
          userDir: t.userDir
        })

  const selectedTargetMeta = useMemo(() => {
    if (!selectedTargetValue) {
      return null
    }
    return targets.find((t) => valueOfTarget(t) === selectedTargetValue) || null
  }, [selectedTargetValue, targets])

  const isPreviewLoading = previewTaskIntent !== null

  function buildWeChatAccessHint(
    diag: WeChatEnvironmentDiag | null
  ): string | null {
    if (!diag) {
      return null
    }

    const unreadable =
      [diag.v4DataDir, diag.legacyDataDir].find(
        (item) => item.exists && !item.readable
      ) || null
    if (!unreadable) {
      return null
    }

    return `无法读取微信数据目录：${unreadable.path}。请确认微信已登录；可在「高级设置」中授权微信数据目录，避免每次启动重复出现系统访问提示。如果仍失败，请在系统设置中为本应用开启“完全磁盘访问权限”后重试。${
      unreadable.error ? `（${unreadable.error}）` : ''
    }`
  }

  function buildNoTargetsHint(diag: WeChatEnvironmentDiag | null): string {
    if (diag?.v4DataDir.exists && diag.v4DataDir.readable) {
      return `已读取微信数据目录：${diag.v4DataDir.path}，但没有找到任何包含 emoticon.db 的账号目录。请确认已登录新版微信，并至少打开过一次表情面板；如果仍为空，说明当前微信目录结构可能再次变化。`
    }

    if (diag?.legacyDataDir.exists && diag.legacyDataDir.readable) {
      return `已读取旧版微信目录：${diag.legacyDataDir.path}，但没有找到 fav.archive 或 emoticon.db。请确认微信已登录，并点击「刷新」后重试。`
    }

    return '未检测到微信表情包数据。请确认已安装并登录微信；可在「高级设置」中授权微信数据目录，避免每次启动重复出现系统访问提示。如果微信已登录但仍为空，请点击“刷新”，或在系统设置中为本应用开启“完全磁盘访问权限”后重试。'
  }

  async function refreshTargets() {
    setTargetsLoading(true)
    setTargetsError(null)
    setTargetsHint(null)
    try {
      const list = await findEmojiTargetsWithMeta()
      // Prefer v4 targets first, then legacy. For v4, sort by mtime desc.
      list.sort((a, b) => {
        if (a.kind !== b.kind) {
          return a.kind === 'v4' ? -1 : 1
        }
        const am = a.mtimeMs || 0
        const bm = b.mtimeMs || 0
        return bm - am
      })
      setTargets(list)

      const last = localStorage.getItem('wxemoticon_last_target') || ''
      const values = list.map((t) =>
        t.kind === 'v4'
          ? encodeEmojiTarget({ kind: 'v4', wxidDir: t.wxidDir })
          : encodeEmojiTarget({
              kind: 'legacy',
              versionDir: t.versionDir,
              userDir: t.userDir
            })
      )

      if (last && values.includes(last)) {
        setSelectedTargetValue(last)
      } else if (values.length === 1) {
        setSelectedTargetValue(values[0])
      } else if (values.length > 1) {
        // Default to the most recently updated target.
        setSelectedTargetValue(values[0])
      }

      if (!list.length) {
        const diag = await diagnoseWeChatEnvironment().catch(() => null)
        const hint = buildWeChatAccessHint(diag)
        if (hint) {
          setTargetsError(hint)
        } else {
          setTargetsHint(buildNoTargetsHint(diag))
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setTargetsError(msg || '扫描账号失败')
      setTargetsHint(null)
      setTargets([])
    } finally {
      setTargetsLoading(false)
    }
  }

  useEffect(() => {
    // Restore the persisted directory scope before the first WeChat scan.
    restoreWeChatDataBookmark()
      .then((status) => {
        setWechatDataAccess(status)
        setWechatDataAccessError(null)
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        setWechatDataAccessError(detail || '恢复微信数据目录授权失败')
      })
      .finally(() => {
        setWechatDataAccessLoading(false)
        void refreshTargets()
      })
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    downloadDir()
      .then(setDownloadDirPath)
      .catch(() => {})

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    homeDir()
      .then(setHomeDirPath)
      .catch(() => {})
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    appDataDir()
      .then(setAppDataDirPath)
      .catch(() => {})

    const savedWeChatAppPath =
      localStorage.getItem('wxemoticon_wechat_app_path') || ''
    if (savedWeChatAppPath) {
      setWechatAppPath(savedWeChatAppPath)
    }

    let unlisten: null | (() => void) = null
    listen<WxEmoticonFlowEvent>('wxemoticon:flow', (event) => {
      const p = event.payload
      if (!flowActiveRef.current) {
        return
      }
      if (!p?.wxid || p.wxid !== activeFlowWxidRef.current) {
        return
      }

      const nextStage: FlowStage | null =
        p.stage === 'preparing_wechat_copy'
          ? 'preparingWeChatCopy'
          : p.stage === 'waiting_for_key'
            ? 'waitingForKey'
            : p.stage === 'offline_parsing' || p.stage === 'writing_files'
              ? 'offlineParsing'
              : p.stage === 'done'
                ? 'ready'
                : null
      if (nextStage) {
        setFlowStage(nextStage)
      }
      if (p.message) {
        setFlowHint(p.message)
      }
      if (p.stage === 'done') {
        flowActiveRef.current = false
      }
    })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})

    return () => {
      if (unlisten) {
        unlisten()
      }
    }
    // App bootstrap and the Tauri event subscription intentionally run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!wechatAppPath) {
      return
    }
    localStorage.setItem('wxemoticon_wechat_app_path', wechatAppPath)
  }, [wechatAppPath])

  useEffect(() => {
    localStorage.setItem(EMOJI_SORT_ORDER_STORAGE_KEY, emojiSortOrder)
  }, [emojiSortOrder])

  useEffect(() => {
    writeExportSettings(exportSettings)
  }, [exportSettings])

  useEffect(() => {
    if (!selectedTargetValue) {
      setLastExportDir(null)
      setIncompleteExport(null)
      return
    }
    const last = localStorage.getItem(
      `wxemoticon_last_export_dir|${selectedTargetValue}`
    )
    setLastExportDir(last || null)

    const incompleteRaw = localStorage.getItem(
      `wxemoticon_incomplete_export|${selectedTargetValue}`
    )
    if (!incompleteRaw) {
      setIncompleteExport(null)
      return
    }
    try {
      const parsed = JSON.parse(incompleteRaw) as Partial<IncompleteExport>
      if (parsed?.dirName && typeof parsed.groupSize === 'number') {
        const migrated: IncompleteExport = {
          dirName: parsed.dirName,
          groupSize: parsed.groupSize,
          sortOrder: isEmojiSortOrder(parsed.sortOrder)
            ? parsed.sortOrder
            : 'oldest-first'
        }
        setIncompleteExport(migrated)
        localStorage.setItem(
          `wxemoticon_incomplete_export|${selectedTargetValue}`,
          JSON.stringify(migrated)
        )
      } else {
        setIncompleteExport(null)
      }
    } catch {
      setIncompleteExport(null)
    }
  }, [selectedTargetValue])

  useEffect(() => {
    const target = selectedTargetMeta
    if (!target || !selectedTargetValue) {
      return
    }
    const targetId = valueOfTarget(target)
    if (lastActivatedTargetIdRef.current === targetId) {
      return
    }

    lastActivatedTargetIdRef.current = targetId
    activeTargetIdRef.current = targetId
    const generation = activationGenerationRef.current + 1
    activationGenerationRef.current = generation
    activePreviewTaskRef.current = null
    flowActiveRef.current = false
    activeFlowWxidRef.current = null

    setPreviewTaskIntent(null)
    setRawUrls([])
    setPreviewPage(1)
    setFlowError(null)
    setFlowStage('idle')
    setFlowHint('')
    setWechatMustQuit(false)
    setWeChatRunningMatches([])
    setLastDumpResult(null)

    const cache = readPreviewCache(targetId)
    if (cache) {
      setRawUrls(cache.urls)
      if (
        target.kind === 'v4' &&
        cache.artifacts?.wxid === target.wxidDir
      ) {
        setLastDumpResult(cache.artifacts)
      }
    }

    if (target.kind !== 'v4') {
      return
    }

    // Restore first, then refresh only this activated account when its key exists.
    void hasCachedDbKey(target.wxidDir).then((hasKey) => {
      if (
        !hasKey ||
        activeTargetIdRef.current !== targetId ||
        activationGenerationRef.current !== generation
      ) {
        return
      }
      void loadPreview({
        target,
        intent: 'auto-refresh',
        activationGeneration: generation,
        cachedPreview: Boolean(cache)
      })
    })
    // targetId is the account identity; rebuilt metadata must not reactivate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTargetMeta, selectedTargetValue])

  useEffect(() => {
    const orderedUrls = orderUrls(rawUrls, emojiSortOrder)
    setShowImgList(
      buildEmojiItems(orderedUrls, { wxappDomain, vweixinfDomain })
    )
    setPreviewPage(1)
  }, [emojiSortOrder, rawUrls])

  useEffect(() => {
    const total = showImgList.length
    const pages = Math.max(1, Math.ceil(total / previewPageSize))
    if (previewPage > pages) {
      setPreviewPage(pages)
    }
  }, [previewPage, previewPageSize, showImgList.length])

  async function selectChange(e: SelectChangeEvent<string>) {
    const value = e.target.value || ''
    setSelectedTargetValue(value)
    if (value) {
      localStorage.setItem('wxemoticon_last_target', value)
    }
  }

  async function chooseWeChatApp() {
    try {
      const selected = await open({
        title: '选择 WeChat.app 路径',
        multiple: false,
        directory: false,
        filters: [{ name: 'WeChat', extensions: ['app'] }]
      })
      if (typeof selected === 'string' && selected) {
        setWechatAppPath(selected)
      }
    } catch {
      // ignore
    }
  }

  async function authorizeWeChatDataDirectory() {
    setWechatDataAccessLoading(true)
    setWechatDataAccessError(null)
    try {
      const home = homeDirPath || (await homeDir())
      const expectedPath = await join(
        home,
        'Library',
        'Containers',
        'com.tencent.xinWeChat',
        'Data'
      )
      const selected = await open({
        title: '授权微信数据目录（请直接点击“打开”）',
        defaultPath: expectedPath,
        multiple: false,
        directory: true
      })
      if (typeof selected !== 'string' || !selected) {
        return
      }

      const status = await saveWeChatDataBookmark(selected)
      setWechatDataAccess(status)
      showToastMessage('微信数据目录授权已保存', 'success')
      await refreshTargets()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setWechatDataAccessError(detail || '保存微信数据目录授权失败')
      showToastMessage('微信数据目录授权失败', 'warning')
    } finally {
      setWechatDataAccessLoading(false)
    }
  }

  function buildTargetLabel(t: EmojiTargetMeta): string {
    const mtime = t.mtimeMs
      ? new Date(t.mtimeMs).toLocaleString('zh-CN', { hour12: false })
      : '未知'
    if (t.kind === 'v4') {
      return `新版微信（4.x）: ${t.wxidDir}（最后更新：${mtime}）`
    }
    return `旧版微信: ${t.userDir}（${t.versionDir}，最后更新：${mtime}）`
  }

  function showToastMessage(
    msg: string,
    severity: ToastState['severity'] = 'info'
  ) {
    setToast({ open: true, message: msg, severity })
  }

  function formatTimestampForDir(d = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    const y = d.getFullYear()
    const m = pad(d.getMonth() + 1)
    const day = pad(d.getDate())
    const h = pad(d.getHours())
    const min = pad(d.getMinutes())
    const s = pad(d.getSeconds())
    return `${y}${m}${day}_${h}${min}${s}`
  }

  function effectiveGroupSize(): number {
    if (exportGroupMode === 'none') {
      return 0
    }
    if (exportGroupMode === 'custom') {
      const n = Math.floor(Number(exportCustomGroupSize))
      if (!Number.isFinite(n) || n <= 0) {
        return 50
      }
      return n
    }
    return 50
  }

  async function openSystem(target: string) {
    await new Command('open-dir', [target]).execute()
  }

  async function resolveAppOutDir(): Promise<string | null> {
    try {
      const base = appDataDirPath || (await appDataDir())
      if (!base) {
        return null
      }
      return await join(base, 'export-wechat-emoji')
    } catch {
      return null
    }
  }

  async function resolveMirrorOutDir(): Promise<string | null> {
    try {
      const base = homeDirPath || (await homeDir())
      if (!base) {
        return null
      }
      return await join(
        base,
        'Library/Containers/com.tencent.xinWeChat/Data/Documents/export-wechat-emoji'
      )
    } catch {
      return null
    }
  }

  async function openLogDir() {
    try {
      if (lastDumpResult?.logFile) {
        const dir = await dirname(lastDumpResult.logFile)
        await openSystem(dir)
        return
      }
      const dir = (await resolveAppOutDir()) || (await resolveMirrorOutDir())
      if (dir) {
        await openSystem(dir)
        return
      }
      showToastMessage('无法定位日志目录', 'warning')
    } catch {
      showToastMessage('打开日志目录失败', 'warning')
    }
  }

  async function hasCachedDbKey(wxid: string): Promise<boolean> {
    try {
      const appDir = await resolveAppOutDir()
      if (appDir) {
        const p = await join(appDir, `emoticon_dbkey_${wxid}.txt`)
        if (await fsExists(p)) {
          return true
        }
      }
    } catch {
      // ignore
    }
    try {
      const mirrorDir = await resolveMirrorOutDir()
      if (mirrorDir) {
        const p1 = await join(mirrorDir, `emoticon_dbkey_${wxid}.txt`)
        if (await fsExists(p1)) {
          return true
        }
      }
    } catch {
      // ignore
    }
    return false
  }

  async function copyToClipboard(value: string, okMessage: string) {
    try {
      await writeText(value)
      showToastMessage(okMessage, 'success')
    } catch {
      showToastMessage('复制失败', 'warning')
    }
  }

  async function copyEmojiImage(src: string, itemKey: string) {
    if (copyingEmojiKeysRef.current.has(itemKey)) {
      return
    }
    copyingEmojiKeysRef.current.add(itemKey)
    setCopyingEmojiKeys((current) => new Set(current).add(itemKey))
    try {
      await copyEmojiFile(src)
      showToastMessage('已复制原图文件', 'success')
    } catch {
      showToastMessage('图片复制失败，请重试', 'warning')
    } finally {
      copyingEmojiKeysRef.current.delete(itemKey)
      setCopyingEmojiKeys((current) => {
        const next = new Set(current)
        next.delete(itemKey)
        return next
      })
    }
  }

  async function clearCurrentAccountCache() {
    const target = selectedTargetMeta
    if (!target) {
      return
    }
    const targetId = valueOfTarget(target)
    clearPreviewCache(targetId)

    if (activeTargetIdRef.current === targetId) {
      setRawUrls([])
      setPreviewPage(1)
      setLastDumpResult(null)
      setFlowError(null)
      setFlowStage('idle')
      setFlowHint('')
    }

    if (target.kind !== 'v4') {
      showToastMessage('已清除当前账号缓存', 'success')
      return
    }
    const wxid = target.wxidDir

    const appDir = await resolveAppOutDir()
    const mirrorDir = await resolveMirrorOutDir()
    const paths: Array<string> = []

    if (appDir) {
      paths.push(
        await join(appDir, `emoticon_dbkey_${wxid}.txt`),
        await join(appDir, `emoticon_dbkey_${wxid}.log`),
        await join(appDir, `emoticon_urls_${wxid}.txt`),
        await join(appDir, `emoticon_urls_${wxid}.log`)
      )
    }

    if (mirrorDir) {
      paths.push(
        await join(mirrorDir, `emoticon_dbkey_${wxid}.txt`),
        await join(mirrorDir, `emoticon_dbkey_${wxid}.log`),
        await join(mirrorDir, `emoticon_urls_${wxid}.txt`),
        await join(mirrorDir, `emoticon_urls_${wxid}.log`)
      )
    }

    for (const p of paths) {
      try {
        await removeFile(p)
      } catch {
        // ignore missing
      }
    }

    showToastMessage('已清除当前账号缓存', 'success')
  }

  async function loadPreview(options: LoadPreviewOptions = {}) {
    let target = options.target || selectedTargetMeta
    if (!target && targets.length === 1) {
      target = targets[0]
      const targetId = valueOfTarget(target)
      setSelectedTargetValue(targetId)
      activeTargetIdRef.current = targetId
      lastActivatedTargetIdRef.current = targetId
      activationGenerationRef.current += 1
    }

    if (!target) {
      if (targetsLoading) {
        const tip = '正在扫描微信账号，请稍候再试。'
        showToastMessage(tip, 'info')
        return await message(tip, { title: '提示', type: 'info' })
      }

      if (!targets.length) {
        const diag = await diagnoseWeChatEnvironment().catch(() => null)
        const tip = buildWeChatAccessHint(diag) || buildNoTargetsHint(diag)
        setFlowError(tip)
        setFlowStage('error')
        setFlowHint('')
        showToastMessage(tip, 'warning')
        return await message(tip, { title: '提示', type: 'warning' })
      }

      const tip = '请先选择账号，再点击「一键获取并预览」。'
      showToastMessage(tip, 'info')
      return await message(tip, { title: '提示', type: 'info' })
    }

    const targetId = valueOfTarget(target)
    const generation =
      options.activationGeneration ?? activationGenerationRef.current
    const belongsToActiveTarget = () =>
      activeTargetIdRef.current === targetId &&
      activationGenerationRef.current === generation

    if (activePreviewTaskRef.current) {
      return
    }

    const hadPreview = options.cachedPreview ?? rawUrls.length > 0
    const intent =
      options.intent || (hadPreview ? ('refresh' as const) : ('initial' as const))
    activePreviewTaskRef.current = { targetId, generation }
    setPreviewTaskIntent(intent)
    setFlowError(null)
    setFlowHint('')
    setWechatMustQuit(false)
    setWeChatRunningMatches([])

    try {
      if (target.kind === 'legacy') {
        setFlowStage('offlineParsing')
        setFlowHint('正在解析旧版微信数据…')
        const urls = await extractFavUrls(target.favArchivePath)
        if (!belongsToActiveTarget()) {
          return
        }
        if (!urls.length) {
          throw new Error('没有解析到任何表情包链接')
        }
        writePreviewCache(targetId, urls)
        setRawUrls(urls)
        setFlowStage('ready')
        setFlowHint('')
        return
      }

      // If a key already exists, refresh offline without forcing WeChat to quit.
      const hasKey = await hasCachedDbKey(target.wxidDir)
      if (!belongsToActiveTarget()) {
        return
      }
      if (!hasKey) {
        setFlowStage('checkingWechat')
        setFlowHint('正在检查微信是否已退出…')
        const check = await checkWeChatRunning(wechatAppPath)
        if (!belongsToActiveTarget()) {
          return
        }
        if (check.running) {
          setWechatMustQuit(true)
          setWeChatRunningMatches(check.matches || [])
          setFlowStage('idle')
          setFlowHint('')
          showToastMessage(
            '必须先完全退出微信，才能继续获取表情数据。',
            'warning'
          )
          return
        }
      }

      // The existing v4 pipeline uses this path when it needs to obtain a key.
      const ok = await fsExists(wechatAppPath)
      if (!belongsToActiveTarget()) {
        return
      }
      if (!ok) {
        const tip =
          '未找到 WeChat.app。请在「高级设置」里选择正确的 WeChat.app 路径后重试。'
        setFlowError(tip)
        setFlowStage('error')
        setFlowHint('')
        showToastMessage(tip, 'error')
        return
      }

      setFlowStage(hasKey ? 'offlineParsing' : 'preparingWeChatCopy')
      setFlowHint(
        hasKey
          ? '检测到缓存 key，正在离线解析…'
          : '正在准备微信副本并获取表情数据…（如弹出微信，请登录并打开一次表情面板）'
      )
      flowActiveRef.current = true
      activeFlowWxidRef.current = target.wxidDir
      const result = await autoDumpEmoticonUrlsV4(
        target.wxidDir,
        wechatAppPath,
        intent !== 'auto-refresh'
      )
      if (!belongsToActiveTarget()) {
        return
      }
      setLastDumpResult(result)
      const urls = result.urls || []
      if (!urls.length) {
        throw new Error('没有解析到任何表情包链接')
      }
      writePreviewCache(targetId, urls, result)
      setRawUrls(urls)
      setFlowStage('ready')
      setFlowHint('')
      flowActiveRef.current = false
    } catch (err) {
      if (!belongsToActiveTarget()) {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      flowActiveRef.current = false

      const text = msg || '自动导出失败'
      if (text.includes('WECHAT_RUNNING')) {
        // Only required when we need to dump/re-dump key.
        setWechatMustQuit(true)
        try {
          const check = await checkWeChatRunning(wechatAppPath)
          if (check.running) {
            setWeChatRunningMatches(check.matches || [])
          }
        } catch {
          // ignore
        }
        setFlowError(null)
        setFlowStage('idle')
        setFlowHint('')
        showToastMessage(
          '必须先完全退出微信，才能继续获取表情数据。',
          'warning'
        )
        return
      }
      const friendly = text.includes('timed out waiting for db key')
        ? '获取 db key 超时：请确保已退出微信，然后登录并打开一次表情面板后重试。'
        : text.includes('WeChat.app not found')
          ? '未找到 WeChat.app：请在「高级设置」里选择正确的 WeChat.app 路径后重试。'
          : text

      if (hadPreview) {
        setFlowError(null)
        setFlowStage('ready')
        showToastMessage(
          intent === 'auto-refresh'
            ? '已显示缓存，自动刷新失败，可手动重试'
            : '重新获取失败，已保留缓存预览',
          'warning'
        )
      } else {
        setFlowError(friendly)
        setFlowStage('error')
        showToastMessage(friendly || '自动导出失败', 'error')
      }
      setFlowHint('')
    } finally {
      const task = activePreviewTaskRef.current
      if (task?.targetId === targetId && task.generation === generation) {
        activePreviewTaskRef.current = null
        if (belongsToActiveTarget()) {
          setPreviewTaskIntent(null)
        }
      }
    }
  }

  async function runExport(options: {
    dirName: string
    groupSize: number
    resumeExisting: boolean
    sortOrder: EmojiSortOrder
  }) {
    if (!rawUrls.length) {
      return await message('请先获取并预览表情包', {
        title: '提示',
        type: 'info'
      })
    }

    setIsExporting(true)
    setExportProgress(0)
    setExportOk(0)
    setExportSkipped(0)
    setExportFailed(0)
    setCancelRequested(false)
    cancelExportRef.current = false
    createdSubDirsRef.current = new Set()

    const exportUrls = orderUrls(rawUrls, options.sortOrder)
    const items = buildEmojiItems(exportUrls, { wxappDomain, vweixinfDomain })
    const fileKeys = buildUniqueFileKeys(items.map((i) => i._text))

    let ok = 0
    let skipped = 0
    let failed = 0

    try {
      if (selectedTargetValue) {
        localStorage.setItem(
          `wxemoticon_incomplete_export|${selectedTargetValue}`,
          JSON.stringify({
            dirName: options.dirName,
            groupSize: options.groupSize,
            sortOrder: options.sortOrder
          })
        )
        setIncompleteExport({
          dirName: options.dirName,
          groupSize: options.groupSize,
          sortOrder: options.sortOrder
        })
      }

      await ensureExportRootDir(options.dirName)
      await writeUsageReadme(options.dirName, text)
      await writeUrlsFile(options.dirName, exportUrls)
      if (
        selectedTargetMeta?.kind === 'v4' &&
        lastDumpResult?.dbKey &&
        lastDumpResult.dbKey.length >= 32
      ) {
        await writeDbKeyFile(options.dirName, lastDumpResult.dbKey)
      }

      for (let i = 0; i < items.length; i++) {
        if (cancelExportRef.current) {
          break
        }

        const { _text: src } = items[i]
        const fileKey = fileKeys[i]

        if (options.resumeExisting) {
          let exists = false
          try {
            exists = await exportedEmojiExistsByKey({
              customEmotionsDirName: options.dirName,
              groupSize: options.groupSize,
              index: i,
              fileKey
            })
          } catch {
            exists = false
          }
          if (exists) {
            skipped += 1
            setExportSkipped(skipped)
            setExportProgress(i + 1)
            continue
          }
        }

        let result
        try {
          result = await loadEmojiBinary(src)
        } catch {
          failed += 1
          setExportFailed(failed)
          setExportProgress(i + 1)
          continue
        }
        if (cancelExportRef.current) {
          break
        }

        try {
          await exportOneEmoji({
            customEmotionsDirName: options.dirName,
            groupSize: options.groupSize,
            createdSubDirs: createdSubDirsRef.current,
            index: i,
            usedUrl: result.usedUrl,
            fileKey,
            buffer: result.buffer,
            ext: result.ext
          })
          ok += 1
          setExportOk(ok)
        } catch {
          failed += 1
          setExportFailed(failed)
        }

        setExportProgress(i + 1)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToastMessage(msg || '导出失败', 'error')
      return
    } finally {
      setIsExporting(false)
      setCancelRequested(false)
    }

    const canceled = cancelExportRef.current
    const result: ExportResult = {
      dirName: options.dirName,
      total: items.length,
      ok,
      skipped,
      failed,
      canceled,
      groupSize: options.groupSize
    }
    setExportResult(result)

    if (selectedTargetValue) {
      if (!canceled) {
        localStorage.removeItem(
          `wxemoticon_incomplete_export|${selectedTargetValue}`
        )
        localStorage.setItem(
          `wxemoticon_last_export_dir|${selectedTargetValue}`,
          options.dirName
        )
        setLastExportDir(options.dirName)
        setIncompleteExport(null)
      }
    }

    if (!canceled && exportAutoOpen) {
      try {
        await openExportDir(downloadDirPath, options.dirName)
      } catch {
        // ignore
      }
    }

    if (canceled) {
      showToastMessage(
        '已取消导出：你可以选择“继续上次导出（断点续跑）”',
        'warning'
      )
    } else {
      showToastMessage('导出完成', 'success')
    }
  }

  async function startNewExport() {
    if (!rawUrls.length) {
      return await message('请先获取并预览表情包', {
        title: '提示',
        type: 'info'
      })
    }
    if (exportGroupMode === 'custom') {
      const n = Math.floor(Number(exportCustomGroupSize))
      if (!Number.isFinite(n) || n <= 0) {
        return await message('自定义分组大小必须是大于 0 的整数', {
          title: '提示',
          type: 'info'
        })
      }
    }

    const dirName = `微信表情包_导出_${formatTimestampForDir()}`
    const groupSize = effectiveGroupSize()
    await runExport({
      dirName,
      groupSize,
      resumeExisting: exportResume,
      sortOrder: emojiSortOrder
    })
  }

  async function continueLastExport() {
    if (!incompleteExport) {
      return
    }
    if (incompleteExport.sortOrder !== emojiSortOrder) {
      setResumeSortConflictOpen(true)
      return
    }
    await continueExportWithRecordedOrder()
  }

  async function continueExportWithRecordedOrder() {
    if (!incompleteExport) {
      return
    }
    await runExport({
      dirName: incompleteExport.dirName,
      groupSize: incompleteExport.groupSize,
      resumeExisting: true,
      sortOrder: incompleteExport.sortOrder
    })
  }

  function cancelExport() {
    cancelExportRef.current = true
    setCancelRequested(true)
  }

  function renderPreviewGrid() {
    if (!showImgList.length) {
      return (
        <Typography variant="body1" color="text.secondary">
          {!targets.length
            ? '暂未检测到微信账号；请确认微信已登录，然后点击「刷新」'
            : selectedTargetValue
              ? '暂无预览，请先点击「一键获取并预览」'
              : '先选择账号，然后点击「一键获取并预览」'}
        </Typography>
      )
    }

    const pageStart = (previewPage - 1) * previewPageSize
    const pageEnd = previewPage * previewPageSize
    const pageCount = Math.ceil(showImgList.length / previewPageSize)

    return (
      <Box className="img-list">
        {pageCount > 1 && (
          <Stack
            direction="row"
            spacing={2}
            alignItems="center"
            justifyContent="space-between"
            sx={{ mb: 1 }}
          >
            <Typography variant="body2" color="text.secondary">
              第 {pageStart + 1}-{Math.min(pageEnd, showImgList.length)} 个 / 共{' '}
              {showImgList.length} 个
            </Typography>
            <Pagination
              count={pageCount}
              page={previewPage}
              onChange={(_event, page) => setPreviewPage(page)}
              disabled={isExporting}
              size="small"
            />
          </Stack>
        )}

        <ImageList cols={5} gap={8} sx={{ width: '100%', m: 0 }}>
          <PhotoProvider>
            {showImgList.slice(pageStart, pageEnd).map((item, index) => {
              const absoluteIndex = pageStart + index
              const itemKey = `${item._text}|${absoluteIndex}`
              const isCopying = copyingEmojiKeys.has(itemKey)
              return (
                <ImageListItem
                  key={itemKey}
                  sx={{ minWidth: 0, position: 'relative' }}
                >
                  <ButtonBase
                    className="img-preview"
                    aria-label={`下载并复制表情 ${absoluteIndex + 1}`}
                    disabled={isCopying}
                    onClick={() => void copyEmojiImage(item._text, itemKey)}
                  >
                    <img
                      src={item.src}
                      loading="lazy"
                      alt=""
                      onError={() => {
                        const candidates = getStodownloadCandidates(item._text)
                        const nextIndex = (item.fallbackIndex ?? 0) + 1
                        if (nextIndex >= candidates.length) {
                          return
                        }

                        setShowImgList((current) =>
                          current.map((candidate) =>
                            candidate._text === item._text
                              ? {
                                  ...candidate,
                                  src: candidates[nextIndex],
                                  fallbackIndex: nextIndex
                                }
                              : candidate
                          )
                        )
                      }}
                    />
                    {isCopying && (
                      <Box className="emoji-copy-loading" aria-label="正在复制图片">
                        <CircularProgress size={24} />
                      </Box>
                    )}
                  </ButtonBase>

                  <Stack
                    className="emoji-item-actions"
                    direction="row"
                    spacing={0.25}
                  >
                    <Tooltip title="查看大图">
                      <span onClick={(event) => event.stopPropagation()}>
                        <PhotoView src={item.src}>
                          <IconButton
                            size="small"
                            aria-label="查看大图"
                            className="emoji-item-action"
                          >
                            <ZoomInIcon />
                          </IconButton>
                        </PhotoView>
                      </span>
                    </Tooltip>
                    <Tooltip title="打开图片链接">
                      <IconButton
                        size="small"
                        aria-label="打开图片链接"
                        className="emoji-item-action"
                        onClick={(event) => {
                          event.stopPropagation()
                          void openSystem(item.src).catch(() =>
                            showToastMessage('打开图片链接失败', 'warning')
                          )
                        }}
                      >
                        <LinkIcon />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </ImageListItem>
              )
            })}
          </PhotoProvider>
        </ImageList>
      </Box>
    )
  }

  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Stack spacing={1.5} alignItems="stretch">
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1.5}>
            <Stack spacing={1.25}>
              <Stack direction="row" spacing={1} alignItems="center">
                {targets.length === 1 && (
                  <TextField
                    label="已检测到 1 个账号"
                    size="small"
                    value={buildTargetLabel(targets[0])}
                    disabled
                    sx={{ flex: 1 }}
                  />
                )}

                {targets.length > 1 && (
                  <FormControl size="small" sx={{ flex: 1 }}>
                    <InputLabel id="target-select">选择账号</InputLabel>
                    <Select
                      labelId="target-select"
                      label="选择账号"
                      value={selectedTargetValue}
                      onChange={selectChange}
                      disabled={
                        isExporting || isPreviewLoading || targetsLoading
                      }
                    >
                      {targets.map((t) => {
                        const value =
                          t.kind === 'v4'
                            ? encodeEmojiTarget({
                                kind: 'v4',
                                wxidDir: t.wxidDir
                              })
                            : encodeEmojiTarget({
                                kind: 'legacy',
                                versionDir: t.versionDir,
                                userDir: t.userDir
                              })
                        return (
                          <MenuItem key={value} value={value}>
                            {buildTargetLabel(t)}
                          </MenuItem>
                        )
                      })}
                    </Select>
                  </FormControl>
                )}

                {!targets.length && <Box sx={{ flex: 1 }} />}
                {targetsLoading && <CircularProgress size={18} />}
                <Button
                  variant="outlined"
                  onClick={refreshTargets}
                  disabled={targetsLoading || isExporting || isPreviewLoading}
                >
                  刷新
                </Button>
              </Stack>

              {!wechatDataAccess && !wechatDataAccessLoading && (
                <Alert
                  severity="info"
                  action={
                    <Button
                      color="inherit"
                      size="small"
                      onClick={() => setActiveTab('advanced')}
                    >
                      去授权
                    </Button>
                  }
                >
                  macOS 会在应用每次启动时询问是否访问微信数据。可在“高级设置”中一次性授权微信数据目录，减少重复提示。
                </Alert>
              )}

              {targetsError && <Alert severity="error">{targetsError}</Alert>}

              {!targetsLoading && !targets.length && !targetsError && (
                <Alert severity="warning">
                  {targetsHint ||
                    '没找到微信表情包数据（旧版 fav.archive / 新版 emoticon.db）。请确认已安装并登录微信；可在「高级设置」中授权微信数据目录以避免每次启动重复提示。如果仍为空，请点击「刷新」，或在系统设置中为本应用开启“完全磁盘访问权限”后重试。'}
                </Alert>
              )}

              <Tabs
                value={activeTab}
                onChange={(_event, value: AppTab) => setActiveTab(value)}
                aria-label="功能导航"
                variant="fullWidth"
              >
                <Tab
                  value="preview"
                  label={
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <span>表情预览</span>
                      {isPreviewLoading && <CircularProgress size={14} />}
                    </Stack>
                  }
                />
                <Tab
                  value="export"
                  label={
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <span>导出</span>
                      {isExporting && <CircularProgress size={14} />}
                    </Stack>
                  }
                />
                <Tab value="advanced" label="高级设置" />
              </Tabs>

              {activeTab === 'preview' && (
                <Stack spacing={1.25}>
                  {wechatMustQuit && (
                    <Alert
                      severity="warning"
                      sx={{
                        alignItems: 'center',
                        '& .MuiAlert-action': {
                          alignItems: 'center',
                          paddingTop: 0
                        }
                      }}
                      action={
                        <Button
                          color="inherit"
                          size="small"
                          onClick={() => void loadPreview()}
                          disabled={
                            isExporting || isPreviewLoading || targetsLoading
                          }
                          variant="outlined"
                          sx={{ whiteSpace: 'nowrap' }}
                        >
                          重新检查
                        </Button>
                      }
                    >
                      必须先完全退出微信才能继续下一步（否则无法获取/数据库占用）
                      {wechatRunningMatches.length
                        ? `（检测到 ${wechatRunningMatches.length} 个相关进程）`
                        : ''}
                      。
                    </Alert>
                  )}

                  {flowError && (
                    <Alert
                      severity="error"
                      action={
                        selectedTargetMeta?.kind === 'v4' ? (
                          <Button
                            color="inherit"
                            size="small"
                            onClick={openLogDir}
                          >
                            打开日志目录
                          </Button>
                        ) : undefined
                      }
                    >
                      {flowError}
                    </Alert>
                  )}

                  <Stack direction="row" spacing={1.5} flexWrap="wrap">
                    <Button
                      size="large"
                      variant="contained"
                      onClick={() => void loadPreview()}
                      disabled={
                        isExporting || isPreviewLoading || targetsLoading
                      }
                    >
                      {previewTaskIntent
                        ? previewTaskIntent === 'initial'
                          ? '正在获取…'
                          : '正在重新获取…'
                        : rawUrls.length
                          ? '重新获取'
                          : '一键获取并预览'}
                    </Button>
                  </Stack>

                  {previewTaskIntent === 'initial' &&
                    (flowStage === 'checkingWechat' ||
                      flowStage === 'preparingWeChatCopy' ||
                      flowStage === 'waitingForKey' ||
                      flowStage === 'offlineParsing') && (
                    <Box>
                      {selectedTargetMeta?.kind === 'v4' && (
                        <Stepper
                          activeStep={
                            flowStage === 'checkingWechat'
                              ? 0
                              : flowStage === 'preparingWeChatCopy'
                                ? 1
                                : flowStage === 'waitingForKey'
                                  ? 2
                                  : flowStage === 'offlineParsing'
                                    ? 3
                                    : 0
                          }
                          alternativeLabel
                        >
                          <Step>
                            <StepLabel>检查微信已退出</StepLabel>
                          </Step>
                          <Step>
                            <StepLabel>准备微信副本</StepLabel>
                          </Step>
                          <Step>
                            <StepLabel>等待抓取 key</StepLabel>
                          </Step>
                          <Step>
                            <StepLabel>离线解析</StepLabel>
                          </Step>
                          <Step>
                            <StepLabel>预览就绪</StepLabel>
                          </Step>
                        </Stepper>
                      )}
                      <Box sx={{ mt: 1 }}>
                        <Typography variant="body2" sx={{ mb: 0.75 }}>
                          {flowHint ||
                            (flowStage === 'checkingWechat'
                              ? '正在检查微信进程…'
                              : '正在处理，请稍候…')}
                        </Typography>
                        <LinearProgress />
                      </Box>
                    </Box>
                  )}

                  {renderPreviewGrid()}
                </Stack>
              )}

              {activeTab === 'export' && (
                <Stack spacing={1.25}>
                  {!rawUrls.length ? (
                    <Alert
                      severity="info"
                      action={
                        <Button
                          color="inherit"
                          size="small"
                          onClick={() => setActiveTab('preview')}
                        >
                          去获取
                        </Button>
                      }
                    >
                      请先在“表情预览”中获取表情。
                    </Alert>
                  ) : (
                    <>
                      <Stack direction="row" spacing={1.5} flexWrap="wrap">
                        <Button
                          size="large"
                          variant="contained"
                          onClick={startNewExport}
                          disabled={isExporting || cancelRequested}
                        >
                          开始导出
                        </Button>
                        {!!incompleteExport && (
                          <Button
                            size="large"
                            variant="outlined"
                            onClick={continueLastExport}
                            disabled={isExporting || cancelRequested}
                          >
                            继续上次导出（断点续跑）
                          </Button>
                        )}
                        <Button
                          color="warning"
                          size="large"
                          variant="outlined"
                          onClick={cancelExport}
                          disabled={!isExporting || cancelRequested}
                        >
                          {cancelRequested ? '正在取消…' : '取消导出'}
                        </Button>
                      </Stack>

                      <Typography variant="body1" sx={{ fontWeight: 700 }}>
                        导出设置
                      </Typography>

                      <FormControl component="fieldset">
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{ mb: 0.5 }}
                        >
                          导出分组
                        </Typography>
                        <RadioGroup
                          value={exportGroupMode}
                          onChange={(e) =>
                            setExportSettings((current) => ({
                              ...current,
                              groupMode: e.target.value as
                                | 'recommended'
                                | 'none'
                                | 'custom'
                            }))
                          }
                        >
                          <FormControlLabel
                            value="recommended"
                            control={<Radio disabled={isExporting} />}
                            label="每 50 张分组（默认/推荐）"
                            disabled={isExporting}
                          />
                          <FormControlLabel
                            value="none"
                            control={<Radio disabled={isExporting} />}
                            label="不分组（全部放在一个目录）"
                            disabled={isExporting}
                          />
                          <FormControlLabel
                            value="custom"
                            control={<Radio disabled={isExporting} />}
                            label="自定义分组大小"
                            disabled={isExporting}
                          />
                        </RadioGroup>
                      </FormControl>

                      {exportGroupMode === 'custom' && (
                        <TextField
                          type="number"
                          size="small"
                          label="自定义分组大小"
                          value={exportCustomGroupSize}
                          onChange={(e) =>
                            setExportSettings((current) => ({
                              ...current,
                              customGroupSize: normalizeCustomGroupSize(
                                Number(e.target.value)
                              )
                            }))
                          }
                          disabled={isExporting}
                          inputProps={{ min: 1 }}
                        />
                      )}

                      <Stack direction="row" spacing={2} flexWrap="wrap">
                        <FormControlLabel
                          control={
                            <Switch
                              checked={exportResume}
                              onChange={(e) =>
                                setExportSettings((current) => ({
                                  ...current,
                                  resume: e.target.checked
                                }))
                              }
                              disabled={isExporting}
                            />
                          }
                          label="断点续跑（跳过已存在文件）"
                        />
                        <FormControlLabel
                          control={
                            <Switch
                              checked={exportAutoOpen}
                              onChange={(e) =>
                                setExportSettings((current) => ({
                                  ...current,
                                  autoOpen: e.target.checked
                                }))
                              }
                              disabled={isExporting}
                            />
                          }
                          label="导出完成后自动打开目录"
                        />
                      </Stack>

                      <Typography variant="body2" color="text.secondary">
                        导出目录固定在「下载」目录下；每次导出都会创建一个新文件夹。
                      </Typography>

                      {(isExporting || exportProgress > 0) && (
                        <Box>
                          <Typography variant="body2" sx={{ mb: 0.75 }}>
                            导出进度：{exportProgress}/{rawUrls.length}（成功：
                            {exportOk}，跳过：{exportSkipped}，失败：
                            {exportFailed}）
                          </Typography>
                          <LinearProgress
                            variant="determinate"
                            value={
                              rawUrls.length
                                ? (exportProgress / rawUrls.length) * 100
                                : 0
                            }
                          />
                        </Box>
                      )}

                      {!!lastExportDir && (
                        <Stack
                          direction="row"
                          spacing={1.25}
                          alignItems="center"
                        >
                          <Typography variant="body2" color="text.secondary">
                            上次导出：{lastExportDir}
                          </Typography>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() =>
                              openExportDir(
                                downloadDirPath,
                                lastExportDir
                              ).catch(() => {})
                            }
                          >
                            打开
                          </Button>
                        </Stack>
                      )}
                    </>
                  )}
                </Stack>
              )}

              {activeTab === 'advanced' && (
                <Stack spacing={1.5}>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    表情排序方式
                  </Typography>
                  <FormControl size="small" fullWidth>
                    <InputLabel id="emoji-sort-order-label">
                      表情排序
                    </InputLabel>
                    <Select
                      labelId="emoji-sort-order-label"
                      label="表情排序"
                      value={emojiSortOrder}
                      onChange={(event) =>
                        setEmojiSortOrder(event.target.value as EmojiSortOrder)
                      }
                      disabled={isExporting}
                    >
                      <MenuItem value="newest-first">最新添加在前</MenuItem>
                      <MenuItem value="oldest-first">最早添加在前</MenuItem>
                    </Select>
                  </FormControl>

                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    微信数据访问授权
                  </Typography>
                  <Alert severity={wechatDataAccess ? 'success' : 'info'}>
                    {wechatDataAccess
                      ? '已保存目录授权'
                      : '授权后会保存 security-scoped bookmark，并在每次扫描前恢复。选择器已预选微信 Data 目录，只需点击“打开”。'}
                  </Alert>
                  {wechatDataAccessError && (
                    <Alert severity="warning">{wechatDataAccessError}</Alert>
                  )}
                  <Stack direction="row" spacing={1.25} alignItems="center">
                    <Button
                      variant="outlined"
                      onClick={authorizeWeChatDataDirectory}
                      disabled={
                        wechatDataAccessLoading ||
                        isExporting ||
                        isPreviewLoading ||
                        targetsLoading
                      }
                    >
                      {wechatDataAccessLoading
                        ? '正在处理…'
                        : wechatDataAccess
                          ? '重新授权微信目录'
                          : '授权微信数据目录'}
                    </Button>
                    <Typography variant="caption" color="text.secondary">
                      目标目录：~/Library/Containers/com.tencent.xinWeChat/Data
                    </Typography>
                  </Stack>

                  <Divider />

                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    WeChat.app 路径
                  </Typography>
                  <Alert severity="info">
                    这里用于设置微信应用路径与查看调试产物。默认使用
                    /Applications/WeChat.app；如果你保留了官方备份（如
                    WeChat.bak.app），可在这里选择对应路径。
                  </Alert>
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <TextField
                      label="WeChat.app 路径"
                      size="small"
                      value={wechatAppPath}
                      onChange={(e) => setWechatAppPath(e.target.value)}
                      disabled={isExporting || isPreviewLoading}
                      fullWidth
                    />
                    <Button
                      variant="outlined"
                      onClick={chooseWeChatApp}
                      disabled={isExporting || isPreviewLoading}
                    >
                      选择
                    </Button>
                  </Stack>

                  <Divider />
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    调试产物（当前账号）
                  </Typography>

                  {selectedTargetMeta?.kind === 'legacy' && rawUrls.length > 0 && (
                    <Typography variant="body2" color="text.secondary">
                      已恢复该账号的本地 URL 缓存（{rawUrls.length} 条）。旧版微信
                      3.x 不生成 db key；当前缓存存于应用本地，暂无可复制的独立 URL
                      文件路径。
                    </Typography>
                  )}

                  {selectedTargetMeta?.kind === 'legacy' && !rawUrls.length && (
                    <Typography variant="body2" color="text.secondary">
                      旧版微信 3.x 不生成 db key；手动获取成功后会保存当前账号的 URL
                      缓存。
                    </Typography>
                  )}

                  {selectedTargetMeta?.kind === 'v4' && !lastDumpResult && (
                    <Typography variant="body2" color="text.secondary">
                      请先点击「一键获取并预览」一次，才能生成/刷新 db key、URL
                      列表与日志。
                    </Typography>
                  )}

                  {selectedTargetMeta?.kind === 'v4' && !!lastDumpResult && (
                    <Stack spacing={1.25}>
                      <Stack direction="row" spacing={1.25} flexWrap="wrap">
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() =>
                            copyToClipboard(
                              lastDumpResult.dbKey,
                              '已复制 db key'
                            )
                          }
                        >
                          复制 db key
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() => openSystem(lastDumpResult.dbKeyFile)}
                        >
                          打开 db key 文件
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() => openSystem(lastDumpResult.urlsFile)}
                        >
                          打开 URL 列表文件
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={openLogDir}
                        >
                          打开日志目录
                        </Button>
                      </Stack>

                      <Stack direction="row" spacing={1.25} flexWrap="wrap">
                        <Button
                          size="small"
                          variant="text"
                          onClick={() =>
                            copyToClipboard(
                              lastDumpResult.urlsFile,
                              '已复制 URL 列表文件路径'
                            )
                          }
                        >
                          复制 URL 文件路径
                        </Button>
                        <Button
                          size="small"
                          variant="text"
                          onClick={() =>
                            copyToClipboard(
                              lastDumpResult.logFile,
                              '已复制日志文件路径'
                            )
                          }
                        >
                          复制日志文件路径
                        </Button>
                      </Stack>
                    </Stack>
                  )}

                  <Divider />
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    账号缓存
                  </Typography>

                  <Button
                    color="warning"
                    variant="outlined"
                    onClick={() => setConfirmClearCacheOpen(true)}
                    disabled={
                      isExporting || isPreviewLoading || !selectedTargetMeta
                    }
                  >
                    清除当前账号缓存
                  </Button>
                </Stack>
              )}
            </Stack>
          </Stack>
        </Paper>

        <Dialog
          open={resumeSortConflictOpen}
          onClose={() => setResumeSortConflictOpen(false)}
          maxWidth="sm"
          fullWidth
        >
          <DialogTitle>排序方式与上次导出不同</DialogTitle>
          <DialogContent>
            <Typography variant="body2" color="text.secondary" sx={{ pt: 1 }}>
              上次未完成的导出使用“
              {incompleteExport?.sortOrder === 'newest-first'
                ? '最新添加在前'
                : '最早添加在前'}
              ”，当前设置为“
              {emojiSortOrder === 'newest-first'
                ? '最新添加在前'
                : '最早添加在前'}
              ”。为避免同一目录混用两种顺序，请选择继续方式。
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setResumeSortConflictOpen(false)}>
              取消
            </Button>
            <Button
              onClick={async () => {
                setResumeSortConflictOpen(false)
                await continueExportWithRecordedOrder()
              }}
            >
              按上次排序继续
            </Button>
            <Button
              variant="contained"
              onClick={async () => {
                setResumeSortConflictOpen(false)
                await startNewExport()
              }}
            >
              按当前排序开始新的导出
            </Button>
          </DialogActions>
        </Dialog>

        <Dialog
          open={!!exportResult}
          onClose={() => setExportResult(null)}
          maxWidth="sm"
          fullWidth
        >
          <DialogTitle>
            {exportResult?.canceled ? '导出已取消' : '导出完成'}
          </DialogTitle>
          <DialogContent>
            <Stack spacing={1} sx={{ pt: 1 }}>
              <Typography variant="body2" color="text.secondary">
                导出目录：下载/{exportResult?.dirName}
              </Typography>
              <Typography variant="body2">
                总数：{exportResult?.total}，成功：{exportResult?.ok}，跳过：
                {exportResult?.skipped}，失败：{exportResult?.failed}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                说明、URL 列表与（新版微信时）db key
                在导出目录的「导出信息」子目录中。
              </Typography>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={() => {
                if (!exportResult) {
                  return
                }
                openExportDir(downloadDirPath, exportResult.dirName).catch(
                  () => {}
                )
                setExportResult(null)
              }}
              disabled={!exportResult || !downloadDirPath}
            >
              打开目录
            </Button>
            <Button onClick={() => setExportResult(null)}>关闭</Button>
          </DialogActions>
        </Dialog>

        <Dialog
          open={confirmClearCacheOpen}
          onClose={() => setConfirmClearCacheOpen(false)}
          maxWidth="sm"
          fullWidth
        >
          <DialogTitle>确认清除缓存？</DialogTitle>
          <DialogContent>
            <Typography variant="body2" color="text.secondary" sx={{ pt: 1 }}>
              将删除当前账号的 db key、URL
              列表与日志缓存文件。下次需要重新获取。
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmClearCacheOpen(false)}>
              取消
            </Button>
            <Button
              color="warning"
              onClick={() => {
                setConfirmClearCacheOpen(false)
                clearCurrentAccountCache().catch(() => {})
              }}
            >
              清除
            </Button>
          </DialogActions>
        </Dialog>

        <Snackbar
          open={toast.open}
          autoHideDuration={2500}
          onClose={() => setToast((s) => ({ ...s, open: false }))}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert
            onClose={() => setToast((s) => ({ ...s, open: false }))}
            severity={toast.severity}
            sx={{ width: '100%' }}
          >
            {toast.message}
          </Alert>
        </Snackbar>
      </Stack>
    </Container>
  )
}

export default App
