import type { EmojiTargetMeta } from '../../types'
import AccountCircleIcon from '@mui/icons-material/AccountCircle'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import RefreshIcon from '@mui/icons-material/Refresh'
import {
  Avatar,
  Box,
  Divider,
  FormControl,
  IconButton,
  ListItemAvatar,
  ListItemText,
  MenuItem,
  Select,
  Tooltip,
  Typography,
  alpha
} from '@mui/material'
import React, { useEffect, useRef, useState } from 'react'
import {
  fetchBinaryWithFallback,
  type FetchBinaryResult
} from '../../services/downloader'
import { extFromBytes, extFromContentType } from '../../services/stodownload'
import {
  displayNameOfTarget,
  encodeEmojiTarget,
  rawAccountIdOfTarget
} from '../../services/wechat'

function isRemoteAvatarUrl(value: string | undefined): boolean {
  return /^https?:\/\//i.test(String(value || '').trim())
}

function selectorDisplayNameOfTarget(target: EmojiTargetMeta): string {
  const displayName = displayNameOfTarget(target)
  if (target.kind === 'legacy' && !target.displayName?.trim()) {
    return `旧版微信: ${displayName}`
  }
  return displayName
}

function avatarMimeFromResult(result: FetchBinaryResult): string | null {
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

function AccountAvatar({ src, size = 32 }: { src?: string; size?: number }) {
  const [displaySrc, setDisplaySrc] = useState<string | undefined>()
  const objectUrlRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }

    const normalized = src?.trim()
    setDisplaySrc(
      normalized && !isRemoteAvatarUrl(normalized) ? normalized : undefined
    )
    if (!normalized || !isRemoteAvatarUrl(normalized)) {
      return () => {
        cancelled = true
      }
    }

    void (async () => {
      let result: FetchBinaryResult
      try {
        result = await fetchBinaryWithFallback(normalized)
      } catch {
        result = { ok: false, error: new Error('avatar download failed') }
      }
      if (cancelled) {
        return
      }

      const mime = avatarMimeFromResult(result)
      if (!mime || !result.ok) {
        setDisplaySrc(normalized)
        return
      }

      const objectUrl = URL.createObjectURL(
        new Blob([result.buffer], { type: mime })
      )
      objectUrlRef.current = objectUrl
      setDisplaySrc(objectUrl)
    })()

    return () => {
      cancelled = true
    }
  }, [src])

  useEffect(
    () => () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
      }
    },
    []
  )

  return (
    <Avatar
      src={displaySrc}
      sx={{
        width: size,
        height: size,
        bgcolor: alpha('#0FA958', 0.1),
        color: 'primary.main',
        fontSize: Math.max(16, Math.round(size * 0.56))
      }}
    >
      <AccountCircleIcon fontSize="small" />
    </Avatar>
  )
}

interface AccountSelectorProps {
  targets: EmojiTargetMeta[]
  selectedTargetValue: string
  onSelectChange: (event: any) => void
  onRefresh: () => void
  disabled?: boolean
}

export const AccountSelector: React.FC<AccountSelectorProps> = ({
  targets,
  selectedTargetValue,
  onSelectChange,
  onRefresh,
  disabled
}) => {
  const selectedTarget = targets.find(
    (target) => encodeEmojiTarget(target) === selectedTargetValue
  )

  return (
    <Box sx={{ px: 1.25, py: 0.25 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          height: 40,
          overflow: 'hidden',
          border: '1px solid #DDE1E4',
          borderRadius: 1,
          bgcolor: '#FFFFFF',
          transition: 'border-color 120ms ease, box-shadow 120ms ease',
          '&:hover': { borderColor: '#C8CDD1' },
          '&:focus-within': {
            borderColor: '#0FA958',
            boxShadow: '0 0 0 3px rgba(15, 169, 88, 0.1)'
          }
        }}
      >
        <FormControl fullWidth size="small" sx={{ minWidth: 0 }}>
          <Select
            value={selectedTargetValue}
            onChange={onSelectChange}
            disabled={disabled || !targets.length}
            displayEmpty
            aria-label="微信账号"
            IconComponent={KeyboardArrowDownRoundedIcon}
            renderValue={() => {
              if (!selectedTarget) {
                return (
                  <Typography variant="body2" color="text.secondary">
                    {targets.length ? '选择微信账号' : '未发现微信账号'}
                  </Typography>
                )
              }
              return (
                <Box
                  sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}
                >
                  <Box sx={{ mr: 0.85, flexShrink: 0 }}>
                    <AccountAvatar src={selectedTarget.avatarUrl} size={28} />
                  </Box>
                  <Box
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 0.6
                    }}
                  >
                    <Typography
                      variant="body2"
                      noWrap
                      sx={{ flexShrink: 0, fontWeight: 700 }}
                    >
                      {selectorDisplayNameOfTarget(selectedTarget)}
                    </Typography>
                    <Typography
                      variant="caption"
                      noWrap
                      color="text.secondary"
                      sx={{
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                    >
                      {rawAccountIdOfTarget(selectedTarget)}
                    </Typography>
                  </Box>
                </Box>
              )
            }}
            sx={{
              height: '100%',
              '.MuiOutlinedInput-notchedOutline': { border: 0 },
              '&:hover .MuiOutlinedInput-notchedOutline': { border: 0 },
              '&.Mui-focused .MuiOutlinedInput-notchedOutline': { border: 0 },
              '& .MuiSelect-select': {
                minHeight: '38px !important',
                py: 0.5,
                px: 0.75,
                pr: '38px !important',
                display: 'flex',
                alignItems: 'center'
              },
              '& .MuiSelect-icon': { right: 8, color: '#737B81' }
            }}
            MenuProps={{ PaperProps: { sx: { mt: 0.5, maxHeight: 360 } } }}
          >
            {targets.map((target) => {
              const value = encodeEmojiTarget(target)
              return (
                <MenuItem key={value} value={value} sx={{ py: 0.75 }}>
                  <ListItemAvatar sx={{ minWidth: 44 }}>
                    <AccountAvatar src={target.avatarUrl} size={32} />
                  </ListItemAvatar>
                  <ListItemText
                    primary={
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 0.75
                        }}
                      >
                        <Typography
                          variant="body2"
                          noWrap
                          sx={{ fontWeight: 650 }}
                        >
                          {selectorDisplayNameOfTarget(target)}
                        </Typography>
                        {target.isCurrentLikelyAccount && (
                          <Typography
                            variant="caption"
                            sx={{
                              px: 0.6,
                              py: 0.1,
                              flexShrink: 0,
                              borderRadius: 0.75,
                              bgcolor: alpha('#0FA958', 0.1),
                              color: 'primary.dark',
                              fontWeight: 700
                            }}
                          >
                            当前
                          </Typography>
                        )}
                      </Box>
                    }
                    secondary={rawAccountIdOfTarget(target)}
                    secondaryTypographyProps={{
                      noWrap: true,
                      variant: 'caption'
                    }}
                  />
                </MenuItem>
              )
            })}
          </Select>
        </FormControl>
        <Divider orientation="vertical" flexItem sx={{ my: 0.75 }} />
        <Tooltip title="刷新微信账号">
          <span>
            <IconButton
              aria-label="刷新微信账号"
              onClick={onRefresh}
              disabled={disabled}
              size="small"
              sx={{
                width: 38,
                height: 'auto',
                flexShrink: 0,
                borderRadius: 0,
                color: '#687177',
                '&:hover': {
                  bgcolor: '#F3F7F4',
                  color: '#0B914B'
                }
              }}
            >
              <RefreshIcon sx={{ fontSize: 21 }} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
    </Box>
  )
}
