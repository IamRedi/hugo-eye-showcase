import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api, type CameraInfo, type EventItem, type Health } from './api'

export type Toast = { id: number; kind: 'info' | 'ok' | 'warn' | 'bad'; text: string }

type AppState = {
  authed: boolean | null
  login: (token: string) => Promise<void>
  logout: () => Promise<void>
  cameras: CameraInfo[]
  refreshCameras: () => Promise<void>
  health: Record<string, Health | null>
  events: EventItem[]
  toasts: Toast[]
  pushToast: (kind: Toast['kind'], text: string) => void
  theme: 'dark' | 'light'
  toggleTheme: () => void
}

const Ctx = createContext<AppState>(null as any)
export const useApp = () => useContext(Ctx)

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [cameras, setCameras] = useState<CameraInfo[]>([])
  const [health, setHealth] = useState<Record<string, Health | null>>({})
  const [events, setEvents] = useState<EventItem[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    (localStorage.getItem('he-theme') as 'dark' | 'light') ?? 'dark')
  const toastId = useRef(1)

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    const id = toastId.current++
    setToasts(t => [...t, { id, kind, text }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light')
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('he-theme', theme)
  }, [theme])

  const refreshCameras = useCallback(async () => {
    try {
      const data = await api.cameras()
      setCameras(data.cameras)
      setHealth(Object.fromEntries(data.cameras.map(c => [c.id, c.health])))
      setAuthed(true)
    } catch (e: any) {
      if (e?.status === 401) setAuthed(false)
    }
  }, [])

  const login = useCallback(async (token: string) => {
    await api.login(token)
    setAuthed(true)
    await refreshCameras()
  }, [refreshCameras])

  const logout = useCallback(async () => {
    try { await api.logout() } catch { /* already gone */ }
    setAuthed(false)
    setCameras([])
  }, [])

  // auth probe + pollers
  useEffect(() => {
    refreshCameras()
    const camTimer = setInterval(refreshCameras, 6000)
    return () => clearInterval(camTimer)
  }, [refreshCameras])

  // live event stream (SSE) + initial history
  useEffect(() => {
    if (!authed) return
    api.events({ limit: '50' }).then(d => setEvents(d.events)).catch(() => {})
    const es = new EventSource('/api/events/stream')
    es.onmessage = ev => {
      try {
        const event = JSON.parse(ev.data) as EventItem
        setEvents(prev => [event, ...prev].slice(0, 200))
        const label = event.type === 'motion' ? 'Motion detected' : event.type
        pushToast('warn', `${label} · ${cameras.find(c => c.id === event.cameraId)?.name ?? event.cameraId}`)
      } catch { /* keep-alive comment */ }
    }
    es.onerror = () => { /* EventSource auto-reconnects */ }
    return () => es.close()
  }, [authed, pushToast, cameras])

  const value = useMemo(() => ({
    authed, login, logout, cameras, refreshCameras, health, events, toasts, pushToast, theme,
    toggleTheme: () => setTheme(t => (t === 'dark' ? 'light' : 'dark')),
  }), [authed, login, logout, cameras, refreshCameras, health, events, toasts, pushToast, theme])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
