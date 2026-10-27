import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, fmtBytes, fmtDateTime, type Recording } from '../api'
import { useApp } from '../state'
import { Card, ConfirmButton, EmptyState, Pill, SectionTitle } from '../components/ui'

export function Recordings() {
  const { cameras, pushToast, refreshCameras } = useApp()
  const camera = cameras[0]
  const [items, setItems] = useState<Recording[]>([])
  const [selected, setSelected] = useState<Recording | null>(null)
  const [recording, setRecording] = useState(false)
  const [storage, setStorage] = useState<any>(null)
  const [settings, setSettings] = useState<any>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  const load = useCallback(async () => {
    if (!camera) return
    try {
      const [recs, st, ps] = await Promise.all([
        api.recordings(camera.id), api.storage(), api.settings(),
      ])
      setItems(recs.recordings)
      setStorage(st)
      setSettings(ps.settings)
    } catch { /* unauthorized */ }
  }, [camera])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [load])

  const groups = useMemo(() => {
    const map = new Map<string, Recording[]>()
    for (const r of items) {
      const key = new Date(r.startedAt).toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' })
      map.set(key, [...(map.get(key) ?? []), r])
    }
    return [...map.entries()]
  }, [items])

  const toggleRecord = async () => {
    if (!camera) return
    try {
      if (recording) {
        await api.stopRecording(camera.id)
        pushToast('ok', 'Recording stopped and finalized')
      } else {
        await api.startRecording(camera.id)
        pushToast('ok', 'Recording started (60 s segments)')
      }
    } catch (e: any) { pushToast('bad', e.message) }
  }

  // recording state poll
  useEffect(() => {
    if (!camera) return
    const t = setInterval(async () => {
      try { setRecording((await api.cameraStatus(camera.id)).recording?.recording ?? false) } catch { /* */ }
    }, 4000)
    return () => clearInterval(t)
  }, [camera])

  if (!camera) return <Card>No camera configured.</Card>

  const recEnabled = settings?.privacy.recordingEnabled
  const usedPct = storage ? Math.min(100, (storage.totalBytes / storage.maxBytes) * 100) : 0

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <div className="min-w-0 flex flex-col gap-4">
        {!recEnabled && (
          <Card>
            <div className="flex items-center gap-3">
              <span className="text-2xl" aria-hidden>🔒</span>
              <div className="flex-1">
                <div className="font-semibold">Recording is disabled</div>
                <div className="muted text-sm">Enable it in Settings → Privacy. Nothing is recorded until you do.</div>
              </div>
              <Link to="/settings" className="btn btn-primary">Open Privacy</Link>
            </div>
          </Card>
        )}

        <Card>
          <div className="flex flex-wrap items-center gap-2">
            {recEnabled && (
              <button className={`btn ${recording ? 'btn-danger' : 'btn-primary'}`} onClick={toggleRecord}>
                {recording ? '■ Stop recording' : '⏺ Record now'}
              </button>
            )}
            {recording && <Pill kind="bad">recording…</Pill>}
            <span className="muted text-sm ml-auto">{items.length} segments · grouped by recording session</span>
          </div>
        </Card>

        {groups.length === 0 ? (
          <EmptyState
            title="No recordings yet"
            hint={recEnabled
              ? 'Start a recording here, or let the motion automation create one (Automations).'
              : 'Recording is currently disabled by the privacy switch.'}
          />
        ) : (
          groups.map(([day, recs]) => (
            <Card key={day}>
              <SectionTitle>{day}</SectionTitle>
              <div className="flex flex-col gap-1.5">
                {recs.map(r => (
                  <div key={r.id} className={`flex items-center gap-3 p-2 rounded-xl cursor-pointer transition-colors ${selected?.id === r.id ? '' : 'hover:bg-[var(--card-hover)]'}`}
                    style={selected?.id === r.id ? { background: 'color-mix(in srgb, var(--accent) 12%, var(--card))' } : {}}
                    onClick={() => setSelected(r)}>
                    {r.thumbUrl
                      ? <img src={r.thumbUrl} alt="" loading="lazy" className="w-16 h-9 rounded-lg object-cover bg-black/40 shrink-0" />
                      : <div className="w-16 h-9 rounded-lg bg-black/40 shrink-0" />}
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
                      <div className="muted text-[11px]">{r.durationS ? `${Math.round(r.durationS)}s · ` : ''}{fmtBytes(r.sizeBytes)}</div>
                    </div>
                    <Pill kind={r.trigger === 'manual' ? 'accent' : r.trigger === 'continuous' ? 'ok' : 'warn'}>{r.trigger}</Pill>
                    {r.status !== 'ready' && <Pill kind={r.status === 'corrupt' ? 'bad' : 'default'}>{r.status}</Pill>}
                  </div>
                ))}
              </div>
            </Card>
          ))
        )}
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <SectionTitle>Playback</SectionTitle>
          {selected ? (
            <>
              <video ref={videoRef} key={selected.id} src={selected.url} controls playsInline
                className="w-full rounded-xl bg-black" style={{ aspectRatio: '16/9' }} />
              <div className="mt-3 flex flex-wrap gap-2">
                <a className="btn btn-primary" href={selected.url} download>Download</a>
                <ConfirmButton onConfirm={async () => {
                  await api.deleteRecordingGroup(selected.groupId)
                  setSelected(null)
                  pushToast('ok', 'Recording deleted')
                  load()
                }}>Delete recording</ConfirmButton>
              </div>
              <div className="muted text-xs mt-3">
                {fmtDateTime(selected.startedAt)} · {fmtBytes(selected.sizeBytes)} · trigger: {selected.trigger}
              </div>
            </>
          ) : (
            <p className="muted text-sm">Select a segment from the list to play, download or delete it.</p>
          )}
        </Card>

        {storage && (
          <Card>
            <SectionTitle>Storage</SectionTitle>
            <div className="h-2.5 rounded-full overflow-hidden mb-2" style={{ background: 'var(--line)' }}>
              <div className="h-full rounded-full" style={{ width: `${usedPct}%`, background: 'linear-gradient(90deg, var(--accent), var(--accent-2))' }} />
            </div>
            <div className="text-sm space-y-1">
              <div className="flex justify-between"><span className="muted">Used</span><span>{fmtBytes(storage.totalBytes)} / {fmtBytes(storage.maxBytes)} quota</span></div>
              <div className="flex justify-between"><span className="muted">Recordings</span><span>{storage.recordingSegments} segments · {fmtBytes(storage.recordingBytes)}</span></div>
              <div className="flex justify-between"><span className="muted">Disk free</span><span>{fmtBytes(storage.freeBytes)}</span></div>
              <div className="flex justify-between"><span className="muted">Retention</span><span>{storage.retentionDays} days · min {storage.minFreeGb} GB free</span></div>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
