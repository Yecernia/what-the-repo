import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
const App = lazy(() => import('./App.tsx'))
import { AppTooltip } from './AppTooltip'
import { MobileScrollbars } from './MobileScrollbars'
const AdminConsole = lazy(() => import('./AdminConsole'))
import { PresenceHeartbeat } from './PresenceHeartbeat'
import { LazyLoadBoundary } from './LazyLoadBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LazyLoadBoundary>{window.location.pathname.startsWith('/admin') ? <Suspense fallback={<p>正在打开管理台…</p>}><AdminConsole /></Suspense> : <><PresenceHeartbeat /><Suspense fallback={null}><App /></Suspense></>}</LazyLoadBoundary>
    <AppTooltip />
    <MobileScrollbars />
  </StrictMode>,
)
