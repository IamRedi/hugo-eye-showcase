import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type IntelligenceStatus, type ProductSettings, type Zone } from '../api'
import { useApp } from '../state'
import { Card, Pill, SectionTitle, Toggle, Spinner } from '../components/ui'

export function Intelligence() {
  const { pushToast, cameras } = useApp()
  const [status, setStatus] = useState<IntelligenceStatus | null>(null)
  const [settings, setSettings] = useState<ProductSettings | null>(null)
  const [confirmAI, setConfirmAI] = useState(false)
  const [zone, setZone] = useState<Zone | null>(null)
  const camera = cameras[0]

  const loadZone = useCallback(async () => {
    if (!camera) return
    try { setZone((await api.cameraZone(camera.id)).zone) } catch { /* */ }
  }, [camera])
  useEffect(() => { loadZone() }, [loadZone])

  const load = useCallback(async () => {
    try {
      setStatus(await api.intelligence())
      setSettings((await api.settings()).settings)
    } catch { /* */ }
  }, [])
  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  const patch = async (body: any, msg: string) => {
    try {
      const r = await api.patchSettings(body)
      setSettings(r.settings)
      pushToast('ok', msg)
      load()
    } catch (e: any) { pushToast('bad', e.message) }
  }

  if (!status || !settings) return null
  const motionUsable = settings.privacy.aiEnabled

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-4">
      <Card>
        <SectionTitle>Master AI gate <span className="normal-case font-normal">— nothing analyzes video until you enable it</span></SectionTitle>
        <div className="flex items-center gap-3">
          <Toggle checked={settings.privacy.aiEnabled} disabled={confirmAI ? false : settings.privacy.aiEnabled ? false : true}
            onChange={v => {
              if (!v) { patch({ privacy: { aiEnabled: false } }, 'AI disabled — no video analysis is running'); setConfirmAI(false); return }
              setConfirmAI(true)
            }} />
          <div className="flex-1">
            <div className="text-sm font-medium">Local video analysis enabled</div>
            <div className="muted text-xs">All processing runs on this appliance. No video leaves the machine, ever.</div>
          </div>
          {status.aiEnabled && <Pill kind="ok">AI active</Pill>}
        </div>
        {confirmAI && settings.privacy.aiEnabled === false && (
          <div className="mt-3 p-3 rounded-xl text-sm" style={{ background: 'var(--bg-soft)' }}>
            <div className="font-medium mb-1">Enable local video analysis?</div>
            <div className="muted mb-2">Motion detection will process a tiny 160×90 grayscale stream at 2 fps on this machine. You can disable it at any time.</div>
            <div className="flex gap-2">
              <button className="btn btn-primary" onClick={() => { patch({ privacy: { aiEnabled: true } }, 'AI enabled'); setConfirmAI(false) }}>Enable analysis</button>
              <button className="btn" onClick={() => setConfirmAI(false)}>Cancel</button>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle right={<Pill kind={status.motion.active ? 'ok' : 'default'}>{status.motion.active ? 'running' : 'stopped'}</Pill>}>
          Motion detection <span className="normal-case font-normal">— real, in-process, measurable</span>
        </SectionTitle>
        <div className="flex items-center gap-3 mb-3">
          <Toggle checked={settings.motion.enabled} disabled={!motionUsable}
            onChange={v => patch({ motion: { enabled: v } }, v ? 'Motion detection enabled' : 'Motion detection disabled')} />
          <div className="flex-1 text-sm">
            {motionUsable
              ? 'Analyzes the preview stream for picture changes.'
              : 'Enable the master AI gate first.'}
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="text-sm block">
            <span className="muted block mb-1">Sensitivity threshold — lower = more sensitive <span className="font-mono">{settings.motion.threshold.toFixed(3)}</span></span>
            <input type="range" min="0.005" max="0.2" step="0.005" value={settings.motion.threshold}
              onChange={e => patch({ motion: { threshold: Number(e.target.value) } }, 'Threshold updated')}
              className="w-full" disabled={!motionUsable} />
          </label>
          <label className="text-sm block">
            <span className="muted block mb-1">Minimum seconds between events</span>
            <input type="number" className="input" min={2} max={3600} value={settings.motion.minIntervalSec}
              onChange={e => patch({ motion: { minIntervalSec: Number(e.target.value) } }, 'Dedup window updated')}
              disabled={!motionUsable} />
          </label>
        </div>
        {status.motion.providers.length > 0 && (
          <div className="mt-3 text-sm space-y-1">
            {status.motion.providers.map(p => (
              <div key={p.cameraId} className="flex justify-between" style={{ color: 'var(--muted)' }}>
                <span>{p.cameraId}: {p.frames} frames analyzed · {p.events} events · last diff {p.lastDiff}</span>
                {p.lastEventAt && <span>last event {new Date(p.lastEventAt).toLocaleTimeString()}</span>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle right={<Pill kind={status.person.active ? 'ok' : status.person.enabled ? 'accent' : 'default'}>
          {status.person.active ? 'ACTIVE' : status.person.enabled ? 'starting' : 'off'}
        </Pill>}>
          Person &amp; object detection <span className="normal-case font-normal">— local YOLOv8n, opt-in, measurable</span>
        </SectionTitle>
        {!status.availability.runtime || !status.availability.model ? (
          <div className="p-3 rounded-xl text-sm" style={{ background: 'var(--bg-soft)' }}>
            <div className="font-medium mb-1">Local inference engine not installed</div>
            <div className="muted text-xs">
              Run <code className="font-mono">npm run ai:setup</code> on the appliance to fetch the detection model
              (sha256-verified), then <code className="font-mono">npm install</code> for the runtime. HUGO Eye
              reports this honestly instead of pretending the feature exists.
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-3">
              <Toggle checked={settings.ai.personEnabled} disabled={!motionUsable}
                onChange={v => patch({ ai: { personEnabled: v } }, v ? 'Person detection enabled (runs locally)' : 'Person detection disabled')} />
              <div className="flex-1 text-sm">
                {motionUsable
                  ? 'Detects people and selected objects in the preview stream. Inference runs on this machine; only event metadata and thumbnails are stored.'
                  : 'Enable the master AI gate first.'}
              </div>
            </div>
            <div className="grid sm:grid-cols-3 gap-4">
              <label className="text-sm block">
                <span className="muted block mb-1">Confidence floor <span className="font-mono">{settings.ai.minConfidence.toFixed(2)}</span></span>
                <input type="range" min="0.2" max="0.9" step="0.05" value={settings.ai.minConfidence}
                  onChange={e => patch({ ai: { minConfidence: Number(e.target.value) } }, 'Confidence floor updated')}
                  className="w-full" disabled={!motionUsable || !settings.ai.personEnabled} />
              </label>
              <label className="text-sm block">
                <span className="muted block mb-1">Inference rate (fps)</span>
                <input type="number" className="input" min={1} max={5} value={settings.ai.inferenceFps}
                  onChange={e => patch({ ai: { inferenceFps: Number(e.target.value) } }, 'Inference rate updated')}
                  disabled={!motionUsable || !settings.ai.personEnabled} />
              </label>
              <label className="text-sm block">
                <span className="muted block mb-1">Seconds between events per class</span>
                <input type="number" className="input" min={5} max={3600} value={settings.ai.minIntervalSec}
                  onChange={e => patch({ ai: { minIntervalSec: Number(e.target.value) } }, 'Dedup window updated')}
                  disabled={!motionUsable || !settings.ai.personEnabled} />
              </label>
            </div>
            {status.person.providers.map(p => (
              <div key={p.cameraId} className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>
                {p.cameraId}: {p.state} · {p.stats.inferences} inferences · {p.stats.lastLatencyMs} ms · {p.stats.events} events
                {p.lastError ? ` · error: ${p.lastError}` : ''}
              </div>
            ))}
          </>
        )}
      </Card>

      <Card>
        <SectionTitle right={<Pill kind={
          !status.face.available ? 'default' : (status.face.active && settings.privacy.familiarFaceEnabled ? 'ok' : 'default')
        }>
          {!status.face.available ? 'models missing' : (settings.privacy.familiarFaceEnabled && status.face.active ? 'recognizing' : 'detection only')}
        </Pill>}>
          Face detection &amp; familiar faces <span className="normal-case font-normal">— local YuNet + SFace; recognition strictly opt-in</span>
        </SectionTitle>
        {!status.face.available ? (
          <div className="muted text-sm">Face models not installed — run <code className="font-mono">npm run ai:setup</code> on the appliance.</div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-3">
              <Toggle checked={settings.privacy.familiarFaceEnabled} disabled={!motionUsable}
                onChange={v => patch({ privacy: { familiarFaceEnabled: v } },
                  v ? 'Familiar-face recognition enabled (local only)' : 'Recognition disabled — faces are only detected, never identified')} />
              <div className="flex-1 text-sm">
                {motionUsable
                  ? <>Identify enrolled people in the live stream. Unknown people stay unknown. Manage profiles in <a className="underline" href="/people">People</a>.</>
                  : 'Enable the master AI gate first.'}
              </div>
            </div>
            <div className="grid sm:grid-cols-3 gap-4">
              <label className="text-sm block">
                <span className="muted block mb-1">Face detection sensitivity <span className="font-mono">{settings.face.detectionScore.toFixed(2)}</span></span>
                <input type="range" min="0.3" max="0.8" step="0.05" value={settings.face.detectionScore}
                  onChange={e => patch({ face: { detectionScore: Number(e.target.value) } }, 'Face detection sensitivity updated')}
                  className="w-full" disabled={!motionUsable} />
              </label>
              <label className="text-sm block">
                <span className="muted block mb-1">Recognition threshold <span className="font-mono">{settings.face.matchThreshold.toFixed(2)}</span></span>
                <input type="range" min="0.28" max="0.5" step="0.01" value={settings.face.matchThreshold}
                  onChange={e => patch({ face: { matchThreshold: Number(e.target.value) } }, 'Recognition threshold updated')}
                  className="w-full" disabled={!motionUsable} />
              </label>
              <div className="text-sm" style={{ color: 'var(--muted)' }}>
                Enrolled references: {status.face.enrolledCount}<br />
                faces in view: {status.face.providers[0]?.faces?.length ?? 0}
              </div>
            </div>
          </>
        )}
      </Card>

      {status.vision?.length > 0 && (
        <Card>
          <SectionTitle>Vision runtime health <span className="normal-case font-normal">— real provider statistics</span></SectionTitle>
          {status.vision.map((v: any) => (
            <div key={v.cameraId} className="text-sm" style={{ color: 'var(--muted)' }}>
              <div>{v.cameraId}: {v.frames} frames decoded · source {v.sourceActive ? 'active' : 'idle'}{v.lastFrameAt ? ` · last frame ${new Date(v.lastFrameAt).toLocaleTimeString()}` : ''}</div>
              {v.providers.map((p: any) => (
                <div key={p.name} className="ml-3">
                  {p.name}: {p.state} · {p.processed} processed · p50 {p.latency?.p50 ?? '—'} ms / p95 {p.latency?.p95 ?? '—'} ms
                  {p.restarts ? ` · ${p.restarts} restarts` : ''}{p.lastError ? ` · last error: ${p.lastError}` : ''}
                </div>
              ))}
            </div>
          ))}
        </Card>
      )}

      {camera && (
        <Card>
          <SectionTitle right={zone ? <Pill kind="ok">{zone.points.length}-point zone</Pill> : <Pill>full frame</Pill>}>
            Detection zone <span className="normal-case font-normal">— events only inside the drawn area</span>
          </SectionTitle>
          <ZoneEditor cameraId={camera.id} zone={zone} onChange={z => { setZone(z); pushToast('ok', z ? 'Detection zone saved' : 'Detection zone cleared') }} />
        </Card>
      )}

      <Card>
        <SectionTitle>Providers</SectionTitle>
        <div className="flex flex-col gap-2">
          {status.providers.map(p => (
            <div key={p.id} className="flex items-start gap-3 p-3 rounded-xl" style={{ background: 'var(--bg-soft)' }}>
              <Pill kind={p.state === 'active' ? 'ok' : 'default'}>
                {p.state === 'active' ? 'ACTIVE' : p.state === 'not_active' ? 'NOT ACTIVE' : p.state}
              </Pill>
              <div className="flex-1">
                <div className="text-sm font-medium">{p.label}</div>
                <div className="muted text-xs">{p.engine ?? p.note}</div>
              </div>
            </div>
          ))}
        </div>
        <p className="muted text-xs mt-3">
          Status is always real: a provider is listed as active only while it actually analyzes frames on this
          machine. Face recognition is strictly opt-in — it runs only for people you enroll in People, and
          never labels anyone automatically.
        </p>
      </Card>

      <Card>
        <SectionTitle right={<Pill kind={status.aiVision?.provider?.state === 'ready' ? 'ok' : 'default'}>
          {status.aiVision?.provider?.state ?? 'unknown'}
        </Pill>}>
          Visual reasoning <span className="normal-case font-normal">— local vision-language model (opt-in)</span>
        </SectionTitle>
        <div className="flex items-center gap-3 mb-3">
          <Toggle checked={settings.aiVision?.enabled ?? false}
            onChange={v => patch({ aiVision: { enabled: v } }, v ? 'Visual reasoning enabled — the local VLM will describe events' : 'Visual reasoning disabled')} />
          <div className="flex-1 text-sm">
            {settings.aiVision?.enabled
              ? `Answers scene questions and describes events with ${status.aiVision?.provider?.model ?? 'the local model'} — on this machine.`
              : 'Enable to allow the local vision-language model to describe events and answer questions.'}
          </div>
        </div>
        {settings.aiVision?.enabled && (
          <div className="grid sm:grid-cols-2 gap-4">
            <Toggle checked={settings.aiVision.describeEvents}
              onChange={v => patch({ aiVision: { describeEvents: v } }, v ? 'Event descriptions on' : 'Event descriptions off')} />
            <label className="text-sm block">
              <span className="muted block mb-1">Cooldown between automatic descriptions (seconds)</span>
              <input type="number" className="input" min={15} max={3600} value={settings.aiVision.cooldownSec}
                onChange={e => patch({ aiVision: { cooldownSec: Number(e.target.value) } }, 'Cooldown updated')} />
            </label>
          </div>
        )}
        {status.aiVision && (
          <div className="muted text-xs mt-2">
            queue {status.aiVision.queued}{status.aiVision.running ? ' · busy' : ''} · completed {status.aiVision.completed} · failed {status.aiVision.failed}
            {status.aiVision.provider?.lastMs ? ` · last answer ${status.aiVision.provider.lastMs}ms` : ''}
          </div>
        )}
        <AskBox camera={camera?.id ?? ''} />
      </Card>

      <Card>
        <SectionTitle right={<FollowChip camera={camera?.id ?? ''} />}>
          PTZ auto-follow <span className="normal-case font-normal">— the camera follows one selected person (opt-in)</span>
        </SectionTitle>
        <div className="flex items-center gap-3">
          <Toggle checked={settings.autofollow?.enabled ?? false}
            onChange={v => patch({ autofollow: { enabled: v } }, v ? 'Auto-follow armed — start it from Live by clicking a person' : 'Auto-follow disabled')} />
          <div className="flex-1 text-sm">
            {settings.autofollow?.enabled
              ? 'Start following from the Live view: click Follow on a detected person. Any manual PTZ command takes over instantly.'
              : 'Requires the master AI gate and person detection. Start sessions from Live; manual PTZ always wins.'}
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Toggle checked={settings.autofollow?.returnHome ?? true}
            onChange={v => patch({ autofollow: { returnHome: v } }, v ? 'Return-to-home on' : 'Return-to-home off')} />
          <div className="flex-1 text-sm muted">Return to the position captured when following started (after target loss).</div>
        </div>
      </Card>

      <Card>
        <SectionTitle>Recording <span className="normal-case font-normal">— modes and event windows</span></SectionTitle>
        <div className="grid sm:grid-cols-3 gap-3 mb-4">
          {(['events', 'continuous', 'off'] as const).map(mode => (
            <button key={mode}
              className="btn text-xs"
              style={settings.recording?.mode === mode ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
              onClick={() => patch({ recording: { mode } }, `Recording mode: ${mode}`)}>
              {mode === 'events' ? 'Event-triggered' : mode === 'continuous' ? 'Continuous' : 'Off'}
            </button>
          ))}
        </div>
        <p className="muted text-xs mb-3">
          {settings.recording?.mode === 'continuous'
            ? 'Cameras record around the clock; retention and quotas keep storage bounded.'
            : settings.recording?.mode === 'off'
              ? 'All recording (manual included) is refused.'
              : 'Recording starts on motion/person events (or manually), with pre-event buffering and a rolling quiet-stop window.'}
        </p>
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="text-sm block">
            <span className="muted block mb-1">Post-event quiet window (seconds)</span>
            <input type="number" className="input" min={0} max={120} value={settings.recording?.postEventSec ?? 10}
              onChange={e => patch({ recording: { postEventSec: Number(e.target.value) } }, 'Post-event window updated')} />
          </label>
          <label className="text-sm block">
            <span className="muted block mb-1">Max length of one event recording (seconds)</span>
            <input type="number" className="input" min={15} max={3600} value={settings.recording?.maxSec ?? 300}
              onChange={e => patch({ recording: { maxSec: Number(e.target.value) } }, 'Cap updated')} />
          </label>
        </div>
      </Card>
    </div>
  )
}

function AskBox({ camera }: { camera: string }) {
  const { pushToast } = useApp()
  const [q, setQ] = useState('')
  const [answer, setAnswer] = useState<{ text: string; ms: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const ask = async () => {
    if (!q.trim() || !camera) return
    setBusy(true)
    setAnswer(null)
    try {
      const r = await api.aiAsk(camera, q.trim())
      if (r.ok && r.answer && typeof r.ms === 'number') setAnswer({ text: r.answer, ms: r.ms })
      else if (r.ok) pushToast('bad', 'empty answer')
      else pushToast('bad', r.error ?? 'ask failed')
    } catch (e: any) { pushToast('bad', e.message) } finally { setBusy(false) }
  }
  return (
    <div className="mt-3">
      <div className="flex gap-2">
        <input className="input flex-1 text-sm" placeholder='Ask the camera: "what is happening right now?"'
          value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') ask() }} />
        <button className="btn btn-primary text-xs" onClick={ask} disabled={busy}>{busy ? <Spinner /> : 'Ask'}</button>
      </div>
      {answer && (
        <div className="mt-2 p-3 rounded-xl text-sm" style={{ background: 'var(--bg-soft)' }}>
          {answer.text}
          <span className="muted text-xs block mt-1">local model · {answer.ms}ms</span>
        </div>
      )}
    </div>
  )
}

function FollowChip({ camera }: { camera: string }) {
  const [state, setState] = useState<string>('idle')
  useEffect(() => {
    let alive = true
    const tick = () => api.followStatus(camera).then(r => { if (alive) setState(r.follow.state) }).catch(() => {})
    tick()
    const t = setInterval(tick, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [camera])
  return <Pill kind={state === 'following' ? 'ok' : 'default'}>{state}</Pill>
}

/**
 * Zone editor: click on the snapshot to add polygon points (normalized
 * coordinates), drag existing points, right-click a point to remove it.
 * The zone applies to AI detections (box center) and is stored server-side.
 */
function ZoneEditor({ cameraId, zone, onChange }: {
  cameraId: string
  zone: Zone | null
  onChange: (zone: Zone | null) => void
}) {
  const [points, setPoints] = useState<[number, number][]>(zone?.points ?? [])
  const [editing, setEditing] = useState(false)
  const [snapUrl, setSnapUrl] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setPoints(zone?.points ?? []) }, [zone])

  const loadSnapshot = async () => {
    try {
      await api.snapshot(cameraId, 'zone-editor')
      const media = await api.media(cameraId, 'zone-editor')
      const latest = media.items?.[0]
      if (latest) setSnapUrl(`${latest.url}?t=${Date.now()}`)
    } catch { /* gated or offline */ }
  }

  const toNorm = (e: React.MouseEvent) => {
    const rect = boxRef.current?.getBoundingClientRect()
    if (!rect) return null
    return [
      Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    ] as [number, number]
  }

  const onBoxClick = (e: React.MouseEvent) => {
    if (!editing) return
    const p = toNorm(e)
    if (p) setPoints(prev => [...prev.slice(0, 31), p])
  }

  const save = async () => {
    try {
      const z = points.length >= 3 ? { points } : null
      await api.setCameraZone(cameraId, z)
      onChange(z)
      setEditing(false)
    } catch (e: any) { pushToastSafe(e) }
  }
  const clear = async () => {
    try {
      await api.setCameraZone(cameraId, null)
      setPoints([])
      onChange(null)
      setEditing(false)
    } catch (e: any) { pushToastSafe(e) }
  }
  const pushToastSafe = (e: any) => { console.warn('zone save failed', e) }

  return (
    <div>
      <div ref={boxRef} onClick={onBoxClick}
        className="relative w-full rounded-xl overflow-hidden cursor-crosshair"
        style={{ aspectRatio: '16/9', background: 'var(--bg-soft)' }}>
        {snapUrl && <img src={snapUrl} className="w-full h-full object-contain" draggable={false} alt="Zone backdrop" />}
        {!snapUrl && <div className="absolute inset-0 grid place-items-center muted text-xs">Load a snapshot to place the zone</div>}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
          {points.length >= 2 && (
            <polygon
              points={points.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')}
              fill="rgba(56,189,248,0.15)" stroke="rgba(56,189,248,0.9)" strokeWidth="0.5"
              strokeDasharray={editing ? '2 1.5' : undefined}
            />
          )}
          {points.map(([x, y], i) => (
            <circle key={i} cx={x * 100} cy={y * 100} r="0.9" fill="rgba(56,189,248,1)"
              style={{ pointerEvents: editing ? 'all' : 'none', cursor: 'pointer' }}
              onClick={e => {
                if (!editing) return
                e.stopPropagation()
                setPoints(prev => prev.filter((_, j) => j !== i))
              }} />
          ))}
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button className="btn" onClick={loadSnapshot}>Load snapshot</button>
        {!editing && (
          <button className="btn btn-primary" onClick={() => setEditing(true)}>
            {points.length ? 'Edit zone' : 'Draw zone'}
          </button>
        )}
        {editing && (
          <>
            <button className="btn btn-primary" onClick={save} disabled={points.length > 0 && points.length < 3}>
              Save ({points.length} pts)
            </button>
            <button className="btn" onClick={() => { setPoints(zone?.points ?? []); setEditing(false) }}>Cancel</button>
            {points.length > 0 && <button className="btn btn-danger" onClick={clear}>Remove zone</button>}
            <span className="muted text-xs">click = add point · click a point = remove it</span>
          </>
        )}
        {!editing && points.length === 0 && <span className="muted text-xs">No zone set — events cover the full frame.</span>}
      </div>
    </div>
  )
}
