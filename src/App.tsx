import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import FormControl from '@mui/material/FormControl'
import ImageList from '@mui/material/ImageList'
import ImageListItem from '@mui/material/ImageListItem'
import InputLabel from '@mui/material/InputLabel'
import LinearProgress from '@mui/material/LinearProgress'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select, { type SelectChangeEvent } from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { message } from '@tauri-apps/api/dialog'
import {
  readDir,
  exists,
  createDir,
  writeBinaryFile,
  writeTextFile,
  BaseDirectory
} from '@tauri-apps/api/fs'
import { getClient, ResponseType } from '@tauri-apps/api/http'
import { downloadDir } from '@tauri-apps/api/path'
import { Command } from '@tauri-apps/api/shell'
import { invoke } from '@tauri-apps/api/tauri'
import { useRef, useState } from 'react'
import { PhotoProvider, PhotoView } from 'react-photo-view'
import { text } from './consts/text'
import { sleep } from './utils/timer'
import { getUrlParam } from './utils/url'
import './App.css'

interface IMaybeUrl {
  _text: string
  src: string
  fallbackIndex?: number
}

interface ISelectOption {
  label: string
  value: string
}

function App() {
  // weChat 目录路径
  const weChatDirPath =
    'Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9'
  // wxapp 域名
  const wxappDomain = 'wxapp.tc.qq.com'
  // vweixinf 域名
  const vweixinfDomain = 'vweixinf.tc.qq.com'
  // 下载图片的列表
  const [downloadImgList, setDownloadImgList] = useState<Array<IMaybeUrl>>([])
  // 页面展示图片的列表
  const [showImgList, setShowImgList] = useState<Array<IMaybeUrl>>([])
  // 下载的子目录集合
  const [downloadSubDirs, setDownloadSubDirs] = useState<Array<number>>([])
  // 导出进度数
  const [exportProgress, setExportProgress] = useState(0)
  // 是否创建表情包存储目录
  const [hasEmotionsDir, setHasEmotionsDir] = useState(false)
  // 是否正在导出
  const [isExporting, setIsExporting] = useState(false)
  // download 目录路径
  const [downloadDirPath, setDownloadDirPath] = useState('')
  // 自定义表情包的目录名 - 用于最终存储
  const [customEmotionsDirName, setCustomEmotionsDirName] = useState('')
  // 目标目录名称集合
  const [targetDirNames, setTargetDirNames] = useState<Array<ISelectOption>>([])
  // 选择的表情包文件夹
  const [selectedTargetDir, setSelectedTargetDir] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const cancelExportRef = useRef(false)
  const [cancelRequested, setCancelRequested] = useState(false)

  function getStodownloadCandidates(url: string): Array<string> {
    // WeChat sticker URLs are often `.../stodownload?...`. Some resources require a correct
    // suffix (jpg/gif/png/webp) to be served/rendered, so we try multiple variants.
    const exts = ['gif', 'jpg', 'png', 'webp'] as const

    const hasStodownload = url.includes('/stodownload')
    if (!hasStodownload) {
      return [url]
    }

    const replaceExt = (ext: (typeof exts)[number]) =>
      url.replace(/\/stodownload(?:\.[a-z0-9]+)?\?/i, `/stodownload.${ext}?`)

    const candidates = [url, ...exts.map(replaceExt)]
    // De-dupe while preserving order.
    return Array.from(new Set(candidates))
  }

  function extFromContentType(contentType: string | undefined): string | null {
    if (!contentType) {
      return null
    }
    const ct = contentType.toLowerCase()
    if (ct.includes('image/gif')) {
      return 'gif'
    }
    if (ct.includes('image/png')) {
      return 'png'
    }
    if (ct.includes('image/webp')) {
      return 'webp'
    }
    if (ct.includes('image/jpeg') || ct.includes('image/jpg')) {
      return 'jpg'
    }
    return null
  }

  function extFromUrl(url: string): string | null {
    const m = url.match(/\/stodownload\.([a-z0-9]+)\?/i)
    return m?.[1]?.toLowerCase() || null
  }

  async function getFsPermission() {
    setLoadError(null)
    setDownloadDirPath(await downloadDir())

    // weChat 目录下的文件夹
    const weChatDirs = await readDir(weChatDirPath, {
      dir: BaseDirectory.Home,
      recursive: false
    })
    // 过滤非 32 位长度的文件夹，即可能是目标文件夹
    const maybeTargetDirs = weChatDirs.filter((dir) => {
      return dir?.name?.length === 32
    })

    // 符合条件的表情包文件夹
    const targetDirs: Array<string> = []
    // 找到存有 fav.archive 文件夹
    for (let i = 0; i < maybeTargetDirs.length; i++) {
      const file = maybeTargetDirs[i]
      const stickerFile = `${weChatDirPath}/${file.name}/Stickers/fav.archive`
      // 判定该文件夹是否存在 fav.archive 文件
      const stickerExists = await exists(stickerFile, {
        dir: BaseDirectory.Home
      })
      // 找到目标文件夹 - 目录名
      if (stickerExists && file.name) {
        targetDirs.push(file.name)
      }
    }

    if (!targetDirs.length) {
      return await message('没找到表情包存储目录，要不换个电脑吧🧐', {
        title: '骚瑞',
        type: 'error'
      })
    }
    targetDirs.unshift('')
    setTargetDirNames(
      targetDirs.map((name) => {
        return {
          label: name || '请选择',
          value: name
        }
      })
    )
  }

  async function selectChange(e: SelectChangeEvent<string>) {
    const dirName = e.target.value || ''

    setCustomEmotionsDirName(`微信表情包_导出_${dirName}`)
    setSelectedTargetDir(dirName)
    setLoadError(null)

    const stickersPath = `${weChatDirPath}/${dirName}/Stickers`
    const favArchivePath = `${stickersPath}/fav.archive`

    let rawUrls: Array<string> = []
    try {
      rawUrls = await invoke<Array<string>>('extract_fav_urls', {
        favArchivePath
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setLoadError(msg || '解析 fav.archive 失败')
      setShowImgList([])
      setDownloadImgList([])
      return
    }
    const urls = rawUrls
      .filter((url) => {
        return String(url).match(/http[s]?:\/\/[^\s]+/)
      })
      .map((url) => {
        let src = url
        /**
         * 微信有几种域名的表情包
         * - wxapp.tc.qq.com
         * - vweixinf.tc.qq.com
         * - mmbiz.qpic.cn
         * - snsvideo.c2c.wechat.com - 无法访问了
         */

        // src 是 http 开头的全部替换为 https
        if (src.startsWith('http://')) {
          src = src.replace('http://', 'https://')
        }

        if (src.includes(wxappDomain)) {
          src = src.replace(`http://${wxappDomain}`, `https://${wxappDomain}`)
        }
        if (src.includes(vweixinfDomain)) {
          // 判断 src 是否为 https
          if (src.startsWith('https://')) {
            src = src.replace(
              `https://${vweixinfDomain}`,
              `https://${wxappDomain}`
            )
          } else {
            src = src.replace(
              `http://${vweixinfDomain}`,
              `https://${wxappDomain}`
            )
          }
        }

        return {
          _text: src,
          src,
          fallbackIndex: 0
        }
      })

    // 展示图片的列表
    setShowImgList(urls)
    // 下载图片的列表
    setDownloadImgList(urls.slice().reverse())
  }

  async function fetchImg(
    src: string
  ): Promise<
    | { ok: true; buffer: ArrayBuffer; usedUrl: string; contentType?: string }
    | { ok: false; error: unknown }
  > {
    const client = await getClient()
    const candidates = getStodownloadCandidates(src)

    for (const url of candidates) {
      try {
        const res = await client.get(url, { responseType: ResponseType.Binary })
        const buffer = res.data as ArrayBuffer
        // Tauri v1 returns `headers` as a Record<string, string>.
        const contentType =
          (res as unknown as { headers?: Record<string, string> }).headers?.[
            'content-type'
          ] ||
          (res as unknown as { headers?: Record<string, string> }).headers?.[
            'Content-Type'
          ]
        return { ok: true, buffer, usedUrl: url, contentType }
      } catch (err) {
        // Try next candidate.
      }
    }

    return { ok: false, error: new Error('download failed for all candidates') }
  }

  async function parseWeChatArchive() {
    setIsExporting(true)
    setExportProgress(0)
    setCancelRequested(false)
    cancelExportRef.current = false

    await createEmotionsDir()
    await createReadme()

    try {
      // 获取 img 的 Uint8Array
      for (let i = 0; i < downloadImgList.length; i++) {
        if (cancelExportRef.current) {
          break
        }
        // TODO: 限制下载数量 测试用
        // if (i > 10) {
        //   break
        // }

        const { _text: src } = downloadImgList[i]
        const result = await fetchImg(src)
        if (cancelExportRef.current) {
          break
        }
        setExportProgress(i + 1)
        if (result.ok) {
          const ext =
            extFromContentType(result.contentType) ||
            extFromUrl(result.usedUrl) ||
            'gif'
          await handleExport(result.usedUrl, i, result.buffer, ext)
          await sleep(100)
        }
      }
    } finally {
      setIsExporting(false)
      setCancelRequested(false)
    }

    if (cancelExportRef.current) {
      setExportProgress(0)
      return
    }

    // await message('完成咯～')
    await sleep(1500)
    setExportProgress(0)
    openDir()
  }

  function cancelExport() {
    cancelExportRef.current = true
    setCancelRequested(true)
  }

  // 创建表情包目录
  const createEmotionsDir = async () => {
    await createDir(customEmotionsDirName, {
      dir: BaseDirectory.Download,
      recursive: true
    })
    setHasEmotionsDir(true)
    return
  }

  // 创建说明文档
  const createReadme = async () => {
    return await writeTextFile(`${customEmotionsDirName}/使用说明.txt`, text, {
      dir: BaseDirectory.Download
    })
  }

  const handleDownload = async (
    dirPath: string,
    usedUrl: string,
    imgBuffer: ArrayBuffer,
    ext: string
  ) => {
    const fileKey = getUrlParam(usedUrl, 'm')
    return await writeBinaryFile(
      `${dirPath}/${fileKey}.${ext}`,
      new Uint8Array(imgBuffer),
      { dir: BaseDirectory.Download }
    )
  }

  // 导出图片 - 50 个为一个目录
  async function handleExport(
    usedUrl: string,
    i: number,
    imgBuffer: ArrayBuffer,
    ext: string
  ) {
    const subDirNumber = Math.floor(i / 50)
    const subDirPath = `${customEmotionsDirName}/${subDirNumber * 50 + 1}_${(subDirNumber + 1) * 50}_组`
    if (downloadSubDirs.includes(subDirNumber)) {
      await handleDownload(subDirPath, usedUrl, imgBuffer, ext)
    } else {
      setDownloadSubDirs([...downloadSubDirs, subDirNumber])
      await createDir(subDirPath, {
        dir: BaseDirectory.Download,
        recursive: true
      })
      await handleDownload(subDirPath, usedUrl, imgBuffer, ext)
    }
  }

  // 打开下载目录
  async function openDir() {
    const path = `${downloadDirPath}${customEmotionsDirName}`
    await new Command('open-dir', [path]).execute()
    // await new Command('open-dir', [downloadDirPath]).execute()
  }

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Stack spacing={2.5} alignItems="stretch">
        <Typography variant="h5" align="center" sx={{ fontWeight: 700 }}>
          导出微信表情包
        </Typography>

        <Paper variant="outlined" sx={{ p: 2.5 }}>
          <Stack spacing={2}>
            <Button
              size="large"
              variant="contained"
              onClick={getFsPermission}
              disabled={isExporting}
            >
              查找微信表情包
            </Button>

            {targetDirNames.length > 0 && (
              <Stack spacing={1.5}>
                <FormControl fullWidth size="small">
                  <InputLabel id="target-dir-label">选择目标文件夹</InputLabel>
                  <Select
                    labelId="target-dir-label"
                    label="选择目标文件夹"
                    value={selectedTargetDir}
                    onChange={selectChange}
                    disabled={isExporting}
                  >
                    {targetDirNames.map((item) => (
                      <MenuItem
                        key={item.value || '__empty__'}
                        value={item.value}
                      >
                        {item.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                <Alert severity="info">
                  我也不晓得哪个目录下的表情包是你的，自己选一个然后导出吧
                </Alert>

                {loadError && <Alert severity="error">{loadError}</Alert>}

                <Stack direction="row" spacing={1.5} justifyContent="center">
                  <Button
                    variant="outlined"
                    onClick={parseWeChatArchive}
                    disabled={
                      !selectedTargetDir ||
                      isExporting ||
                      cancelRequested ||
                      !downloadImgList.length
                    }
                  >
                    导出
                  </Button>
                  <Button
                    color="warning"
                    variant="outlined"
                    onClick={cancelExport}
                    disabled={!isExporting || cancelRequested}
                  >
                    {cancelRequested ? '正在取消…' : '取消导出'}
                  </Button>
                  <Button
                    variant="text"
                    onClick={openDir}
                    disabled={
                      !downloadDirPath ||
                      !customEmotionsDirName ||
                      !hasEmotionsDir ||
                      isExporting ||
                      cancelRequested
                    }
                  >
                    打开下载目录
                  </Button>
                </Stack>

                {(isExporting || exportProgress > 0) && (
                  <Box>
                    <Typography variant="body2" sx={{ mb: 0.75 }}>
                      导出进度：{exportProgress}/{downloadImgList.length}
                    </Typography>
                    <LinearProgress
                      variant="determinate"
                      value={
                        downloadImgList.length
                          ? (exportProgress / downloadImgList.length) * 100
                          : 0
                      }
                    />
                  </Box>
                )}
              </Stack>
            )}
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2.5 }}>
          <Stack spacing={1.5}>
            {showImgList.length ? (
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                {showImgList.length} 个表情包预览
                {showImgList.length > 30 ? `（仅显示前 30 个）` : ''}
              </Typography>
            ) : (
              <Typography variant="body1" color="text.secondary">
                {selectedTargetDir
                  ? '啥也没有'
                  : '先点击「查找微信表情包」，再选择目标文件夹'}
              </Typography>
            )}

            {!!showImgList.length && (
              <Box className="img-list">
                <ImageList cols={5} gap={8}>
                  <PhotoProvider>
                    {showImgList.slice(0, 30).map((item, index) => (
                      <ImageListItem key={item.src}>
                        <div className="img-preview">
                          <PhotoView key={index} src={item.src}>
                            <img
                              src={item.src}
                              loading="lazy"
                              alt=""
                              onError={() => {
                                const candidates = getStodownloadCandidates(
                                  item._text
                                )
                                const nextIndex = (item.fallbackIndex ?? 0) + 1
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
                      </ImageListItem>
                    ))}
                  </PhotoProvider>
                </ImageList>
              </Box>
            )}
          </Stack>
        </Paper>
      </Stack>
    </Container>
  )
}

export default App
