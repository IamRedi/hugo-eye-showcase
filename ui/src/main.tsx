import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import './index.css'
import { AppProvider, useApp } from './state'
import { Shell } from './components/Shell'
import { Login } from './pages/Login'
import { Live } from './pages/Live'
import { Activity } from './pages/Activity'
import { SearchPage } from './pages/Search'
import { Recordings } from './pages/Recordings'
import { Cameras } from './pages/Cameras'
import { Intelligence } from './pages/Intelligence'
import { Automations } from './pages/Automations'
import { People } from './pages/People'
import { SettingsPage } from './pages/SettingsPage'
import { Panel } from './pages/Panel'

function Gate({ children }: { children: React.ReactNode }) {
  const { authed } = useApp()
  if (authed === null) {
    return <div className="h-full grid place-items-center muted">Connecting…</div>
  }
  if (!authed) return <Login />
  return children
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <Gate><Shell /></Gate>,
    children: [
      { index: true, element: <Live /> },
      { path: 'live', element: <Live /> },
      { path: 'activity', element: <Activity /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'recordings', element: <Recordings /> },
      { path: 'cameras', element: <Cameras /> },
      { path: 'intelligence', element: <Intelligence /> },
      { path: 'people', element: <People /> },
      { path: 'automations', element: <Automations /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
  { path: '/panel', element: <Gate><Panel /></Gate> },
])

// PWA: register the app-shell service worker (never caches /api or /media)
if ('serviceWorker' in navigator && location.protocol === 'https:' || 'serviceWorker' in navigator && ['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* best effort */ })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <RouterProvider router={router} />
    </AppProvider>
  </StrictMode>,
)
