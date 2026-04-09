import type {
  EmoticonCatalogMode,
  EmojiAlbum,
  EmojiTargetMeta,
  IMaybeUrl
} from './types'
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined'
import DownloadIcon from '@mui/icons-material/Download'
import EmailOutlinedIcon from '@mui/icons-material/EmailOutlined'
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined'
import SettingsIcon from '@mui/icons-material/Settings'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  Link,
  LinearProgress,
  Menu,
  Pagination,
  Paper,
  Radio,
  RadioGroup,
  Snackbar,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
  alpha
} from '@mui/material'
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
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { StatusBanner } from './components/Common/StatusBanner'
import { EmojiGrid } from './components/EmojiGrid/index'
import { Sidebar } from './components/Sidebar/index'
import {
  APP_VERSION,
  DEVELOPER_EMAIL,
  GITHUB_REPOSITORY_URL,
  STICKERHUB_URL
} from './consts/app'
import { text } from './consts/text'
import {
  autoDumpEmoticonUrlsV4,
  buildEmoticonCatalogV4,
  buildEmojiItems,
  buildEmojiItemsFromRenderItems,
  extractFavUrls,
  type AutoDumpUrlsResult
} from './services/archive'
import { fetchBinaryWithFallback } from './services/downloader'
import {
  buildGitHubMissingAlbumIssueUrl,
  buildMissingAlbumFeedbackPayload,
  isValidFeedbackContactEmail,
  submitMissingAlbumEmailFeedback
} from './services/feedback'
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
import {
  extFromBytes,
  extFromContentType,
  extFromUrl
} from './services/stodownload'
import {
  buildStickerHubAlbumItems,
  readStickerHubAlbumCache,
  refreshStickerHubAlbum,
  type StickerHubAlbumPayload,
  type StickerHubAlbumState
} from './services/stickerhub'
import {
  checkWeChatRunning,
  diagnoseWeChatEnvironment,
  readCurrentWeChatAccountProfile,
  type WeChatEnvironmentDiag
} from './services/system'
import {
  displayNameOfTarget,
  encodeEmojiTarget,
  findEmojiTargetsWithMeta,
  mergeCurrentAccountProfileIntoTargets,
} from './services/wechat'

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

type IncompleteExport = {
  dirName: string
  groupSize: number
}

type ToastState = {
  open: boolean
  message: string
  severity: 'success' | 'info' | 'warning' | 'error'
}

type StickerHubAlbumViewState = {
  status: StickerHubAlbumState
  retryAt?: number
}

function SettingsGroup({
  title,
  children
}: {
  title: string
  children: ReactNode
}) {
  return (
    <Box>
      <Typography
        variant="overline"
        sx={{ display: 'block', mb: 0.75, px: 0.25 }}
      >
        {title}
      </Typography>
      <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
        {children}
      </Paper>
    </Box>
  )
}

