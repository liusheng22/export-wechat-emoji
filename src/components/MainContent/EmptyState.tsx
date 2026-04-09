import type { ReactNode } from 'react'
import { Box, Typography } from '@mui/material'

interface EmptyStateProps {
  icon: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
}

export function EmptyState({
  icon,
  title,
  description,
  action
}: EmptyStateProps) {
  return (
    <Box
      sx={{
        minHeight: 320,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        px: 3,
        py: 6,
        textAlign: 'center'
      }}
    >
      <Box
        sx={{
          width: 48,
          height: 48,
          mb: 2,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 1,
          color: 'text.secondary',
          bgcolor: '#F2F4F5',
          '& svg': { fontSize: 24 }
        }}
      >
        {icon}
      </Box>
      <Typography variant="subtitle1" sx={{ color: 'text.primary' }}>
        {title}
      </Typography>
      {description && (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mt: 0.75, maxWidth: 360 }}
        >
          {description}
        </Typography>
      )}
      {action && <Box sx={{ mt: 2.25 }}>{action}</Box>}
    </Box>
  )
}
