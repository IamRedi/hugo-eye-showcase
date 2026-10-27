import { useState } from 'react'
import { api, fmtDateTime } from '../api'
import { useApp } from '../state'
import { Card, EmptyState, Pill, SectionTitle } from '../components/ui'

export function Activity() {
  const { events, cameras } = useApp()
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [cameraFilter, setCameraFilter] = useState<string>('')
  const [search, setSearch] = useState<string>('')
  const [dateFilter, setDateFilter] = useState<string>('')

  const filtered = events.filter(e =>
    (!typeFilter || e.type === typeFilter || (typeFilter === 'person' && e.type.startsWith('person'))) &&
    (!cameraFilter || e.cameraId === cameraFilter) &&
    (!search || (e.detail ?? '').toLowerCase().includes(search.toLowerCase())) &&
    (!dateFilter || (e.at ?? '').startsWith(dateFilter)))

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-4">
      <Card>
        <SectionTitle>Filters</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <select className="input max-w-44" value={typeFilter} onChange={e => setTypeFilter(e.target.value)} aria-label="Event type">
            <option value="">All types</option>
            <option value="person">Persons</option>
            <option value="person_known">Known person</option>
            <option value="person_unknown">Unknown person</option>
            <option value="recognition_uncertain">Uncertain recognition</option>
            <option value="object">Objects</option>
            <option value="motion">Motion</option>
            <option value="visit.summary">Visits</option>
            <option value="stream.lost">Stream lost</option>
            <option value="stream.recovered">Stream recovered</option>
            <option value="snapshot">Snapshots</option>
            <option value="ptz">PTZ</option>
            <option value="preset.goto">Preset moves</option>
            <option value="recording.started">Recording started</option>
            <option value="recording.stopped">Recording stopped</option>
          </select>
          <input className="input max-w-56" placeholder="Search details…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search" />
          <input className="input max-w-40" type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)} aria-label="Date" />
          <select className="input max-w-52" value={cameraFilter} onChange={e => setCameraFilter(e.target.value)} aria-label="Camera">
            <option value="">All cameras</option>
            {cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <span className="muted text-sm self-center ml-auto">Live — new events arrive automatically</span>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <EmptyState
          title="No events match"
          hint="Motion events appear here in real time when motion detection is enabled (Intelligence). System events (PTZ moves, snapshots, recordings) are always recorded."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map(e => (
            <div key={e.id} className="card p-3 flex items-center gap-3">
              {e.thumbUrl
                ? <img src={e.thumbUrl} alt="" className="w-24 h-14 object-cover rounded-lg" style={{ background: 'var(--bg-soft)' }} />
                : <div className="w-24 h-14 rounded-lg grid place-items-center text-xl" style={{ background: 'var(--bg-soft)' }} aria-hidden>
                    {iconFor(e.type)}
                  </div>}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm">{titleFor(e.type)}</span>
                  {e.type === 'visit.summary' && <Pill kind="ok">session</Pill>}
                  {e.correlationId && (
                    <button className="text-[11px] muted underline decoration-dotted"
                      title="Show all events of this visit/session"
                      onClick={() => setSearch(e.correlationId!)}>session view</button>
                  )}
                  {e.confidence !== null && e.confidence !== undefined && (
                    <Pill kind={e.confidence > 0.12 ? 'warn' : 'accent'}>confidence {(e.confidence * 100).toFixed(0)}%</Pill>
                  )}
                </div>
                {e.description && <div className="text-xs mt-0.5" style={{ color: 'var(--accent)' }}>{e.description}</div>}
                <div className="muted text-xs mt-0.5">{e.detail}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm">{fmtDateTime(e.at)}</div>
                <div className="muted text-xs">{cameras.find(c => c.id === e.cameraId)?.name ?? e.cameraId}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function iconFor(type: string) {
  if (type === 'motion') return '🏃'
  if (type.startsWith('recording')) return '⏺'
  if (type === 'snapshot') return '📸'
  if (type === 'ptz' || type.startsWith('preset')) return '🎛'
  return '•'
}

function titleFor(type: string) {  const map: Record<string, string> = {
    'visit.summary': 'Visit',
    'follow.started': 'Auto-follow started',
    'follow.stopped': 'Auto-follow ended',
    'follow.returned': 'Auto-follow returned home',
    motion: 'Motion detected',
    snapshot: 'Snapshot captured',
    ptz: 'Camera moved',
    'preset.goto': 'Preset move',
    'preset.created': 'Position saved',
    'recording.started': 'Recording started',
    'recording.stopped': 'Recording finalized',
    'health.changed': 'Camera health changed',
    'storage.low_disk': 'Low disk space',
  }
  return map[type] ?? type
  if (type === 'visit.summary') return 'Visit'
}

// keep api import used (type re-export safety)
void api
