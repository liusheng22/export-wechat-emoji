import type { ReactNode } from 'react'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined'
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  Stack,
  Typography
} from '@mui/material'

interface StatusBannerProps {
  flowStage: string
  flowHint: string
  flowError: string | null
  wechatMustQuit: boolean
  wechatRunningMatches: string[]
  onRetry: () => void
  onOpenLogDir: () => void
  isV4: boolean
}

function Notice({
  icon,
  title,
  description,
  action
}: {
  icon: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <Alert icon={icon} severity="info" variant="outlined" sx={{ mb: 2 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={2}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {title}
          </Typography>
          {description && (
            <Typography variant="caption" sx={{ display: 'block', mt: 0.2 }}>
              {description}
            </Typography>
          )}
        </Box>
        {action}
      </Stack>
    </Alert>
  )
}

export function StatusBanner({
  flowStage,
  flowHint,
  flowError,
  wechatMustQuit,
  wechatRunningMatches,
  onRetry,
  onOpenLogDir,
  isV4
}: StatusBannerProps) {
  if (wechatMustQuit) {
    return (
      <Alert
        icon={<WarningAmberOutlinedIcon />}
        severity="warning"
        variant="outlined"
        sx={{ mb: 2 }}
        action={
          <Button size="small" color="inherit" onClick={onRetry}>
            已退出，继续
          </Button>
        }
      >
        <Typography variant="body2" sx={{ fontWeight: 700 }}>
          必须先完全退出微信才能继续
        </Typography>
        <Typography variant="caption" sx={{ display: 'block', mt: 0.2 }}>
          必须先完全退出微信，才能继续获取表情数据。
        </Typography>
        <Typography variant="caption" sx={{ display: 'block', mt: 0.2 }}>
          请使用微信菜单退出应用，而不是只关闭窗口。
          {wechatRunningMatches.length > 0 &&
            ` 当前仍检测到 ${wechatRunningMatches.length} 个进程。`}
        </Typography>
      </Alert>
    )
  }

  if (flowStage === 'checkingWechat') {
    return <Notice icon={<InfoOutlinedIcon />} title="正在检查微信状态" />
  }

  if (flowStage === 'preparingWeChatCopy') {
    return (
      <Notice
        icon={<InfoOutlinedIcon />}
        title="正在准备微信数据"
        description={flowHint || '如微信自动打开，请登录并打开一次表情面板。'}
      />
    )
  }

  if (flowStage === 'waitingForKey') {
    return (
      <Notice
        icon={<InfoOutlinedIcon />}
        title="正在读取微信数据"
        description={flowHint || '请保持微信已登录，并打开一次表情面板。'}
      />
    )
  }

  if (flowStage === 'offlineParsing') {
    return (
      <Box sx={{ mb: 2 }}>
        <Notice
          icon={<InfoOutlinedIcon />}
          title="正在整理表情资源"
          description={flowHint || '这一步在本地完成，请稍候。'}
        />
        <LinearProgress sx={{ mt: -2, height: 2 }} />
      </Box>
    )
  }

  if (flowStage === 'error' && flowError) {
    return (
      <Alert
        severity="error"
        variant="outlined"
        sx={{ mb: 2 }}
        action={
          <Stack direction="row" spacing={0.5}>
            <Button size="small" color="inherit" onClick={onRetry}>
              重试
            </Button>
            {isV4 && (
              <Button size="small" color="inherit" onClick={onOpenLogDir}>
                查看日志
              </Button>
            )}
          </Stack>
        }
      >
        <Typography variant="body2" sx={{ fontWeight: 700 }}>
          获取表情失败
        </Typography>
        <Typography variant="caption" sx={{ display: 'block', mt: 0.2 }}>
          {flowError}
        </Typography>
      </Alert>
    )
  }

  return null
}
