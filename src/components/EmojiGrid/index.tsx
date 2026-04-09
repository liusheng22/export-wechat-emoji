import type { IMaybeUrl } from '../../types'
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined'
import ImageNotSupportedOutlinedIcon from '@mui/icons-material/ImageNotSupportedOutlined'
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined'
import { Box, CircularProgress, IconButton, Tooltip } from '@mui/material'
import React, { useEffect, useRef, useState } from 'react'
import { PhotoProvider, PhotoView } from 'react-photo-view'
import {
  fetchBinaryWithFallback,
  type FetchBinaryResult
} from '../../services/downloader'
import {
  extFromBytes,
  extFromContentType,
  getBrowserPreviewSrc,
  shouldHydrateRemoteImage
} from '../../services/stodownload'
import { EmptyState } from '../MainContent/EmptyState'

const MAX_PREVIEW_HYDRATIONS = 6

function imageMimeFromResult(result: FetchBinaryResult): string | null {
  if (!result.ok) {
    return null
  }
  const ext =
    extFromBytes(result.buffer) || extFromContentType(result.contentType)
  if (!ext) {
    return null
  }
  return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
}

function previewIdentity(item: IMaybeUrl): string {
  return (
    item.md5 || item._text || item.downloadUrl || item.previewUrl || item.src
  )
}

function findPreviewIndex(
  items: IMaybeUrl[],
  target: IMaybeUrl,
  expectedSrc: string,
  preferredIndex: number
): number {
  const identity = previewIdentity(target)
  const matches = (item: IMaybeUrl | undefined) =>
    Boolean(
      item && item.src === expectedSrc && previewIdentity(item) === identity
    )

  if (matches(items[preferredIndex])) {
    return preferredIndex
  }
  return items.findIndex(matches)
}

interface EmojiGridProps {
  showImgList: IMaybeUrl[]
  previewPage: number
  previewPageSize: number
  copyToClipboard: (value: string, okMessage: string) => void
  openSystem: (target: string) => void
  setShowImgList: React.Dispatch<React.SetStateAction<IMaybeUrl[]>>
  emptyTitle?: string
  emptyDescription?: React.ReactNode
  emptyAction?: React.ReactNode
}

