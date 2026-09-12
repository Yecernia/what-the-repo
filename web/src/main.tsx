import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppTooltip } from './AppTooltip'
import { MobileScrollbars } from './MobileScrollbars'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AppTooltip />
    <MobileScrollbars />
  </StrictMode>,
)
