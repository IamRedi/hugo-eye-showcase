import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useApp } from '../state'
import { Icon } from './ui'

const NAV = [
  { to: '/live', label: 'Live', icon: 'live' },
  { to: '/activity', label: 'Activity', icon: 'activity' },
  { to: '/search', label: 'Search', icon: 'search' },
  { to: '/recordings', label: 'Recordings', icon: 'recordings' },
  { to: '/cameras', label: 'Cameras', icon: 'cameras' },
  { to: '/intelligence', label: 'Intelligence', icon: 'intelligence' },
  { to: '/people', label: 'People', icon: 'people' },
  { to: '/automations', label: 'Automations', icon: 'automations' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
]

export function Shell() {
  const { theme, toggleTheme, logout, cameras, toasts } = useApp()
  const location = useLocation()
  const primary = cameras[0]
  const online = primary?.health?.ok ?? null

  return (
    <div className="h-full flex">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-56 shrink-0 panel border-r px-3 py-4 gap-1">
        <div className="flex items-center gap-2.5 px-2 mb-4">
          <div className="w-9 h-9 rounded-xl grid place-items-center text-white font-bold"
            style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent-2))' }}>HE</div>
          <div>
            <div className="font-bold leading-tight">HUGO Eye</div>
            <div className="text-[11px] muted">Indoor camera platform</div>
          </div>
        </div>
        {NAV.map(item => (
          <NavLink key={item.to} to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${isActive ? '' : 'hover:bg-[var(--card)]'}`}
            style={navStyleActive}
          >
            <Icon name={item.icon} />
            {item.label}
          </NavLink>
        ))}
        <div className="mt-auto flex flex-col gap-1">
          <a className="btn btn-ghost justify-start" href="/panel" target="_blank" rel="noopener">
            <Icon name="camera" /> Compact panel
          </a>
          <button className="btn btn-ghost justify-start" onClick={toggleTheme}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} /> {theme === 'dark' ? 'Light' : 'Dark'} theme
          </button>
          <button className="btn btn-ghost justify-start" onClick={logout}><Icon name="logout" /> Sign out</button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="panel border-b px-4 py-2.5 flex items-center gap-3">
          <div className="md:hidden font-bold">HUGO Eye</div>
          {primary && (
            <div className="flex items-center gap-2 text-sm">
              <span className={`pill ${online ? 'pill-ok' : 'pill-bad'}`}>
                {online ? 'Camera online' : 'Camera offline'}
              </span>
              <span className="muted hidden sm:inline">{primary.name} · {primary.model}</span>
            </div>
          )}
          <div className="flex-1" />
          <button className="btn btn-ghost md:hidden" onClick={toggleTheme} aria-label="Toggle theme">
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
        </header>

        <main className="flex-1 overflow-y-auto p-4 pb-20 md:pb-4">
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 panel border-t grid grid-cols-5 py-1.5 z-40">
        {NAV.slice(0, 5).map(item => (
          <NavLink key={item.to} to={item.to}
            className={({ isActive }) => `flex flex-col items-center gap-0.5 py-1 text-[10px] ${isActive ? 'text-[var(--accent)]' : 'muted'}`}>
            <Icon name={item.icon} size={20} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Toasts */}
      <div className="fixed top-3 right-3 z-50 flex flex-col gap-2 w-80 max-w-[90vw]">
        {toasts.map(t => (
          <div key={t.id} className="card px-4 py-3 text-sm shadow-xl flex items-start gap-2"
            style={{ borderLeft: `3px solid ${t.kind === 'warn' ? 'var(--warn)' : t.kind === 'bad' ? 'var(--bad)' : 'var(--accent)'}` }}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}

function navStyleActive({ isActive }: { isActive: boolean }) {
  return isActive
    ? { background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--accent)' }
    : undefined
}
