import type { ReactNode } from 'react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card p-4 ${className}`}>{children}</div>
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="section-label">{children}</h2>
      {right}
    </div>
  )
}

export function Toggle({ checked, onChange, disabled, label }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors duration-150 shrink-0 focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-40 ${checked ? '' : ''}`}
      style={{ background: checked ? 'var(--accent)' : 'var(--line-strong)' }}
    >
      <span
        className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-150"
        style={{ transform: checked ? 'translateX(20px)' : 'translateX(0)' }}
      />
    </button>
  )
}

export function Pill({ kind = 'default', children }: { kind?: 'default' | 'ok' | 'bad' | 'warn' | 'accent'; children: ReactNode }) {
  return <span className={`pill ${kind !== 'default' ? `pill-${kind}` : ''}`}>{children}</span>
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-label="loading">
      <circle cx="12" cy="12" r="9" fill="none" stroke="var(--line-strong)" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="card p-8 text-center">
      <div className="text-3xl mb-2" aria-hidden>◎</div>
      <div className="font-semibold mb-1">{title}</div>
      {hint && <div className="muted text-sm max-w-md mx-auto">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function StatRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b last:border-0" style={{ borderColor: 'var(--line)' }}>
      <span className="muted text-sm">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  )
}

export function Dot({ ok }: { ok: boolean | null }) {
  return (
    <span
      aria-label={ok === null ? 'unknown' : ok ? 'online' : 'offline'}
      className="inline-block w-2.5 h-2.5 rounded-full"
      style={{ background: ok === null ? 'var(--muted)' : ok ? 'var(--ok)' : 'var(--bad)' }}
    />
  )
}

export function ConfirmButton({ onConfirm, children, className = '', confirmText = 'Confirm delete?' }: {
  onConfirm: () => void; children: ReactNode; className?: string; confirmText?: string
}) {
  return (
    <button
      className={`btn btn-danger ${className}`}
      onClick={e => {
        const el = e.currentTarget
        if (el.dataset.armed) { onConfirm() }
        else {
          el.dataset.armed = '1'
          el.textContent = confirmText
          setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.textContent = children as string } }, 2500)
        }
      }}
    >{children}</button>
  )
}

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    live: <><rect x="2" y="5" width="14" height="12" rx="2" /><path d="M16 10l6-3v10l-6-3" /></>,
    activity: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
    recordings: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M10 9l5 3-5 3z" /></>,
    cameras: <><circle cx="12" cy="12" r="3.2" /><path d="M4 8a8.5 8.5 0 0 1 16 0M4 16a8.5 8.5 0 0 0 16 0" /></>,
    intelligence: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></>,
    people: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c.6-3.2 2.7-5 5.5-5s4.9 1.8 5.5 5" /><circle cx="16.5" cy="9.5" r="2.6" /><path d="M14.5 14.6c2.6.2 4.4 1.8 5 4.4" /></>,
    automations: <><path d="M13 2L4 14h6l-1 8 9-12h-6z" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></>,
    camera: <><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" /></>,
    mic: <><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v4" /></>,
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[name] ?? null}
    </svg>
  )
}
