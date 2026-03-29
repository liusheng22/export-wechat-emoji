import type { IMaybeUrl } from './types'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
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
import TextField from '@mui/material/TextField'
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
import { fetchBinaryWithFallback } from './services/downloader'
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
  extFromUrl,
  getStodownloadCandidates
} from './services/stodownload'
import {
  checkWeChatRunning,
  diagnoseWeChatEnvironment,
  type WeChatEnvironmentDiag
} from './services/system'
import {
  encodeEmojiTarget,
  findEmojiTargetsWithMeta,
  type EmojiTargetMeta
} from './services/wechat'
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

type IncompleteExport = {
  dirName: string
  groupSize: number
}

type ToastState = {
  open: boolean
  message: string
  severity: 'success' | 'info' | 'warning' | 'error'
}

function App() {
  // wxapp 域名
  const wxappDomain = 'wxapp.tc.qq.com'
  // vweixinf 域名
  const vweixinfDomain = 'vweixinf.tc.qq.com'
  const [targets, setTargets] = useState<Array<EmojiTargetMeta>>([])
  const [targetsLoading, setTargetsLoading] = useState(false)
  const [targetsError, setTargetsError] = useState<string | null>(null)
  const [selectedTargetValue, setSelectedTargetValue] = useState('')

  // 预览/下载数据（来源统一为 URL 列表，但对用户隐藏）
  const [rawUrls, setRawUrls] = useState<Array<string>>([])
  const [showImgList, setShowImgList] = useState<Array<IMaybeUrl>>([])
  const [previewPage, setPreviewPage] = useState(1)
  const previewPageSize = 50

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
  const [confirmClearCacheOpen, setConfirmClearCacheOpen] = useState(false)

  const [showAdvanced, setShowAdvanced] = useState(false)
  const [wechatAppPath, setWechatAppPath] = useState('/Applications/WeChat.app')
  const cancelExportRef = useRef(false)
  const createdSubDirsRef = useRef<Set<number>>(new Set())
  const activeFlowWxidRef = useRef<string | null>(null)
  const flowActiveRef = useRef(false)

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

  const lastUpdatedText = useMemo(() => {
    const ms = selectedTargetMeta?.mtimeMs
    if (!ms) {
      return ''
    }
    const d = new Date(ms)
    return d.toLocaleString('zh-CN', { hour12: false })
  }, [selectedTargetMeta?.mtimeMs])

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

    return `无法读取微信数据目录：${unreadable.path}。请确认微信已登录；如果微信已登录但仍失败，请在系统设置中为本应用开启“完全磁盘访问权限”后重试。${
      unreadable.error ? `（${unreadable.error}）` : ''
    }`
  }

  async function refreshTargets() {
    setTargetsLoading(true)
    setTargetsError(null)
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
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setTargetsError(msg || '扫描账号失败')
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
  }, [])

  useEffect(() => {
    if (!wechatAppPath) {
      return
    }
    localStorage.setItem('wxemoticon_wechat_app_path', wechatAppPath)
  }, [wechatAppPath])

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

  async function selectChange(e: SelectChangeEvent<string>) {
    const value = e.target.value || ''
    setSelectedTargetValue(value)
    setShowImgList([])
    setRawUrls([])
    setPreviewPage(1)
    setFlowError(null)
    setFlowStage('idle')
    setFlowHint('')
    setWechatMustQuit(false)
    setWeChatRunningMatches([])
    setLastDumpResult(null)
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
      showToastMessage('旧版微信导出不涉及 db key，无需清除缓存', 'info')
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
        const tip =
          buildWeChatAccessHint(diag) ||
          '未检测到微信表情包数据。请确认已安装并登录微信；如果微信已登录但仍为空，请点击“刷新”，并在系统设置中为本应用开启“完全磁盘访问权限”后重试。'
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

    setFlowError(null)
    setFlowHint('')
    setWechatMustQuit(false)
    setWeChatRunningMatches([])
    setShowImgList([])
    setRawUrls([])
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
        setRawUrls(urls)
        setShowImgList(buildEmojiItems(urls, { wxappDomain, vweixinfDomain }))
        setFlowStage('ready')
        setFlowHint('')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setFlowError(msg || '解析失败')
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setFlowError(msg || '检查微信进程失败')
        setFlowStage('error')
        setFlowHint('')
        showToastMessage(msg || '检查微信进程失败', 'error')
        return
      }
    }

    // Ensure WeChat.app exists (otherwise the injector cannot run).
    try {
      const ok = await fsExists(wechatAppPath)
      if (!ok) {
        const tip =
          '未找到 WeChat.app。请在「高级选项」里选择正确的 WeChat.app 路径后重试。'
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
        ? '检测到缓存 key，正在离线解析…'
        : '正在准备微信副本并获取表情数据…（如弹出微信，请登录并打开一次表情面板）'
    )
    flowActiveRef.current = true
    activeFlowWxidRef.current = target.wxidDir
    try {
      const result = await autoDumpEmoticonUrlsV4(target.wxidDir, wechatAppPath)
      setLastDumpResult(result)
      const urls = result.urls || []
      if (!urls.length) {
        throw new Error('没有解析到任何表情包链接')
      }
      setRawUrls(urls)
      setShowImgList(buildEmojiItems(urls, { wxappDomain, vweixinfDomain }))
      setPreviewPage(1)
      setFlowStage('ready')
      setFlowHint('')
      flowActiveRef.current = false
    } catch (err) {
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
          ? '未找到 WeChat.app：请在「高级选项」里选择正确的 WeChat.app 路径后重试。'
          : text

      setFlowError(friendly)
      setFlowStage('error')
      setFlowHint('')
      showToastMessage(friendly || '自动导出失败', 'error')
    }
  }

  async function runExport(options: {
    dirName: string
    groupSize: number
    resumeExisting: boolean
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

    const items = buildEmojiItems(rawUrls, { wxappDomain, vweixinfDomain })
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
      await writeUrlsFile(options.dirName, rawUrls)
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
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Stack spacing={2.5} alignItems="stretch">
        <Typography variant="h5" align="center" sx={{ fontWeight: 700 }}>
          导出微信表情包
        </Typography>

        <Paper variant="outlined" sx={{ p: 2.5 }}>
          <Stack spacing={2}>
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                <Typography variant="body1" sx={{ fontWeight: 700 }}>
                  账号
                </Typography>
                {targetsLoading && <CircularProgress size={18} />}
                <Button
                  variant="text"
                  onClick={refreshTargets}
                  disabled={targetsLoading || isExporting}
                >
                  刷新
                </Button>
              </Stack>

              {targetsError && <Alert severity="error">{targetsError}</Alert>}

              {!targetsLoading && !targets.length && !targetsError && (
                <Alert severity="warning">
                  没找到微信表情包数据（旧版 fav.archive / 新版 emoticon.db）。
                  请确认已安装并登录微信；如果微信已登录但仍为空，请点击「刷新」，并在系统设置中为本应用开启“完全磁盘访问权限”后重试。
                </Alert>
              )}

              {targets.length === 1 && (
                <TextField
                  label="已检测到 1 个账号"
                  size="small"
                  value={buildTargetLabel(targets[0])}
                  disabled
                  fullWidth
                />
              )}

              {targets.length > 1 && (
                <FormControl fullWidth size="small">
                  <InputLabel id="target-select">选择账号</InputLabel>
                  <Select
                    labelId="target-select"
                    label="选择账号"
                    value={selectedTargetValue}
                    onChange={selectChange}
                    disabled={isExporting || targetsLoading}
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

              {selectedTargetMeta?.kind === 'v4' && lastUpdatedText && (
                <Alert severity="info">
                  该账号最后更新时间：{lastUpdatedText}
                </Alert>
              )}

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
                      onClick={loadPreview}
                      disabled={isExporting || targetsLoading}
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
                      <Button color="inherit" size="small" onClick={openLogDir}>
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
                  onClick={loadPreview}
                  disabled={isExporting || targetsLoading}
                >
                  一键获取并预览
                </Button>
                <Button
                  size="large"
                  variant="outlined"
                  onClick={startNewExport}
                  disabled={isExporting || cancelRequested || !rawUrls.length}
                >
                  开始导出
                </Button>
                {!!incompleteExport && !!rawUrls.length && (
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

              {(flowStage === 'checkingWechat' ||
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

              <Divider />
              <Stack spacing={1.25}>
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
                      setExportGroupMode(
                        e.target.value as 'recommended' | 'none' | 'custom'
                      )
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
                      setExportCustomGroupSize(Number(e.target.value))
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
                        onChange={(e) => setExportResume(e.target.checked)}
                        disabled={isExporting}
                      />
                    }
                    label="断点续跑（跳过已存在文件）"
                  />
                  <FormControlLabel
                    control={
                      <Switch
                        checked={exportAutoOpen}
                        onChange={(e) => setExportAutoOpen(e.target.checked)}
                        disabled={isExporting}
                      />
                    }
                    label="导出完成后自动打开目录"
                  />
                </Stack>

                <Typography variant="body2" color="text.secondary">
                  导出目录固定在「下载」目录下；每次导出都会创建一个新文件夹。
                </Typography>
              </Stack>

              {(isExporting || exportProgress > 0) && (
                <Box>
                  <Typography variant="body2" sx={{ mb: 0.75 }}>
                    导出进度：{exportProgress}/{rawUrls.length}（成功：
                    {exportOk}，跳过：{exportSkipped}，失败：{exportFailed}）
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

              <Button variant="text" onClick={() => setShowAdvanced((v) => !v)}>
                {showAdvanced ? '收起高级选项' : '展开高级选项'}
              </Button>

              {showAdvanced && (
                <Stack spacing={1.5}>
                  <Alert severity="info">
                    这里用于设置微信应用路径与查看调试产物。默认使用
                    /Applications/WeChat.app；如果你保留了官方备份（如
                    WeChat.bak.app），可在这里选择对应路径。
                  </Alert>

                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    WeChat.app 路径
                  </Typography>
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <TextField
                      label="WeChat.app 路径"
                      size="small"
                      value={wechatAppPath}
                      onChange={(e) => setWechatAppPath(e.target.value)}
                      disabled={isExporting}
                      fullWidth
                    />
                    <Button
                      variant="outlined"
                      onClick={chooseWeChatApp}
                      disabled={isExporting}
                    >
                      选择
                    </Button>
                  </Stack>

                  <Divider />
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    调试产物（当前账号）
                  </Typography>

                  {selectedTargetMeta?.kind !== 'v4' && (
                    <Typography variant="body2" color="text.secondary">
                      旧版微信导出无需 db key，此处没有相关产物。
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
                    缓存与历史
                  </Typography>

                  {!!lastExportDir && (
                    <Stack direction="row" spacing={1.25} alignItems="center">
                      <Typography variant="body2" color="text.secondary">
                        上次导出：{lastExportDir}
                      </Typography>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() =>
                          openExportDir(downloadDirPath, lastExportDir).catch(
                            () => {}
                          )
                        }
                      >
                        打开
                      </Button>
                    </Stack>
                  )}

                  {!!incompleteExport && (
                    <Stack direction="row" spacing={1.25} alignItems="center">
                      <Typography variant="body2" color="text.secondary">
                        上次未完成：{incompleteExport.dirName}
                      </Typography>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={continueLastExport}
                        disabled={isExporting || !rawUrls.length}
                      >
                        继续
                      </Button>
                    </Stack>
                  )}

                  <Button
                    color="warning"
                    variant="outlined"
                    onClick={() => setConfirmClearCacheOpen(true)}
                    disabled={isExporting || !selectedTargetMeta}
                  >
                    清除当前账号缓存
                  </Button>
                </Stack>
              )}
            </Stack>
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2.5 }}>
          <Stack spacing={1.5}>
            {showImgList.length ? (
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                {showImgList.length} 个表情包预览
              </Typography>
            ) : (
              <Typography variant="body1" color="text.secondary">
                {!targets.length
                  ? '暂未检测到微信账号；请确认微信已登录，然后点击「刷新」'
                  : selectedTargetValue
                    ? '暂无预览，请先点击「一键获取并预览」'
                    : '先选择账号，然后点击「一键获取并预览」'}
              </Typography>
            )}

            {!!showImgList.length && (
              <Box className="img-list">
                {Math.ceil(showImgList.length / previewPageSize) > 1 && (
                  <Stack
                    direction="row"
                    spacing={2}
                    alignItems="center"
                    justifyContent="space-between"
                    sx={{ mb: 1 }}
                  >
                    <Typography variant="body2" color="text.secondary">
                      第 {(previewPage - 1) * previewPageSize + 1}-
                      {Math.min(
                        previewPage * previewPageSize,
                        showImgList.length
                      )}{' '}
                      个 / 共 {showImgList.length} 个
                    </Typography>
                    <Pagination
                      count={Math.ceil(showImgList.length / previewPageSize)}
                      page={previewPage}
                      onChange={(_e, page) => setPreviewPage(page)}
                      disabled={isExporting}
                      size="small"
                    />
                  </Stack>
                )}
                <ImageList cols={5} gap={8} sx={{ width: '100%', m: 0 }}>
                  <PhotoProvider>
                    {showImgList
                      .slice(
                        (previewPage - 1) * previewPageSize,
                        previewPage * previewPageSize
                      )
                      .map((item, index) => (
                        <ImageListItem
                          key={`${item._text}_${index}`}
                          sx={{ minWidth: 0 }}
                        >
                          <Stack spacing={0.75}>
                            <div className="img-preview">
                              <PhotoView src={item.src}>
                                <img
                                  src={item.src}
                                  loading="lazy"
                                  alt=""
                                  onError={() => {
                                    const candidates = getStodownloadCandidates(
                                      item._text
                                    )
                                    const nextIndex =
                                      (item.fallbackIndex ?? 0) + 1
                                    if (nextIndex >= candidates.length) {
                                      return
                                    }

                                    setShowImgList((prev) =>
                                      prev.map((p) => {
                                        if (p._text !== item._text) {
                                          return p
                                        }
                                        return {
                                          ...p,
                                          src: candidates[nextIndex],
                                          fallbackIndex: nextIndex
                                        }
                                      })
                                    )
                                  }}
                                />
                              </PhotoView>
                            </div>

                            <Stack
                              direction="row"
                              spacing={0.75}
                              justifyContent="center"
                              alignItems="center"
                              sx={{ flexWrap: 'nowrap' }}
                            >
                              <Button
                                size="small"
                                variant="text"
                                onClick={() =>
                                  copyToClipboard(item._text, '已复制链接')
                                }
                                disabled={isExporting}
                                sx={{
                                  minWidth: 0,
                                  px: 0.75,
                                  whiteSpace: 'nowrap'
                                }}
                              >
                                复制链接
                              </Button>
                              <Button
                                size="small"
                                variant="text"
                                onClick={() => openSystem(item._text)}
                                disabled={isExporting}
                                sx={{
                                  minWidth: 0,
                                  px: 0.75,
                                  whiteSpace: 'nowrap'
                                }}
                              >
                                打开链接
                              </Button>
                            </Stack>
                          </Stack>
                        </ImageListItem>
                      ))}
                  </PhotoProvider>
                </ImageList>
              </Box>
            )}
          </Stack>
        </Paper>

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
