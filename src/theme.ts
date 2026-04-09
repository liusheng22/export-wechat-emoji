import { alpha, createTheme } from '@mui/material/styles'

const brandGreen = '#0FA958'
const brandGreenHover = '#0B914B'
const ink = '#17191C'
const muted = '#697078'

export const theme = createTheme({
  palette: {
    primary: {
      main: brandGreen,
      dark: brandGreenHover,
      contrastText: '#FFFFFF'
    },
    background: {
      default: '#F3F4F5',
      paper: '#FFFFFF'
    },
    text: {
      primary: ink,
      secondary: muted
    },
    divider: '#E4E7EA',
    warning: { main: '#B46A13' },
    error: { main: '#C83C3C' },
    info: { main: '#3478B8' }
  },
  shape: {
    borderRadius: 8
  },
  typography: {
    fontFamily: [
      '-apple-system',
      'BlinkMacSystemFont',
      '"SF Pro Text"',
      '"PingFang SC"',
      '"Helvetica Neue"',
      'sans-serif'
    ].join(','),
    h5: {
      fontWeight: 700,
      fontSize: '1.25rem',
      lineHeight: 1.3,
      letterSpacing: 0
    },
    h6: {
      fontWeight: 700,
      fontSize: '1rem',
      lineHeight: 1.4,
      letterSpacing: 0
    },
    subtitle1: {
      fontWeight: 650,
      fontSize: '0.9rem',
      letterSpacing: 0
    },
    body1: {
      fontSize: '0.875rem',
      lineHeight: 1.55,
      letterSpacing: 0
    },
    body2: {
      fontSize: '0.8125rem',
      lineHeight: 1.5,
      letterSpacing: 0
    },
    caption: {
      fontSize: '0.75rem',
      lineHeight: 1.45,
      color: muted,
      letterSpacing: 0
    },
    overline: {
      fontSize: '0.6875rem',
      lineHeight: 1.4,
      fontWeight: 700,
      letterSpacing: 0,
      textTransform: 'none',
      color: muted
    },
    button: {
      textTransform: 'none',
      fontWeight: 650,
      fontSize: '0.8125rem',
      letterSpacing: 0
    }
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        '*:focus-visible': {
          outline: `2px solid ${alpha(brandGreen, 0.55)}`,
          outlineOffset: 2
        }
      }
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true
      },
      styleOverrides: {
        root: {
          minHeight: 34,
          borderRadius: 6,
          padding: '5px 13px',
          boxShadow: 'none',
          whiteSpace: 'nowrap'
        },
        containedPrimary: {
          backgroundColor: brandGreen,
          '&:hover': { backgroundColor: brandGreenHover }
        },
        outlinedPrimary: {
          borderColor: '#C9CFD3',
          color: ink,
          '&:hover': {
            borderColor: '#AEB5BA',
            backgroundColor: '#F7F8F8'
          }
        }
      }
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          width: 34,
          height: 34,
          borderRadius: 6
        }
      }
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none'
        },
        outlined: {
          borderColor: '#E1E4E7'
        }
      }
    },
    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          padding: '7px 10px',
          alignItems: 'center'
        },
        icon: {
          padding: 0,
          marginRight: 8,
          fontSize: 19
        },
        message: {
          padding: 0,
          minWidth: 0
        },
        action: {
          padding: 0,
          marginRight: 0,
          alignItems: 'center'
        }
      }
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          minHeight: 44,
          margin: '1px 8px',
          padding: '6px 10px',
          '&.Mui-selected': {
            backgroundColor: '#E9F5EE',
            color: ink,
            '&:hover': { backgroundColor: '#E2F1E8' }
          },
          '&:hover': { backgroundColor: '#EAECED' }
        }
      }
    },
    MuiListItemIcon: {
      styleOverrides: {
        root: {
          minWidth: 32,
          color: muted
        }
      }
    },
    MuiDivider: {
      styleOverrides: {
        root: { borderColor: '#E4E7EA' }
      }
    },
    MuiDialog: {
      styleOverrides: {
        paper: { borderRadius: 8 }
      }
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          borderRadius: 4,
          fontSize: '0.72rem'
        }
      }
    }
  }
})