export const EmojiGrid: React.FC<EmojiGridProps> = ({
  showImgList,
  previewPage,
  previewPageSize,
  copyToClipboard,
  openSystem,
  setShowImgList,
  emptyTitle = '还没有可预览的表情',
  emptyDescription = '读取微信数据后，表情会显示在这里',
  emptyAction
}) => {
  const [failedPreviews, setFailedPreviews] = useState<Set<string>>(new Set())
  const [recoveringPreviews, setRecoveringPreviews] = useState<Set<string>>(
    new Set()
  )
  const [hydratingPreviews, setHydratingPreviews] = useState<Set<string>>(
    new Set()
  )
  const recoveringKeysRef = useRef<Set<string>>(new Set())
  const hydrationKeysRef = useRef<Set<string>>(new Set())
  const objectUrlsRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(true)
  const pageStart = (previewPage - 1) * previewPageSize
  const currentItems = showImgList.slice(
    pageStart,
    previewPage * previewPageSize
  )
  const previewDatasetKey = showImgList
    .map(
      (item) =>
        `${previewIdentity(item)}|${item.downloadUrl || ''}|${item.previewUrl || ''}`
    )
    .join('\u0001')

  useEffect(() => {
    setFailedPreviews(new Set())
  }, [previewDatasetKey])

  useEffect(() => {
    const activeSources = new Set(showImgList.map((item) => item.src))
    for (const objectUrl of objectUrlsRef.current) {
      if (!activeSources.has(objectUrl)) {
        URL.revokeObjectURL(objectUrl)
        objectUrlsRef.current.delete(objectUrl)
      }
    }
  }, [showImgList])

  useEffect(
    () => () => {
      mountedRef.current = false
      for (const objectUrl of objectUrlsRef.current) {
        URL.revokeObjectURL(objectUrl)
      }
      objectUrlsRef.current.clear()
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    const pending = currentItems.flatMap((item, index) => {
      if (item.src.startsWith('blob:') || !shouldHydrateRemoteImage(item.src)) {
        return []
      }

      return [
        {
          index,
          item,
          key: `${item.md5 || item._text}|${item.src}`,
          sources: Array.from(
            new Set(
              [item.src, item.downloadUrl, item.previewUrl].filter(
                (source): source is string => Boolean(source)
              )
            )
          )
        }
      ]
    })

    const hydrate = async (entry: (typeof pending)[number]) => {
      if (hydrationKeysRef.current.has(entry.key)) {
        return
      }

      hydrationKeysRef.current.add(entry.key)
      setHydratingPreviews((previous) => new Set(previous).add(entry.key))

      try {
        let result: FetchBinaryResult = {
          ok: false,
          error: new Error('preview failed')
        }
        for (const source of entry.sources) {
          try {
            result = await fetchBinaryWithFallback(source)
          } catch {
            result = { ok: false, error: new Error('preview failed') }
          }
          if (result.ok) {
            break
          }
        }

        if (!mountedRef.current) {
          return
        }

        const mime = imageMimeFromResult(result)
        if (mime) {
          const objectUrl = URL.createObjectURL(
            new Blob([result.ok ? result.buffer : new ArrayBuffer(0)], {
              type: mime
            })
          )
          objectUrlsRef.current.add(objectUrl)
          const globalIndex = pageStart + entry.index
          setShowImgList((previous) => {
            const targetIndex = findPreviewIndex(
              previous,
              entry.item,
              entry.item.src,
              globalIndex
            )
            if (targetIndex < 0) {
              URL.revokeObjectURL(objectUrl)
              objectUrlsRef.current.delete(objectUrl)
              return previous
            }
            const next = [...previous]
            next[targetIndex] = { ...next[targetIndex], src: objectUrl }
            return next
          })
        } else {
          setFailedPreviews((previous) => new Set(previous).add(entry.key))
        }
      } finally {
        hydrationKeysRef.current.delete(entry.key)
        if (mountedRef.current) {
          setHydratingPreviews((previous) => {
            const next = new Set(previous)
            next.delete(entry.key)
            return next
          })
        }
      }
    }

    const worker = async () => {
      while (!cancelled) {
        const entry = pending.shift()
        if (!entry) {
          return
        }
        await hydrate(entry)
      }
    }

    const workerCount = Math.min(MAX_PREVIEW_HYDRATIONS, pending.length)
    void Promise.all(Array.from({ length: workerCount }, () => worker()))

    return () => {
      cancelled = true
    }
  }, [pageStart, setShowImgList, showImgList])

  const handleImageError = async (index: number) => {
    const globalIndex = pageStart + index
    const item = showImgList[globalIndex]
    if (!item) {
      return
    }

    const previewKey = `${item.md5 || item._text}|${item.src}`
    if (item.src.startsWith('blob:')) {
      setFailedPreviews((previous) => new Set(previous).add(previewKey))
      return
    }
    if (recoveringKeysRef.current.has(previewKey)) {
      return
    }

    recoveringKeysRef.current.add(previewKey)
    setRecoveringPreviews((previous) => new Set(previous).add(previewKey))
    const fallbackSources = Array.from(
      new Set(
        [item.src, item.downloadUrl, item.previewUrl].filter(
          (source): source is string => Boolean(source)
        )
      )
    )
    let result: FetchBinaryResult = {
      ok: false,
      error: new Error('preview failed')
    }
    for (const source of fallbackSources) {
      try {
        result = await fetchBinaryWithFallback(source)
      } catch {
        result = { ok: false, error: new Error('preview failed') }
      }
      if (result.ok) {
        break
      }
    }
    if (result.ok) {
      const mime = imageMimeFromResult(result)

      if (mime) {
        const objectUrl = URL.createObjectURL(
          new Blob([result.buffer], { type: mime })
        )
        objectUrlsRef.current.add(objectUrl)
        setShowImgList((previous) => {
          const targetIndex = findPreviewIndex(
            previous,
            item,
            item.src,
            globalIndex
          )
          if (targetIndex < 0) {
            URL.revokeObjectURL(objectUrl)
            objectUrlsRef.current.delete(objectUrl)
            return previous
          }
          const next = [...previous]
          next[targetIndex] = { ...next[targetIndex], src: objectUrl }
          return next
        })
        setRecoveringPreviews((previous) => {
          const next = new Set(previous)
          next.delete(previewKey)
          return next
        })
        recoveringKeysRef.current.delete(previewKey)
        return
      }
    }

    setRecoveringPreviews((previous) => {
      const next = new Set(previous)
      next.delete(previewKey)
      return next
    })
    recoveringKeysRef.current.delete(previewKey)
    setFailedPreviews((previous) => new Set(previous).add(previewKey))
  }

  if (!showImgList.length) {
    return (
      <EmptyState
        icon={<ImageNotSupportedOutlinedIcon />}
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
      />
    )
  }

  return (
    <Box sx={{ pb: 3 }}>
      <PhotoProvider>
        <Box
          className="img-preview"
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
            gap: 1.25
          }}
        >
          {currentItems.map((item, index) => {
            const absoluteIndex = pageStart + index + 1
            const previewSrc = getBrowserPreviewSrc(item.src)
            const failedKey = `${item.md5 || item._text}|${item.src}`
            const previewFailed = failedPreviews.has(failedKey)
            const previewRecovering = recoveringPreviews.has(failedKey)
            const previewHydrating = hydratingPreviews.has(failedKey)
            const previewNeedsHydration =
              !item.src.startsWith('blob:') &&
              shouldHydrateRemoteImage(item.src)
            const previewLoading =
              previewRecovering ||
              previewHydrating ||
              (previewNeedsHydration && !previewFailed)
            return (
              <Box
                key={`${item.md5 || item._text}-${absoluteIndex}`}
                className="emoji-card"
                sx={{
                  minWidth: 0,
                  border: '1px solid #E1E4E7',
                  borderRadius: 1,
                  bgcolor: '#F7F8F9',
                  overflow: 'hidden',
                  transition: 'border-color 120ms ease, box-shadow 120ms ease',
                  '&:hover': {
                    borderColor: '#C7CDD1',
                    boxShadow: '0 4px 12px rgba(24, 28, 31, 0.08)',
                    '& .emoji-actions': { opacity: 1 }
                  },
                  '&:focus-within': {
                    borderColor: 'primary.main',
                    '& .emoji-actions': { opacity: 1 }
                  }
                }}
              >
                <Box
                  sx={{
                    position: 'relative',
                    aspectRatio: '1 / 1',
                    display: 'grid',
                    placeItems: 'center',
                    bgcolor: '#F7F8F9'
                  }}
                >
                  {previewLoading ? (
                    <CircularProgress size={22} thickness={3.5} />
                  ) : previewFailed ? (
                    <Tooltip title="图片无法预览">
                      <Box
                        role="img"
                        aria-label="图片无法预览"
                        sx={{
                          width: '100%',
                          height: '100%',
                          display: 'grid',
                          placeItems: 'center',
                          color: '#9AA1A6'
                        }}
                      >
                        <ImageNotSupportedOutlinedIcon sx={{ fontSize: 24 }} />
                      </Box>
                    </Tooltip>
                  ) : (
                    <PhotoView src={previewSrc}>
                      <Box
                        sx={{
                          width: '100%',
                          height: '100%',
                          display: 'grid',
                          placeItems: 'center',
                          p: 1.25,
                          cursor: 'zoom-in'
                        }}
                      >
                        <img
                          src={previewSrc}
                          alt="emoji"
                          loading="lazy"
                          onError={() => void handleImageError(index)}
                          style={{
                            maxWidth: '100%',
                            maxHeight: '100%',
                            objectFit: 'contain'
                          }}
                        />
                      </Box>
                    </PhotoView>
                  )}

                  <Box
                    className="emoji-actions"
                    sx={{
                      position: 'absolute',
                      right: 6,
                      bottom: 6,
                      display: 'flex',
                      gap: 0.5,
                      opacity: 0,
                      transition: 'opacity 120ms ease'
                    }}
                  >
                    <Tooltip
                      title={item.downloadUrl ? '复制下载地址' : '复制来源路径'}
                    >
                      <IconButton
                        size="small"
                        aria-label={
                          item.downloadUrl ? '复制下载地址' : '复制来源路径'
                        }
                        onClick={(event) => {
                          event.stopPropagation()
                          const value =
                            item.downloadUrl ||
                            item.localSourcePath ||
                            item._text
                          copyToClipboard(
                            value,
                            item.downloadUrl
                              ? '下载地址已复制'
                              : '来源路径已复制'
                          )
                        }}
                        sx={{
                          width: 28,
                          height: 28,
                          color: '#FFFFFF',
                          bgcolor: 'rgba(24, 28, 31, 0.76)',
                          '&:hover': { bgcolor: 'rgba(24, 28, 31, 0.92)' }
                        }}
                      >
                        <ContentCopyOutlinedIcon sx={{ fontSize: 15 }} />
                      </IconButton>
                    </Tooltip>
                    <Tooltip
                      title={item.downloadUrl ? '打开下载地址' : '打开预览'}
                    >
                      <IconButton
                        size="small"
                        aria-label={
                          item.downloadUrl ? '打开下载地址' : '打开预览'
                        }
                        onClick={(event) => {
                          event.stopPropagation()
                          openSystem(item.downloadUrl || item.src)
                        }}
                        sx={{
                          width: 28,
                          height: 28,
                          color: '#FFFFFF',
                          bgcolor: 'rgba(24, 28, 31, 0.76)',
                          '&:hover': { bgcolor: 'rgba(24, 28, 31, 0.92)' }
                        }}
                      >
                        <OpenInNewOutlinedIcon sx={{ fontSize: 15 }} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </Box>
              </Box>
            )
          })}
        </Box>
      </PhotoProvider>
    </Box>
  )
}
