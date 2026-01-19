import type { IMaybeUrl, ISelectOption } from './types'
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
import { downloadDir } from '@tauri-apps/api/path'
import { useRef, useState } from 'react'
import { PhotoProvider, PhotoView } from 'react-photo-view'
import { text } from './consts/text'
import { buildEmojiItems, extractFavUrls } from './services/archive'
import { fetchBinaryWithFallback } from './services/downloader'
import {
  ensureExportRootDir,
  exportOneEmoji,
  openExportDir,
  writeUsageReadme
} from './services/exporter'
import {
  extFromContentType,
  extFromUrl,
  getStodownloadCandidates
} from './services/stodownload'
import {
  DEFAULT_WECHAT_DIR_PATH,
  favArchivePath,
  findStickerTargetDirs
} from './services/wechat'
import { sleep } from './utils/timer'
import './App.css'

function App() {
  // weChat 目录路径
  const weChatDirPath = DEFAULT_WECHAT_DIR_PATH
  // wxapp 域名
  const wxappDomain = 'wxapp.tc.qq.com'
  // vweixinf 域名
  const vweixinfDomain = 'vweixinf.tc.qq.com'
  // 下载图片的列表
  const [downloadImgList, setDownloadImgList] = useState<Array<IMaybeUrl>>([])
  // 页面展示图片的列表
  const [showImgList, setShowImgList] = useState<Array<IMaybeUrl>>([])
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
  const createdSubDirsRef = useRef<Set<number>>(new Set())

  async function getFsPermission() {
    setLoadError(null)
    setDownloadDirPath(await downloadDir())

    const targetDirs = await findStickerTargetDirs(weChatDirPath)

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

    let rawUrls: Array<string> = []
    try {
      rawUrls = await extractFavUrls(favArchivePath(weChatDirPath, dirName))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setLoadError(msg || '解析 fav.archive 失败')
      setShowImgList([])
      setDownloadImgList([])
      return
    }
    const urls = buildEmojiItems(rawUrls, { wxappDomain, vweixinfDomain })

    // 展示图片的列表
    setShowImgList(urls)
    // 下载图片的列表
    setDownloadImgList(urls.slice().reverse())
  }

  async function parseWeChatArchive() {
    setIsExporting(true)
    setExportProgress(0)
    setCancelRequested(false)
    cancelExportRef.current = false
    createdSubDirsRef.current = new Set()

    await ensureExportRootDir(customEmotionsDirName)
    setHasEmotionsDir(true)
    await writeUsageReadme(customEmotionsDirName, text)

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
        const result = await fetchBinaryWithFallback(src)
        if (cancelExportRef.current) {
          break
        }
        setExportProgress(i + 1)
        if (result.ok) {
          const ext =
            extFromContentType(result.contentType) ||
            extFromUrl(result.usedUrl) ||
            'gif'
          await exportOneEmoji({
            customEmotionsDirName,
            groupSize: 50,
            createdSubDirs: createdSubDirsRef.current,
            index: i,
            usedUrl: result.usedUrl,
            buffer: result.buffer,
            ext
          })
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
    openExportDir(downloadDirPath, customEmotionsDirName)
  }

  function cancelExport() {
    cancelExportRef.current = true
    setCancelRequested(true)
  }

  async function openDir() {
    await openExportDir(downloadDirPath, customEmotionsDirName)
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
