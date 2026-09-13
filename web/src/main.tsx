import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppTooltip } from './AppTooltip'
import { MobileScrollbars } from './MobileScrollbars'
const AdminConsole = lazy(() => import('./AdminConsole'))
import { PresenceHeartbeat } from './PresenceHeartbeat'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.pathname.startsWith('/admin') ? <Suspense fallback={<p>正在打开管理台…</p>}><AdminConsole /></Suspense> : <><PresenceHeartbeat /><App /></>}
    <AppTooltip />
    <MobileScrollbars />
  </StrictMode>,
)
