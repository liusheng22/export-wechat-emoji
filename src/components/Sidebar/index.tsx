import type {
  EmojiAlbum,
  EmojiTargetMeta,
  EmoticonCatalogMode
} from '../../types'
import FavoriteRoundedIcon from '@mui/icons-material/FavoriteRounded'
import PhotoLibraryOutlinedIcon from '@mui/icons-material/PhotoLibraryOutlined'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import {
  Avatar,
  Box,
  Divider,
  InputBase,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography
} from '@mui/material'
import React, { useDeferredValue, useEffect, useRef, useState } from 'react'
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
import { AccountSelector } from '../AccountSelector'

function isWechatThumbnailUrl(value: string | undefined): boolean {
  if (!value) {
    return false
  }
  try {
    const parsed = new URL(value)
    return (
      parsed.hostname === 'mmbiz.qpic.cn' ||
      parsed.pathname.includes('/mmemoticon/')
    )
  } catch {
    return false
  }
}

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

function AlbumAvatar({
  src,
  fallbackSrc,
  name
}: {
  src?: string
  fallbackSrc?: string
  name: string
}) {
  const preferredSrc =
    isWechatThumbnailUrl(src) && fallbackSrc ? fallbackSrc : src || fallbackSrc
  const browserSrc = getBrowserPreviewSrc(preferredSrc)
  const [displaySrc, setDisplaySrc] = useState(
    shouldHydrateRemoteImage(preferredSrc) ? undefined : browserSrc
  )
  const attemptedKeyRef = useRef('')
  const objectUrlRef = useRef<string | null>(null)

  useEffect(() => {
    attemptedKeyRef.current = ''
    setDisplaySrc(
      shouldHydrateRemoteImage(preferredSrc) ? undefined : browserSrc
    )
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [preferredSrc])

  useEffect(
    () => () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
      }
    },
    []
  )

  const recover = async () => {
    const candidates = Array.from(
      new Set([preferredSrc, browserSrc, src, fallbackSrc].filter(Boolean))
    ) as string[]
    const key = candidates.join('|')
    if (!candidates.length || attemptedKeyRef.current === key) {
      return
    }
    attemptedKeyRef.current = key

    for (const candidate of candidates) {
      let result: FetchBinaryResult
      try {
        result = await fetchBinaryWithFallback(candidate)
      } catch {
        continue
      }
      const mime = imageMimeFromResult(result)
      if (!result.ok || !mime) {
        continue
      }
      const objectUrl = URL.createObjectURL(
        new Blob([result.buffer], { type: mime })
      )
      objectUrlRef.current = objectUrl
      setDisplaySrc(objectUrl)
      return
    }
  }

  useEffect(() => {
    if (shouldHydrateRemoteImage(preferredSrc)) {
      void recover()
    }
  }, [preferredSrc, browserSrc])

  return (
    <Avatar
      src={displaySrc || undefined}
      alt={name}
      onError={() => void recover()}
      variant="rounded"
      sx={{
        width: 36,
        height: 36,
        borderRadius: 1,
        bgcolor: '#E8EBED',
        color: '#778087',
        border: '1px solid #DCE0E3'
      }}
    >
      <PhotoLibraryOutlinedIcon sx={{ fontSize: 18 }} />
    </Avatar>
  )
}

interface SidebarProps {
  targets: EmojiTargetMeta[]
  selectedTargetValue: string
  onSelectChange: (event: any) => void
  onRefreshTargets: () => void
  targetsLoading: boolean
  isExporting: boolean
  currentView: string
  onViewChange: (view: string) => void
  albums: EmojiAlbum[]
  favoritesCount: number
  catalogMode: EmoticonCatalogMode
}

