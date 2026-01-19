import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import 'react-photo-view/dist/react-photo-view.css'

const prefersDark =
  window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false
const theme = createTheme({
  palette: { mode: prefersDark ? 'dark' : 'light' }
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>
)