function SettingsRow({
  title,
  description,
  action
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <Box
      sx={{
        minHeight: 64,
        px: 2,
        py: 1.5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 2
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 650 }}>
          {title}
        </Typography>
        {description && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 0.25 }}
          >
            {description}
          </Typography>
        )}
      </Box>
      {action && <Box sx={{ flexShrink: 0 }}>{action}</Box>}
    </Box>
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
  const [showImgList, setShowImgList] = useState<Array<IMaybeUrl>>([])
  const [previewPage, setPreviewPage] = useState(1)
  const previewPageSize = 50
  const [albums, setAlbums] = useState<EmojiAlbum[]>([])
  const [catalogFavorites, setCatalogFavorites] = useState<Array<string>>([])
  const [catalogMode, setCatalogMode] = useState<EmoticonCatalogMode>('unavailable')
  const [catalogWarnings, setCatalogWarnings] = useState<string[]>([])
  const [stickerHubAlbumStates, setStickerHubAlbumStates] = useState<
    Record<string, StickerHubAlbumViewState>
  >({})
  const [stickerHubRetryNonce, setStickerHubRetryNonce] = useState(0)
  const [rateLimitNow, setRateLimitNow] = useState(() => Date.now())

  // 导出状态
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportOk, setExportOk] = useState(0)
  const [exportSkipped, setExportSkipped] = useState(0)
  const [exportFailed, setExportFailed] = useState(0)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [exportResult, setExportResult] = useState<ExportResult | null>(null)
  const [incompleteExport, setIncompleteExport] =
    useState<IncompleteExport | null>(null)

  // 导出设置
  const [exportGroupMode, setExportGroupMode] = useState<
    'recommended' | 'none' | 'custom'
  >('recommended')
  const [exportCustomGroupSize, setExportCustomGroupSize] = useState(50)
  const [exportResume, setExportResume] = useState(true)
  const [exportAutoOpen, setExportAutoOpen] = useState(true)

  // download 目录路径（用于 open）
  const [downloadDirPath, setDownloadDirPath] = useState('')
  const [homeDirPath, setHomeDirPath] = useState('')
  const [appDataDirPath, setAppDataDirPath] = useState('')
  const [currentView, setCurrentView] = useState<string>('favorites')

  // 自动抓取状态（带步骤）
  const [flowStage, setFlowStage] = useState<FlowStage>('idle')
  const [flowHint, setFlowHint] = useState('')
  const [flowError, setFlowError] = useState<string | null>(null)
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
  const [emailFeedbackSending, setEmailFeedbackSending] = useState(false)
  const [githubFeedbackOpen, setGithubFeedbackOpen] = useState(false)
  const [emailFeedbackOpen, setEmailFeedbackOpen] = useState(false)
  const [feedbackContactEmail, setFeedbackContactEmail] = useState('')
  const [feedbackContactEmailError, setFeedbackContactEmailError] = useState('')
  const [confirmClearCacheOpen, setConfirmClearCacheOpen] = useState(false)

  const [wechatAppPath, setWechatAppPath] = useState('/Applications/WeChat.app')
  const cancelExportRef = useRef(false)
  const createdSubDirsRef = useRef<Set<number>>(new Set())
  const activeFlowWxidRef = useRef<string | null>(null)
  const flowActiveRef = useRef(false)
  const albumRequestGenerationRef = useRef(0)

  // Settings Menu
  const [settingsAnchorEl, setSettingsAnchorEl] = useState<null | HTMLElement>(
    null
  )
  const openSettings = Boolean(settingsAnchorEl)

  const valueOfTarget = (t: EmojiTargetMeta) => encodeEmojiTarget(t)

  const selectedTargetMeta = useMemo(() => {
    if (!selectedTargetValue) {
      return null
    }
    return targets.find((t) => valueOfTarget(t) === selectedTargetValue) || null
  }, [selectedTargetValue, targets])

  const lastUpdatedText = useMemo(() => {
    const ms = selectedTargetMeta?.mtimeMs
    if (!ms) {
      return ''
    }
    const d = new Date(ms)
    return d.toLocaleString('zh-CN', { hour12: false })
  }, [selectedTargetMeta?.mtimeMs])

  const selectedTargetName = useMemo(() => {
    if (!selectedTargetMeta) {
      return ''
    }
    return displayNameOfTarget(selectedTargetMeta)
  }, [selectedTargetMeta])

  const currentAlbum = useMemo(() => {
    if (!currentView.startsWith('album|')) {
      return null
    }
    const id = currentView.split('|')[1]
    return albums.find((album) => album.id === id) || null
  }, [albums, currentView])

  const currentStickerHubState = currentAlbum?.packageId
    ? stickerHubAlbumStates[currentAlbum.packageId] || { status: 'idle' as const }
    : { status: 'idle' as const }

  const currentRetrySeconds = currentStickerHubState.retryAt
    ? Math.max(0, Math.ceil((currentStickerHubState.retryAt - rateLimitNow) / 1000))
    : 0

  const currentViewTitle = useMemo(() => {
    if (currentView === 'favorites') {
      return '个人收藏'
    }
    if (currentView === 'settings') {
      return '设置'
    }
    if (currentView.startsWith('album|')) {
      const id = currentView.split('|')[1]
      const album = albums.find((a) => a.id === id)
      return album ? album.name : '未知专辑'
    }
    return ''
  }, [currentView, albums])

  const currentViewSubtitle = useMemo(() => {
    if (currentView === 'settings') {
      return '管理账号数据、导出规则和本地缓存'
    }
    if (currentView === 'favorites') {
      if (flowStage === 'ready') {
        return `${catalogFavorites.length} 个收藏表情${lastUpdatedText ? ` · 更新于 ${lastUpdatedText}` : ''}`
      }
      return selectedTargetMeta
        ? `准备读取 ${selectedTargetName} 的收藏表情`
        : '选择微信账号后读取收藏表情'
    }
    if (currentAlbum) {
      if (currentStickerHubState.status === 'loading') {
        return '正在读取专辑'
      }
      if (currentStickerHubState.status === 'not_found') {
        return '可以反馈给开发者，帮助补充收录'
      }
      if (
        currentStickerHubState.status === 'offline' ||
        currentStickerHubState.status === 'error'
      ) {
        return '专辑资源暂不可用'
      }
      if (showImgList.length) {
        return `${showImgList.length} 个表情`
      }
      return `${currentAlbum.count} 个表情`
    }
    return ''
  }, [
    catalogFavorites.length,
    currentAlbum,
    currentStickerHubState.status,
    currentView,
    flowStage,
    lastUpdatedText,
    selectedTargetMeta,
    selectedTargetName,
    showImgList.length
  ])

  const previewRangeText = showImgList.length
    ? `${(previewPage - 1) * previewPageSize + 1}–${Math.min(
        previewPage * previewPageSize,
        showImgList.length
      )} / ${showImgList.length}`
    : ''

  const catalogNotice = useMemo(() => {
    if (flowStage !== 'ready') {
      return null
    }

    if (catalogMode === 'full' && catalogWarnings.length === 0) {
      return null
    }

    if (catalogMode === 'full') {
      return {
        severity: 'warning' as const,
        message: '部分本地资源暂时无法读取。'
      }
    }

    if (catalogMode === 'partial') {
      return {
        severity: 'warning' as const,
        message: '部分专辑暂时无法完整显示。'
      }
    }

    if (catalogMode === 'favorites_only') {
      return {
        severity: 'info' as const,
        message:
          selectedTargetMeta?.kind === 'legacy'
            ? '此微信版本仅支持个人收藏。'
            : '当前账号没有可用的表情专辑。'
      }
    }

    return {
      severity: 'info' as const,
      message: '暂时无法读取表情专辑。'
    }
  }, [
    catalogMode,
    catalogWarnings,
    flowStage,
    selectedTargetMeta?.kind
  ])

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

    return '无法读取微信数据。请确认微信已登录，并在系统设置中为本应用开启“完全磁盘访问权限”后重试。'
  }

  function buildNoTargetsHint(diag: WeChatEnvironmentDiag | null): string {
    if (diag?.v4DataDir.exists && diag.v4DataDir.readable) {
      return '没有找到可用的微信账号。请确认已登录微信 4.x，并至少打开过一次表情面板，然后刷新。'
    }

    if (diag?.legacyDataDir.exists && diag.legacyDataDir.readable) {
      return '没有找到可用的微信账号。请确认微信已登录，然后刷新。'
    }

    return '未检测到微信表情包数据。请确认已安装并登录微信；如果微信已登录但仍为空，请点击“刷新”，并在系统设置中为本应用开启“完全磁盘访问权限”后重试。'
  }

  async function refreshTargets() {
    setTargetsLoading(true)
    setTargetsError(null)
    setTargetsHint(null)
    try {
      const [list, currentProfile] = await Promise.all([
        findEmojiTargetsWithMeta(),
        readCurrentWeChatAccountProfile().catch(() => null)
      ])
      const mergedTargets = mergeCurrentAccountProfileIntoTargets(
        list,
        currentProfile
      )
      // Prefer current likely account first, then v4 targets, then latest activity.
      mergedTargets.sort((a, b) => {
        if (!!a.isCurrentLikelyAccount !== !!b.isCurrentLikelyAccount) {
          return a.isCurrentLikelyAccount ? -1 : 1
        }
        if (a.kind !== b.kind) {
          return a.kind === 'v4' ? -1 : 1
        }
        const am = a.mtimeMs || 0
        const bm = b.mtimeMs || 0
        return bm - am
      })
      setTargets(mergedTargets)

      const last = localStorage.getItem('wxemoticon_last_target') || ''
      const values = mergedTargets.map((t) => valueOfTarget(t))

      if (last && values.includes(last)) {
        setSelectedTargetValue(last)
      } else if (values.length === 1) {
        setSelectedTargetValue(values[0])
      } else if (values.length > 1) {
        // Default to the most recently updated target.
        setSelectedTargetValue(values[0])
      }

      if (!mergedTargets.length) {
        const diag = await diagnoseWeChatEnvironment().catch(() => null)
        const hint = buildWeChatAccessHint(diag)
        if (hint) {
          setTargetsError(hint)
        } else {
          setTargetsHint(buildNoTargetsHint(diag))
        }
      }
    } catch {
      setTargetsError('无法扫描微信账号。请检查磁盘访问权限后重试。')
      setTargetsHint(null)
      setTargets([])
    } finally {
      setTargetsLoading(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    refreshTargets()
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!wechatAppPath) {
      return
    }
    localStorage.setItem('wxemoticon_wechat_app_path', wechatAppPath)
  }, [wechatAppPath])

  useEffect(() => {
    if (!selectedTargetValue) {
      setIncompleteExport(null)
      return
    }

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
        setIncompleteExport({
          dirName: parsed.dirName,
          groupSize: parsed.groupSize
        })
      } else {
        setIncompleteExport(null)
      }
    } catch {
      setIncompleteExport(null)
    }
  }, [selectedTargetValue])

  useEffect(() => {
    const total = showImgList.length
    const pages = Math.max(1, Math.ceil(total / previewPageSize))
    if (previewPage > pages) {
      setPreviewPage(pages)
    }
  }, [previewPage, previewPageSize, showImgList.length])

  useEffect(() => {
    const retryAt = currentStickerHubState.retryAt
    if (!retryAt || retryAt <= Date.now()) {
      return
    }
    setRateLimitNow(Date.now())
    const timer = window.setInterval(() => {
      const now = Date.now()
      setRateLimitNow(now)
      if (now >= retryAt) {
        window.clearInterval(timer)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [currentStickerHubState.retryAt])

  async function selectChange(e: any) {
    const value = e.target.value || ''
    setSelectedTargetValue(value)
    setAlbums([])
    setCatalogFavorites([])
    setCatalogWarnings([])
    setCatalogMode('unavailable')
    setShowImgList([])
    setPreviewPage(1)
    setFlowError(null)
    setFlowStage('idle')
    setFlowHint('')
    setWechatMustQuit(false)
    setWeChatRunningMatches([])
    setLastDumpResult(null)
    if (currentView === 'favorites' || currentView.startsWith('album|')) {
      setCurrentView('favorites')
    }
    if (value) {
      localStorage.setItem('wxemoticon_last_target', value)
    }
  }

  async function chooseWeChatApp() {
    try {
      const selected = await open({
        title: '选择微信应用',
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

  function openMissingAlbumIssue() {
    if (!currentAlbum) {
      return
    }
    setGithubFeedbackOpen(true)
  }

  async function confirmMissingAlbumIssue() {
    if (!currentAlbum) {
      return
    }
    setGithubFeedbackOpen(false)
    try {
      const payload = buildMissingAlbumFeedbackPayload(currentAlbum)
      await openSystem(buildGitHubMissingAlbumIssueUrl(payload))
      showToastMessage('已打开 GitHub，请在页面中确认提交', 'info')
    } catch {
      showToastMessage('无法打开 GitHub，请稍后重试', 'warning')
    }
  }

  function openMissingAlbumEmail() {
    if (!currentAlbum || emailFeedbackSending) {
      return
    }
    setFeedbackContactEmail('')
    setFeedbackContactEmailError('')
    setEmailFeedbackOpen(true)
  }

  function closeMissingAlbumEmail() {
    if (emailFeedbackSending) {
      return
    }
    setEmailFeedbackOpen(false)
    setFeedbackContactEmailError('')
  }

  async function sendMissingAlbumEmail() {
    if (!currentAlbum || emailFeedbackSending) {
      return
    }
    const contactEmail = feedbackContactEmail.trim()
    if (contactEmail && !isValidFeedbackContactEmail(contactEmail)) {
      setFeedbackContactEmailError('请输入有效的邮箱地址')
      return
    }
    setFeedbackContactEmailError('')
    setEmailFeedbackSending(true)
    try {
      await submitMissingAlbumEmailFeedback(
        buildMissingAlbumFeedbackPayload(currentAlbum, contactEmail)
      )
      setEmailFeedbackOpen(false)
      setFeedbackContactEmail('')
      showToastMessage('反馈邮件已发送给开发者', 'success')
    } catch {
      showToastMessage('邮件反馈暂时不可用，请改用 GitHub 反馈', 'warning')
    } finally {
      setEmailFeedbackSending(false)
    }
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

  async function openStickerHub() {
    try {
      await openSystem(STICKERHUB_URL)
    } catch {
      showToastMessage('无法打开 StickerHub', 'warning')
    }
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
        const p2 = await join(mirrorDir, 'emoticon_dbkey.txt')
        if (await fsExists(p2)) {
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

  async function clearCurrentAccountCache() {
    if (selectedTargetMeta?.kind !== 'v4') {
      showToastMessage('当前账号没有可清除的缓存', 'info')
      return
    }
    const wxid = selectedTargetMeta.wxidDir

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
        await join(mirrorDir, `emoticon_urls_${wxid}.log`),
        await join(mirrorDir, 'emoticon_dbkey.txt'),
        await join(mirrorDir, 'emoticon_urls.txt'),
        await join(mirrorDir, 'emoticon_urls.log')
      )
    }

    for (const p of paths) {
      try {
        await removeFile(p)
      } catch {
        // ignore missing
      }
    }

    setLastDumpResult(null)
    showToastMessage('已清除当前账号缓存', 'success')
  }

  async function loadPreview() {
    let target = selectedTargetMeta
    if (!target && targets.length === 1) {
      target = targets[0]
      setSelectedTargetValue(valueOfTarget(targets[0]))
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

      const tip = '请先选择微信账号。'
      showToastMessage(tip, 'info')
      return await message(tip, { title: '提示', type: 'info' })
    }

    setFlowError(null)
    setFlowHint('')
    setWechatMustQuit(false)
    setWeChatRunningMatches([])
    setAlbums([])
    setCatalogFavorites([])
    setCatalogWarnings([])
    setCatalogMode('unavailable')
    setShowImgList([])
    setPreviewPage(1)
    setLastDumpResult(null)

    if (target.kind === 'legacy') {
      setFlowStage('offlineParsing')
      setFlowHint('正在解析旧版微信数据…')
      try {
        const urls = await extractFavUrls(target.favArchivePath)
        if (!urls.length) {
          throw new Error('没有解析到任何表情包链接')
        }
        setAlbums([])
        setCatalogFavorites(urls)
        setCatalogWarnings([])
        setCatalogMode('favorites_only')
        setCurrentView('favorites')
        setShowImgList(buildEmojiItems(urls, { wxappDomain, vweixinfDomain }))
        setFlowStage('ready')
        setFlowHint('')
      } catch {
        setFlowError('读取个人收藏失败。请确认微信数据完整后重试。')
        setFlowStage('error')
        setFlowHint('')
      }
      return
    }

    // v4 flow:
    // - If we already have a cached db key, we can try offline parsing without forcing the user to quit WeChat.
    // - Only require quitting WeChat when we need to dump a new key.
    const hasKey = await hasCachedDbKey(target.wxidDir)
    if (!hasKey) {
      setFlowStage('checkingWechat')
      setFlowHint('正在检查微信是否已退出…')
      try {
        const check = await checkWeChatRunning(wechatAppPath)
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
      } catch {
        const friendly = '无法确认微信状态。请完全退出微信后重试。'
        setFlowError(friendly)
        setFlowStage('error')
        setFlowHint('')
        showToastMessage(friendly, 'error')
        return
      }
    }

    // Ensure WeChat.app exists (otherwise the injector cannot run).
    try {
      const ok = await fsExists(wechatAppPath)
      if (!ok) {
        const tip = '未找到微信应用。请在“设置”中重新选择安装位置。'
        setFlowError(tip)
        setFlowStage('error')
        setFlowHint('')
        showToastMessage(tip, 'error')
        return
      }
    } catch {
      // ignore
    }

    setFlowStage(hasKey ? 'offlineParsing' : 'preparingWeChatCopy')
    setFlowHint(
      hasKey
        ? '正在读取本地表情数据…'
        : '正在准备微信数据…如微信自动打开，请登录并打开一次表情面板。'
    )
    flowActiveRef.current = true
    activeFlowWxidRef.current = target.wxidDir
    try {
      const result = await autoDumpEmoticonUrlsV4(target.wxidDir, wechatAppPath)
      setLastDumpResult(result)
      const catalog = await buildEmoticonCatalogV4(target.wxidDir, result.dbKey)
      const favorites = catalog.favorites || []
      const nextAlbums = catalog.albums || []
      const nextMode = catalog.mode || 'unavailable'
      const nextWarnings = catalog.warnings || []
      const favoritePreviewItems = buildEmojiItems(favorites, {
        wxappDomain,
        vweixinfDomain
      })
      const previewItems = favoritePreviewItems

      if (!previewItems.length && !nextAlbums.length && !favorites.length) {
        throw new Error('没有解析到任何可预览的表情资源')
      }

      const effectiveWarnings = [...nextWarnings]

      setAlbums(nextAlbums)
      setCatalogFavorites(favorites)
      setCatalogWarnings(effectiveWarnings)
      setCatalogMode(nextMode)
      setCurrentView('favorites')
      setShowImgList(previewItems)
      setPreviewPage(1)
      setFlowStage('ready')
      setFlowHint('')
      flowActiveRef.current = false
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      flowActiveRef.current = false

      const textMsg = msg || '自动导出失败'
      if (textMsg.includes('WECHAT_RUNNING')) {
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
      const friendly = textMsg.includes('timed out waiting for db key')
        ? '读取超时。请完全退出微信，然后重试；微信打开后请登录并打开一次表情面板。'
        : textMsg.includes('WeChat.app not found')
          ? '未找到微信应用。请在“设置”中重新选择安装位置。'
          : '读取表情失败。请重试；如果问题持续，请在“设置”中打开诊断信息。'

      setFlowError(friendly)
      setFlowStage('error')
      setFlowHint('')
      showToastMessage(friendly || '自动导出失败', 'error')
    }
  }

  useEffect(() => {
    if (currentView !== 'favorites') {
      return
    }

    setShowImgList(
      buildEmojiItems(catalogFavorites, { wxappDomain, vweixinfDomain })
    )
    setPreviewPage(1)
  }, [catalogFavorites, currentView])

  useEffect(() => {
    if (!currentView.startsWith('album|')) {
      return
    }
    if (currentAlbum) {
      return
    }

    setCurrentView('favorites')
  }, [currentAlbum, currentView])

  useEffect(() => {
    if (!currentView.startsWith('album|')) {
      return
    }
    if (!currentAlbum) {
      return
    }

    const generation = ++albumRequestGenerationRef.current
    const packageId = currentAlbum.packageId
    setShowImgList([])
    setPreviewPage(1)

    if (!packageId) {
      return
    }

    let cancelled = false
    const isCurrentRequest = () =>
      !cancelled && albumRequestGenerationRef.current === generation

    const setAlbumStatus = (state: StickerHubAlbumViewState) => {
      if (!isCurrentRequest()) {
        return
      }
      setStickerHubAlbumStates((previous) => ({
        ...previous,
        [packageId]: state
      }))
    }

    const applyPayload = (
      payload: StickerHubAlbumPayload | null,
      status: StickerHubAlbumState
    ) => {
      if (!payload || !isCurrentRequest()) {
        return false
      }
      const items = buildStickerHubAlbumItems(currentAlbum, payload)
      const iconFallback = items[0]?.downloadUrl || items[0]?.previewUrl
      setShowImgList(buildEmojiItemsFromRenderItems(items))
      setPreviewPage(1)
      setAlbumStatus({ status: items.length ? status : 'not_found' })
      setAlbums((previous) =>
        previous.map((album) =>
          album.packageId === packageId
            ? {
                ...album,
                icon: payload.iconUrl || album.icon,
                iconFallback: iconFallback || album.iconFallback,
                count: payload.members.length
              }
            : album
        )
      )
      return items.length > 0
    }

    const loadSupplement = async () => {
      setAlbumStatus({ status: 'loading' })
      let cacheStatus: 'fresh' | 'stale' | 'missing' = 'missing'
      try {
        const cache = await readStickerHubAlbumCache(packageId)
        if (!isCurrentRequest()) {
          return
        }
        cacheStatus = cache.status
        if (cache.payload) {
          applyPayload(
            cache.payload,
            cache.status === 'fresh' ? 'ready' : 'stale'
          )
        }
        if (cache.status === 'fresh') {
          return
        }
      } catch {
        cacheStatus = 'missing'
      }

      if (cacheStatus === 'missing') {
        setAlbumStatus({ status: 'loading' })
      }

      try {
        const result = await refreshStickerHubAlbum(packageId)
        if (!isCurrentRequest()) {
          return
        }
        const hasRemoteItems = result.payload
          ? applyPayload(
            result.payload,
            result.status === 'ready' ? 'ready' : 'stale'
          )
          : false
        if (result.status === 'rate_limited') {
          setAlbumStatus({
            status: 'rate_limited',
            retryAt: Date.now() + (result.retryAfterSeconds || 60) * 1000
          })
        } else if (result.status === 'invalid_request') {
          setAlbumStatus({ status: 'error' })
        } else if (result.status === 'ready' && result.payload) {
          if (!hasRemoteItems) {
            setAlbumStatus({ status: 'not_found' })
          }
        } else {
          setAlbumStatus({ status: result.status })
        }
      } catch {
        setAlbumStatus({ status: cacheStatus === 'stale' ? 'error' : 'offline' })
      }
    }

    void loadSupplement()
    return () => {
      cancelled = true
    }
  }, [
    currentAlbum?.id,
    currentAlbum?.packageId,
    currentView,
    stickerHubRetryNonce
  ])

  function retryCurrentAlbumSupplement() {
    const packageId = currentAlbum?.packageId
    if (!packageId) {
      return
    }
    const state = stickerHubAlbumStates[packageId]
    if (state?.retryAt && state.retryAt > Date.now()) {
      return
    }
    setStickerHubAlbumStates((previous) => ({
      ...previous,
      [packageId]: { status: 'loading' }
    }))
    setStickerHubRetryNonce((value) => value + 1)
  }

  async function runExport(options: {
    dirName: string
    groupSize: number
    resumeExisting: boolean
  }) {
    if (!showImgList.length) {
      return await message('请先读取表情。', {
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

    const items = showImgList
    const fileKeys = buildUniqueFileKeys(
      items.map((i, index) => i.downloadUrl || i._text || String(index + 1))
    )

    let ok = 0
    let skipped = 0
    let failed = 0

    try {
      if (selectedTargetValue) {
        localStorage.setItem(
          `wxemoticon_incomplete_export|${selectedTargetValue}`,
          JSON.stringify({
            dirName: options.dirName,
            groupSize: options.groupSize
          })
        )
        setIncompleteExport({
          dirName: options.dirName,
          groupSize: options.groupSize
        })
      }

      await ensureExportRootDir(options.dirName)
      await writeUsageReadme(options.dirName, text)
      await writeUrlsFile(
        options.dirName,
        items.map(
          (item) =>
            item.localSourcePath ||
            item.downloadUrl ||
            item.src ||
            item._text
        )
      )
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

        const src =
          items[i].localSourcePath ||
          items[i].downloadUrl ||
          items[i].src ||
          items[i]._text
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

        const result = await fetchBinaryWithFallback(src)
        if (cancelExportRef.current) {
          break
        }

        if (result.ok) {
          const ext =
            extFromBytes(result.buffer) ||
            extFromContentType(result.contentType) ||
            extFromUrl(result.usedUrl) ||
            'gif'
          try {
            await exportOneEmoji({
              customEmotionsDirName: options.dirName,
              groupSize: options.groupSize,
              createdSubDirs: createdSubDirsRef.current,
              index: i,
              usedUrl: result.usedUrl,
              fileKey,
              buffer: result.buffer,
              ext
            })
            ok += 1
            setExportOk(ok)
          } catch {
            failed += 1
            setExportFailed(failed)
          }
        } else {
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
      showToastMessage('导出已停止，可稍后继续', 'warning')
    } else {
      showToastMessage('导出完成', 'success')
    }
  }

  async function startNewExport() {
    if (!showImgList.length) {
      return await message('请先读取表情。', {
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
      resumeExisting: exportResume
    })
  }

  async function continueLastExport() {
    if (!incompleteExport) {
      return
    }
    await runExport({
      dirName: incompleteExport.dirName,
      groupSize: incompleteExport.groupSize,
      resumeExisting: true
    })
  }

  function cancelExport() {
    cancelExportRef.current = true
    setCancelRequested(true)
  }

  return (
    <Box
      sx={{
        display: 'flex',
        height: '100vh',
        overflow: 'hidden',
        bgcolor: 'background.default'
      }}
    >
      <Sidebar
        targets={targets}
        selectedTargetValue={selectedTargetValue}
        onSelectChange={selectChange}
        onRefreshTargets={refreshTargets}
        targetsLoading={targetsLoading}
        isExporting={isExporting}
        currentView={currentView}
        onViewChange={setCurrentView}
        albums={albums}
        favoritesCount={catalogFavorites.length}
        catalogMode={catalogMode}
      />

      <Box component="main" className="main-content" sx={{ position: 'relative' }}>
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <Box
            component="header"
            sx={{
              flexShrink: 0,
              px: 3,
              py: 1.5,
              minHeight: 68,
              display: 'flex',
              alignItems: 'center',
              borderBottom: '1px solid',
              borderColor: 'divider',
              bgcolor: '#FFFFFF'
            }}
          >
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              spacing={1}
              sx={{ width: '100%', minWidth: 0 }}
            >
              <Box sx={{ minWidth: 80, flex: 1 }}>
                <Typography variant="h5" noWrap>
                  {currentViewTitle}
                </Typography>
                <Typography
                  variant="caption"
                  noWrap
                  sx={{ display: 'block', mt: 0.25 }}
                >
                  {currentViewSubtitle}
                </Typography>
              </Box>
              {(currentView === 'favorites' ||
                currentView.startsWith('album|')) && (
                <Stack
                  direction="row"
                  spacing={0.75}
                  alignItems="center"
                  flexShrink={0}
                >
                  {!isExporting && (
                    <>
                      <Button
                        aria-label="获取并预览"
                        variant={showImgList.length ? 'outlined' : 'contained'}
                        onClick={loadPreview}
                        disabled={targetsLoading || !selectedTargetValue}
                        size="small"
                      >
                        {showImgList.length ? '重新读取' : '读取表情'}
                      </Button>

                      {showImgList.length > 0 && (
                        <>
                          <Button
                            variant="contained"
                            startIcon={<DownloadIcon sx={{ fontSize: 17 }} />}
                            onClick={startNewExport}
                            size="small"
                          >
                            导出全部
                          </Button>
                          {incompleteExport && (
                            <Button
                              variant="outlined"
                              onClick={continueLastExport}
                              size="small"
                            >
                              继续上次
                            </Button>
                          )}
                          <Tooltip title="导出设置">
                            <IconButton
                              aria-label="导出设置"
                              onClick={(event) =>
                                setSettingsAnchorEl(event.currentTarget)
                              }
                            >
                              <SettingsIcon sx={{ fontSize: 18 }} />
                            </IconButton>
                          </Tooltip>
                        </>
                      )}
                    </>
                  )}

                  {isExporting && (
                    <Button
                      variant="outlined"
                      color="error"
                      onClick={cancelExport}
                      disabled={cancelRequested}
                      size="small"
                    >
                      {cancelRequested ? '正在停止…' : '停止导出'}
                    </Button>
                  )}
                </Stack>
              )}
            </Stack>
          </Box>

          <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 3, py: 2.5 }}>
            {targetsError && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {targetsError}
              </Alert>
            )}
            {targetsHint && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                {targetsHint}
              </Alert>
            )}

            <StatusBanner
              flowStage={flowStage}
              flowHint={flowHint}
              flowError={flowError}
              wechatMustQuit={wechatMustQuit}
              wechatRunningMatches={wechatRunningMatches}
              onRetry={loadPreview}
              onOpenLogDir={openLogDir}
              isV4={selectedTargetMeta?.kind === 'v4'}
            />

            {catalogNotice && currentView === 'favorites' && (
                <Alert
                  severity={catalogNotice.severity}
                  variant="outlined"
                  sx={{ mb: 2 }}
                >
                  {catalogNotice.message}
                </Alert>
              )}

            {currentView === 'favorites' || currentView.startsWith('album|') ? (
              <>
                {currentView.startsWith('album|') &&
                  currentStickerHubState.status === 'loading' && (
                    <Alert severity="info" sx={{ mb: 2 }}>
                      正在加载专辑图片…
                    </Alert>
                  )}

                {currentView.startsWith('album|') &&
                  currentStickerHubState.status === 'stale' && (
                    <Alert severity="info" sx={{ mb: 2 }}>
                      已显示本地缓存，正在检查更新…
                    </Alert>
                  )}

                {currentView.startsWith('album|') &&
                  (currentStickerHubState.status === 'offline' ||
                    currentStickerHubState.status === 'error') && (
                    <Alert
                      severity="warning"
                      sx={{ mb: 2 }}
                      action={
                        <Button
                          color="inherit"
                          size="small"
                          onClick={retryCurrentAlbumSupplement}
                        >
                          重试
                        </Button>
                      }
                    >
                      {currentStickerHubState.status === 'offline'
                        ? '当前网络不可用，无法补全这个专辑。'
                        : '这个专辑暂时无法补全。'}
                    </Alert>
                  )}

                {currentView.startsWith('album|') &&
                  currentStickerHubState.status === 'rate_limited' && (
                    <Alert
                      severity="warning"
                      sx={{ mb: 2 }}
                      action={
                        <Button
                          color="inherit"
                          size="small"
                          disabled={currentRetrySeconds > 0}
                          onClick={retryCurrentAlbumSupplement}
                        >
                          {currentRetrySeconds > 0
                            ? `${currentRetrySeconds} 秒后重试`
                            : '重试'}
                        </Button>
                      }
                    >
                      请求较频繁，请稍后再试。
                    </Alert>
                  )}

                {showImgList.length > 0 && (
                  <Stack
                    direction="row"
                    justifyContent="flex-end"
                    alignItems="center"
                    spacing={1}
                    sx={{ minHeight: 32, mb: 1.5 }}
                  >
                    <Typography variant="caption">{previewRangeText}</Typography>
                    {showImgList.length > previewPageSize && (
                      <Pagination
                        count={Math.ceil(showImgList.length / previewPageSize)}
                        page={previewPage}
                        onChange={(_, page) => setPreviewPage(page)}
                        color="primary"
                        size="small"
                        siblingCount={0}
                        boundaryCount={1}
                      />
                    )}
                  </Stack>
                )}

                {currentView.startsWith('album|') &&
                currentStickerHubState.status === 'loading' &&
                showImgList.length === 0 ? (
                  <Box
                    aria-label="正在加载专辑图片"
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
                      gap: 1.25
                    }}
                  >
                    {Array.from({ length: 10 }, (_, index) => (
                      <Skeleton
                        key={index}
                        variant="rounded"
                        height={132}
                        sx={{ borderRadius: 1 }}
                      />
                    ))}
                  </Box>
                ) : (
                  <EmojiGrid
                    showImgList={showImgList}
                    previewPage={previewPage}
                    previewPageSize={previewPageSize}
                    copyToClipboard={copyToClipboard}
                    openSystem={openSystem}
                    setShowImgList={setShowImgList}
                    emptyTitle={
                      currentView.startsWith('album|')
                        ? currentStickerHubState.status === 'not_found'
                          ? '这个专辑还没有收录'
                          : '此专辑暂时无法预览'
                        : undefined
                    }
                    emptyDescription={
                      currentView.startsWith('album|')
                        ? currentStickerHubState.status === 'not_found'
                          ? (
                            <>
                              专辑表情包由{' '}
                              <Link
                                component="button"
                                type="button"
                                underline="hover"
                                onClick={() => void openStickerHub()}
                                sx={{
                                  p: 0,
                                  border: 0,
                                  bgcolor: 'transparent',
                                  color: 'primary.main',
                                  font: 'inherit',
                                  fontWeight: 650,
                                  cursor: 'pointer'
                                }}
                              >
                                StickerHub API
                              </Link>{' '}
                              提供支持。你可以反馈这个专辑，帮助开发者补充收录。
                            </>
                          )
                          : '请检查网络后重试'
                        : undefined
                    }
                    emptyAction={
                      currentView.startsWith('album|') &&
                      currentStickerHubState.status === 'not_found' ? (
                        <Stack
                          direction="row"
                          spacing={1}
                          flexWrap="wrap"
                          justifyContent="center"
                        >
                          <Button
                            variant="contained"
                            size="small"
                            startIcon={<OpenInNewOutlinedIcon />}
                            onClick={openMissingAlbumIssue}
                          >
                            通过 GitHub 反馈
                          </Button>
                          <Button
                            variant="outlined"
                            size="small"
                            startIcon={<EmailOutlinedIcon />}
                            onClick={openMissingAlbumEmail}
                            disabled={emailFeedbackSending}
                          >
                            邮件反馈
                          </Button>
                        </Stack>
                      ) : undefined
                    }
                  />
                )}
              </>
            ) : currentView === 'settings' ? (
              <Box sx={{ maxWidth: 720 }}>
                <Stack spacing={3}>
                  {selectedTargetMeta ? (
                    <SettingsGroup title="当前账号">
                      <SettingsRow
                        title={selectedTargetName}
                        description={
                          selectedTargetMeta.kind === 'v4'
                            ? '微信 4.x 账号'
                            : '旧版微信账号，仅支持个人收藏'
                        }
                      />
                      {selectedTargetMeta.kind === 'v4' && (
                        <>
                          <Divider />
                          <SettingsRow
                            title="账号密钥"
                            description={
                              lastDumpResult?.dbKey
                                ? '已读取并保存在本机'
                                : '读取表情后生成'
                            }
                            action={
                              <Button
                                variant="outlined"
                                size="small"
                                disabled={!lastDumpResult?.dbKey}
                                onClick={() =>
                                  copyToClipboard(
                                    lastDumpResult?.dbKey || '',
                                    '账号密钥已复制'
                                  )
                                }
                              >
                                复制
                              </Button>
                            }
                          />
                        </>
                      )}
                      <Divider />
                      <SettingsRow
                        title="本地缓存"
                        description="遇到读取异常时，可清除缓存后重新读取"
                        action={
                          <Stack direction="row" spacing={1}>
                            {selectedTargetMeta.kind === 'v4' && (
                              <Button
                                variant="outlined"
                                onClick={openLogDir}
                                size="small"
                              >
                                诊断信息
                              </Button>
                            )}
                            <Button
                              variant="outlined"
                              color="warning"
                              onClick={() => setConfirmClearCacheOpen(true)}
                              disabled={isExporting}
                              size="small"
                            >
                              清除缓存
                            </Button>
                          </Stack>
                        }
                      />
                    </SettingsGroup>
                  ) : (
                    <Alert severity="info" variant="outlined">
                      请先选择微信账号。
                    </Alert>
                  )}

                  <SettingsGroup title="微信应用">
                    <Box
                      sx={{
                        px: 2,
                        py: 1.75,
                        display: 'flex',
                        alignItems: 'flex-end',
                        gap: 1.25
                      }}
                    >
                      <TextField
                        fullWidth
                        size="small"
                        label="安装位置"
                        helperText="通常无需修改；仅在应用无法找到微信时重新选择"
                        value={wechatAppPath}
                        onChange={(event) =>
                          setWechatAppPath(event.target.value)
                        }
                        disabled={isExporting}
                      />
                      <Button
                        variant="outlined"
                        onClick={chooseWeChatApp}
                        disabled={isExporting}
                        sx={{ mb: 2.75 }}
                      >
                        选择
                      </Button>
                    </Box>
                  </SettingsGroup>
                  <SettingsGroup title="关于">
                    <SettingsRow
                      title="导出微信表情包"
                      description="将微信表情整理并导出到本地"
                      action={<Typography variant="body2">v{APP_VERSION}</Typography>}
                    />
                    <Divider />
                    <SettingsRow
                      title="StickerHub"
                      description={
                        <>
                          微信表情专辑资源与{' '}
                          <Link
                            component="button"
                            type="button"
                            underline="hover"
                            onClick={() => void openStickerHub()}
                            sx={{
                              p: 0,
                              border: 0,
                              bgcolor: 'transparent',
                              color: 'primary.main',
                              font: 'inherit',
                              fontWeight: 650,
                              cursor: 'pointer'
                            }}
                          >
                            StickerHub API
                          </Link>
                        </>
                      }
                    />
                    <Divider />
                    <SettingsRow
                      title="开源项目"
                      description="欢迎通过 GitHub 反馈问题和建议"
                      action={
                        <Button
                          variant="outlined"
                          size="small"
                          startIcon={<OpenInNewOutlinedIcon />}
                          onClick={() =>
                            openSystem(GITHUB_REPOSITORY_URL).catch(() =>
                              showToastMessage('无法打开 GitHub', 'warning')
                            )
                          }
                        >
                          打开仓库
                        </Button>
                      }
                    />
                    <Divider />
                    <SettingsRow
                      title="开发者"
                      description={DEVELOPER_EMAIL}
                    />
                  </SettingsGroup>
                  <SettingsGroup title="数据与隐私">
                    <SettingsRow
                      title="本地处理"
                      description="账号识别、收藏读取和文件导出均在本机完成"
                    />
                    <Divider />
                    <SettingsRow
                      title="专辑表情包补全"
                      description={
                        <>
                          打开专辑时，由{' '}
                          <Link
                            component="button"
                            type="button"
                            underline="hover"
                            onClick={() => void openStickerHub()}
                            sx={{
                              p: 0,
                              border: 0,
                              bgcolor: 'transparent',
                              color: 'primary.main',
                              font: 'inherit',
                              fontWeight: 650,
                              cursor: 'pointer'
                            }}
                          >
                            StickerHub API
                          </Link>{' '}
                          提供图片服务。
                        </>
                      }
                    />
                  </SettingsGroup>
                  <SettingsGroup title="兼容性">
                    <SettingsRow
                      title="微信 4.x"
                      description="支持个人收藏、表情专辑和完整导出"
                    />
                    <Divider />
                    <SettingsRow
                      title="旧版微信"
                      description="仅支持个人收藏；不支持的功能不会影响应用使用"
                    />
                  </SettingsGroup>
                </Stack>
              </Box>
            ) : null}
          </Box>
        </Box>

        {/* Floating Progress Bar */}
        {isExporting && (
          <Box
            sx={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              bgcolor: alpha('#FFFFFF', 0.96),
              backdropFilter: 'blur(12px)',
              p: 1.5,
              borderTop: '1px solid',
              borderColor: 'divider',
              zIndex: 100
            }}
          >
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ mb: 0.5 }}
            >
              <Typography
                variant="caption"
                sx={{ fontWeight: 600, color: 'primary.main' }}
              >
                正在导出 {exportProgress} / {showImgList.length}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                成功 {exportOk} · 跳过 {exportSkipped} · 失败 {exportFailed}
              </Typography>
            </Stack>
            <LinearProgress
              variant="determinate"
              value={(exportProgress / showImgList.length) * 100}
              sx={{ height: 3, borderRadius: 0 }}
            />
          </Box>
        )}
      </Box>

      {/* Export Settings Menu */}
      <Menu
        anchorEl={settingsAnchorEl}
        open={openSettings}
        onClose={() => setSettingsAnchorEl(null)}
        PaperProps={{
          sx: {
            width: 292,
            mt: 0.75,
            border: '1px solid',
            borderColor: 'divider',
            boxShadow: '0 10px 28px rgba(23, 25, 28, 0.14)'
          }
        }}
        transformOrigin={{ horizontal: 'right', vertical: 'top' }}
        anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
      >
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2" sx={{ mb: 1.25, fontWeight: 700 }}>
            导出设置
          </Typography>

          <Typography
            variant="caption"
            sx={{
              color: 'text.secondary',
              fontWeight: 600,
              display: 'block',
              mb: 1
            }}
          >
            分组方式
          </Typography>
          <RadioGroup
            value={exportGroupMode}
            onChange={(e) => setExportGroupMode(e.target.value as any)}
            sx={{ mb: 2 }}
          >
            <FormControlLabel
              value="recommended"
              control={<Radio size="small" />}
              label={<Typography variant="body2">每 50 个分为一组</Typography>}
            />
            <FormControlLabel
              value="none"
              control={<Radio size="small" />}
              label={<Typography variant="body2">不分组</Typography>}
            />
            <FormControlLabel
              value="custom"
              control={<Radio size="small" />}
              label={<Typography variant="body2">自定义分组</Typography>}
            />
          </RadioGroup>

          {exportGroupMode === 'custom' && (
            <TextField
              fullWidth
              size="small"
              type="number"
              label="每组数量"
              value={exportCustomGroupSize}
              onChange={(e) => setExportCustomGroupSize(Number(e.target.value))}
              sx={{ mb: 2 }}
            />
          )}

          <Divider sx={{ my: 1.5 }} />

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={exportResume}
                onChange={(e) => setExportResume(e.target.checked)}
              />
            }
            label={<Typography variant="body2">断点续跑</Typography>}
            sx={{ mb: 0.5, display: 'flex' }}
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={exportAutoOpen}
                onChange={(e) => setExportAutoOpen(e.target.checked)}
              />
            }
            label={<Typography variant="body2">完成后打开文件夹</Typography>}
            sx={{ display: 'flex' }}
          />
        </Box>
      </Menu>

      {/* Dialogs and Snackbars */}
      <Dialog
        open={!!exportResult}
        onClose={() => setExportResult(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 1 }}>
          {exportResult?.canceled ? '导出已取消' : '导出完成'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography variant="body2">
              文件已保存到“下载/{exportResult?.dirName}”
            </Typography>
            <Box
              sx={{
                border: '1px solid',
                borderColor: 'divider',
                p: 1.5,
                borderRadius: 1
              }}
            >
              <Stack direction="row" divider={<Divider orientation="vertical" flexItem />}>
                <Box textAlign="center" sx={{ flex: 1 }}>
                  <Typography variant="h6" color="primary.main">
                    {exportResult?.ok}
                  </Typography>
                  <Typography variant="caption">成功</Typography>
                </Box>
                <Box textAlign="center" sx={{ flex: 1 }}>
                  <Typography variant="h6" color="text.secondary">
                    {exportResult?.skipped}
                  </Typography>
                  <Typography variant="caption">跳过</Typography>
                </Box>
                <Box textAlign="center" sx={{ flex: 1 }}>
                  <Typography variant="h6" color="error.main">
                    {exportResult?.failed}
                  </Typography>
                  <Typography variant="caption">失败</Typography>
                </Box>
              </Stack>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExportResult(null)}>关闭</Button>
          <Button
            variant="contained"
            onClick={() => {
              if (exportResult) {
                openExportDir(downloadDirPath, exportResult.dirName).catch(
                  () => {}
                )
                setExportResult(null)
              }
            }}
          >
            打开文件夹
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={githubFeedbackOpen}
        onClose={() => setGithubFeedbackOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>确认通过 GitHub 反馈</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              下一步会打开浏览器中的 GitHub 新建页面。你需要登录 GitHub 并手动点击提交，客户端不会自动提交。
            </Typography>
            <Typography variant="body2" color="text.secondary">
              专辑表情包由{' '}
              <Link
                component="button"
                type="button"
                underline="hover"
                onClick={() => void openStickerHub()}
                sx={{
                  p: 0,
                  border: 0,
                  bgcolor: 'transparent',
                  color: 'primary.main',
                  font: 'inherit',
                  fontWeight: 650,
                  cursor: 'pointer'
                }}
              >
                StickerHub API
              </Link>{' '}
              提供支持。
            </Typography>
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Stack spacing={1.25}>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    专辑名称
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 650 }}>
                    {currentAlbum?.name}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    专辑成员
                  </Typography>
                  <Typography variant="body2">
                    {currentAlbum?.count ?? 0} 个
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    专辑 ID
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{ wordBreak: 'break-all', fontFamily: 'monospace' }}
                  >
                    {currentAlbum?.packageId || currentAlbum?.id}
                  </Typography>
                  <Button
                    size="small"
                    startIcon={<ContentCopyOutlinedIcon />}
                    onClick={() =>
                      copyToClipboard(
                        currentAlbum?.packageId || currentAlbum?.id || '',
                        '专辑 ID 已复制，可用于联系开发者'
                      )
                    }
                    sx={{ mt: 0.5, px: 0 }}
                  >
                    复制专辑 ID
                  </Button>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block' }}
                  >
                    用于手动反馈或联系开发者
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mt: 0.25 }}
                  >
                    开发者邮箱：{DEVELOPER_EMAIL}
                  </Typography>
                </Box>
              </Stack>
            </Paper>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setGithubFeedbackOpen(false)}>取消</Button>
          <Button
            variant="contained"
            startIcon={<OpenInNewOutlinedIcon />}
            onClick={confirmMissingAlbumIssue}
          >
            打开 GitHub
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={emailFeedbackOpen}
        onClose={closeMissingAlbumEmail}
        disableEscapeKeyDown={emailFeedbackSending}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>邮件反馈</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography variant="body2">
              我们会把这个专辑的信息发送给开发者，用于补充收录。
            </Typography>
            <Typography variant="body2" color="text.secondary">
              反馈会发送至开发者邮箱：{DEVELOPER_EMAIL}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              留下邮箱后，开发者补录完成时可以通过这个邮箱联系你（可选）。
            </Typography>
            <Typography variant="caption" color="text.secondary">
              你填写的邮箱会写入反馈邮件，并作为回复地址；如果不填写，补录完成后无法通过邮件联系你。
            </Typography>
            <TextField
              autoFocus
              fullWidth
              type="email"
              label="接收补录通知的邮箱（可选）"
              value={feedbackContactEmail}
              onChange={(event) => {
                setFeedbackContactEmail(event.target.value)
                if (feedbackContactEmailError) {
                  setFeedbackContactEmailError('')
                }
              }}
              error={Boolean(feedbackContactEmailError)}
              helperText={
                feedbackContactEmailError ||
                '邮箱仅用于本次反馈和后续通知，不会公开。'
              }
              autoComplete="email"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeMissingAlbumEmail} disabled={emailFeedbackSending}>
            取消
          </Button>
          <Button
            variant="contained"
            startIcon={<EmailOutlinedIcon />}
            onClick={sendMissingAlbumEmail}
            disabled={emailFeedbackSending}
          >
            {emailFeedbackSending ? '发送中…' : '发送反馈'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={confirmClearCacheOpen}
        onClose={() => setConfirmClearCacheOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>清除当前账号缓存？</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            清除后需要重新读取表情。已导出的文件不会受到影响。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmClearCacheOpen(false)}>取消</Button>
          <Button
            color="warning"
            variant="contained"
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
          variant="filled"
          sx={{ width: '100%' }}
        >
          {toast.message}
        </Alert>
      </Snackbar>
    </Box>
  )
}

export default App