export const Sidebar: React.FC<SidebarProps> = ({
  targets,
  selectedTargetValue,
  onSelectChange,
  onRefreshTargets,
  targetsLoading,
  isExporting,
  currentView,
  onViewChange,
  albums,
  favoritesCount,
  catalogMode
}) => {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const visibleAlbums = deferredQuery
    ? albums.filter((album) => album.name.toLowerCase().includes(deferredQuery))
    : albums

  const emptyAlbumHint = deferredQuery
    ? '没有匹配的专辑'
    : catalogMode === 'favorites_only'
      ? '当前账号没有可用专辑'
      : catalogMode === 'unavailable'
        ? '读取微信数据后显示专辑'
        : '没有找到表情专辑'

  return (
    <Box
      component="aside"
      sx={{
        width: 252,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: '#F3F4F5'
      }}
    >
      <AccountSelector
        targets={targets}
        selectedTargetValue={selectedTargetValue}
        onSelectChange={onSelectChange}
        onRefresh={onRefreshTargets}
        disabled={isExporting || targetsLoading}
      />

      <Divider />

      <Box component="nav" aria-label="表情资源" sx={{ flex: 1, minHeight: 0 }}>
        <Box sx={{ height: '100%', overflowY: 'auto', py: 1 }}>
          <List disablePadding>
            <ListItem disablePadding>
              <ListItemButton
                aria-label="个人收藏"
                selected={currentView === 'favorites'}
                onClick={() => onViewChange('favorites')}
              >
                <ListItemIcon sx={{ minWidth: 38 }}>
                  <Avatar
                    variant="rounded"
                    sx={{
                      width: 32,
                      height: 32,
                      borderRadius: 1,
                      bgcolor: '#E8ECEE',
                      color: '#5F676D'
                    }}
                  >
                    <FavoriteRoundedIcon sx={{ fontSize: 17 }} />
                  </Avatar>
                </ListItemIcon>
                <ListItemText
                  primary="个人收藏"
                  primaryTypographyProps={{
                    variant: 'body2',
                    fontWeight: currentView === 'favorites' ? 700 : 550
                  }}
                />
                {favoritesCount > 0 && (
                  <Typography variant="caption">{favoritesCount}</Typography>
                )}
              </ListItemButton>
            </ListItem>
          </List>

          <Box
            sx={{
              mt: 2,
              mb: 0.75,
              px: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
          >
            <Typography variant="overline">表情专辑</Typography>
            {albums.length > 0 && (
              <Typography variant="caption">{albums.length}</Typography>
            )}
          </Box>

          {albums.length >= 8 && (
            <Box sx={{ px: 1, mb: 0.75 }}>
              <Box
                sx={{
                  height: 32,
                  display: 'flex',
                  alignItems: 'center',
                  px: 1,
                  border: '1px solid #DDE1E4',
                  borderRadius: 1,
                  bgcolor: '#FFFFFF'
                }}
              >
                <SearchRoundedIcon
                  sx={{ mr: 0.75, fontSize: 17, color: '#858C92' }}
                />
                <InputBase
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索专辑"
                  inputProps={{ 'aria-label': '搜索专辑' }}
                  sx={{ flex: 1, fontSize: '0.78rem' }}
                />
              </Box>
            </Box>
          )}

          <List disablePadding>
            {visibleAlbums.length ? (
              visibleAlbums.map((album) => {
                const selected = currentView === `album|${album.id}`
                return (
                  <ListItem key={album.id} disablePadding>
                    <ListItemButton
                      selected={selected}
                      onClick={() => onViewChange(`album|${album.id}`)}
                      sx={{
                        position: 'relative',
                        '&.Mui-selected::before': {
                          content: '""',
                          position: 'absolute',
                          left: 0,
                          top: 9,
                          bottom: 9,
                          width: 3,
                          borderRadius: '0 3px 3px 0',
                          bgcolor: 'primary.main'
                        }
                      }}
                    >
                      <ListItemIcon sx={{ minWidth: 44 }}>
                        <AlbumAvatar
                          src={album.icon}
                          fallbackSrc={album.iconFallback}
                          name={album.name}
                        />
                      </ListItemIcon>
                      <ListItemText
                        primary={album.name}
                        secondary={`${album.count} 个表情`}
                        primaryTypographyProps={{
                          variant: 'body2',
                          fontWeight: selected ? 700 : 550,
                          noWrap: true
                        }}
                        secondaryTypographyProps={{
                          variant: 'caption',
                          noWrap: true,
                          sx: { mt: 0.1 }
                        }}
                      />
                    </ListItemButton>
                  </ListItem>
                )
              })
            ) : (
              <Typography
                variant="caption"
                sx={{ display: 'block', px: 2, py: 1.5 }}
              >
                {emptyAlbumHint}
              </Typography>
            )}
          </List>
        </Box>
      </Box>

      <Divider />
      <List disablePadding sx={{ py: 0.75 }}>
        <ListItem disablePadding>
          <ListItemButton
            selected={currentView === 'settings'}
            onClick={() => onViewChange('settings')}
          >
            <ListItemIcon>
              <SettingsOutlinedIcon sx={{ fontSize: 18 }} />
            </ListItemIcon>
            <ListItemText
              primary="设置"
              primaryTypographyProps={{ variant: 'body2' }}
            />
          </ListItemButton>
        </ListItem>
      </List>
    </Box>
  )
}
