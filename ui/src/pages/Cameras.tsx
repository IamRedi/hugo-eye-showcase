import { useCallback, useEffect, useState } from 'react'
import { api, type CapabilityMatrix } from '../api'
import { useApp } from '../state'
import { Card, Dot, Pill, SectionTitle, Toggle, Spinner } from '../components/ui'

export function Cameras() {
  const { cameras, refreshCameras, pushToast } = useApp()
  const camera = cameras[0]
  const [caps, setCaps] = useState<CapabilityMatrix | null>(null)
  const [settings, setSettings] = useState<any>(null)
  const [presets, setPresets] = useState<any[]>([])
  const [status, setStatus] = useState<any>(null)

  const load = useCallback(async () => {
    if (!camera) return
    try {
      const [c, s, p, st] = await Promise.all([
        api.cameraCapabilities(camera.id),
        api.cameraSettings(camera.id),
        api.presets(camera.id),
        api.cameraStatus(camera.id),
      ])
      setCaps(c)
      setSettings(s.settings)
      setPresets(p.presets)
      setStatus(st)
    } catch { /* */ }
  }, [camera])
  useEffect(() => { load() }, [load])

  if (!camera) return <Card>No camera configured.</Card>

  const patch = async (body: any, msg: string) => {
    try {
      await api.patchCameraSettings(camera.id, body)
      pushToast('ok', msg)
      load()
      refreshCameras()
    } catch (e: any) { pushToast('bad', e.message) }
  }

  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          <div className="w-14 h-14 rounded-2xl grid place-items-center text-2xl text-white"
            style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent-2))' }} aria-hidden>📷</div>
          <div className="flex-1 min-w-0">
            <input className="input text-lg font-semibold max-w-64" defaultValue={camera.name}
              aria-label="Camera name"
              onBlur={e => e.target.value !== camera.name && patch({ displayName: e.target.value }, 'Camera renamed')} />
            <div className="muted text-sm mt-1">{camera.model} · {camera.host} · RTSP {camera.rtspPort} · ONVIF {camera.onvifPort}</div>
          </div>
          <div className="flex items-center gap-2">
            <Dot ok={camera.health?.ok ?? null} />
            <span className="text-sm font-medium">{camera.health?.ok ? 'Online' : 'Offline'}</span>
          </div>
        </div>
        {camera.health && !camera.health.ok && (
          <div className="mt-3 text-sm" style={{ color: 'var(--bad)' }}>
            Connection issue — RTSP {camera.health.rtspOk ? 'ok' : 'unreachable'}, ONVIF {camera.health.onvifOk ? 'ok' : 'unreachable'} {camera.health.detail && `· ${camera.health.detail}`}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>Connection & live test</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <button className="btn" onClick={async () => {
            try {
              const st = await api.cameraStatus(camera.id)
              setStatus(st)
              pushToast('ok', `ONVIF position: pan ${st.position?.pan?.toFixed(3) ?? 'n/a'}, tilt ${st.position?.tilt?.toFixed(3) ?? 'n/a'}`)
            } catch (e: any) { pushToast('bad', e.message) }
          }}>Test ONVIF status</button>
          <button className="btn" onClick={async () => {
            try {
              const r = await api.snapshot(camera.id)
              pushToast('ok', `Snapshot ok · ${r.bytes} bytes in ${r.ms} ms`)
            } catch (e: any) { pushToast('bad', e.message) }
          }}>Test snapshot</button>
        </div>
        {status?.position && (
          <div className="muted text-xs mt-2">Position now: pan {status.position.pan.toFixed(3)} · tilt {status.position.tilt.toFixed(3)} · zoom {status.position.zoom?.toFixed(2)}</div>
        )}
      </Card>

      <Card>
        <SectionTitle>Presentation orientation <span className="normal-case font-normal">— fixes an inverted mount; applies everywhere; PTZ follows the display</span></SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          {[0, 90, 180, 270].map(r => (
            <button key={r} className={`btn ${settings?.rotate === r ? 'btn-primary' : ''}`}
              onClick={() => patch({ rotate: r }, `Rotation ${r}°`)}>{r}°</button>
          ))}
          <span className="w-px h-6 mx-1" style={{ background: 'var(--line)' }} />
          <span className="text-sm">Mirror</span>
          <Toggle checked={settings?.mirror ?? false} onChange={v => patch({ mirror: v }, v ? 'Mirrored' : 'Un-mirrored')} />
          <span className="text-sm ml-2">Flip</span>
          <Toggle checked={settings?.flip ?? false} onChange={v => patch({ flip: v }, v ? 'Flipped' : 'Un-flipped')} />
        </div>
      </Card>

      <Card>
        <SectionTitle>Privacy</SectionTitle>
        <div className="flex items-center gap-3">
          <Toggle checked={settings?.privacyDisabled ?? false}
            onChange={v => patch({ privacyDisabled: v }, v ? 'Camera privacy-blocked: streams, movement and captures disabled' : 'Camera unblocked')} />
          <div>
            <div className="text-sm font-medium">Privacy block</div>
            <div className="muted text-xs">When on, this camera refuses live view, snapshots, PTZ and recordings — even with recording enabled globally.</div>
          </div>
        </div>
      </Card>

      {caps && (
        <Card>
          <SectionTitle>Capability matrix <span className="normal-case font-normal">— {caps.model}</span></SectionTitle>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <div className="flex items-center gap-2 mb-2"><Pill kind="ok">Verified on hardware</Pill></div>
              <ul className="text-sm space-y-1.5">
                {caps.verified.map(c => <li key={c.id}>✓ {c.label} <span className="muted text-xs">({c.via})</span></li>)}
              </ul>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-2"><Pill kind="accent">Available (privacy-gated)</Pill></div>
              <ul className="text-sm space-y-1.5">
                {caps.available.map(c => (
                  <li key={c.id}>◦ {c.label} <span className="muted text-xs">({c.via} — requires “{c.gate}”)</span></li>
                ))}
              </ul>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-2"><Pill kind="warn">Unavailable via camera protocol</Pill></div>
              <ul className="text-sm space-y-1.5">
                {(caps.unavailable ?? caps.hardwareOnly ?? []).map(c => (
                  <li key={c.id}>✕ {c.label}
                    <div className="muted text-xs">{c.reason}</div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="muted text-xs mt-3">
            ONVIF profiles detected: {caps.profiles.join(', ') || '—'} ·
            Reported resolution: {caps.videoResolution ? `${caps.videoResolution.width}×${caps.videoResolution.height}` : 'not reported'}
          </p>
        </Card>
      )}

      <Card>
        <SectionTitle right={<span className="muted text-xs">positions are saved from the camera’s current view — never moved automatically</span>}>
          Stored positions ({presets.length})
        </SectionTitle>
        {presets.length === 0 && <p className="muted text-sm">No positions stored yet — use the Live page pad, then “Save current”.</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {presets.map(p => (
            <div key={p.id} className="flex items-center gap-2 p-2 rounded-xl" style={{ background: 'var(--bg-soft)' }}>
              <span className="text-sm font-medium flex-1 truncate">{p.name}</span>
              <span className="muted text-xs">pan {p.pan.toFixed(2)} · tilt {p.tilt.toFixed(2)}</span>
              <button className="btn btn-ghost text-xs" onClick={async () => {
                try { await api.gotoPreset(camera.id, p.id); pushToast('ok', `Moving to "${p.name}"`) } catch (e: any) { pushToast('bad', e.message) }
              }}>Go</button>
            </div>
          ))}
        </div>
      </Card>

      <RegistryCard />
    </div>
  )
}

type Reg = import('../api').RegistryCamera
type Probe = import('../api').ProbeResult

function RegistryCard() {
  const { pushToast } = useApp()
  const [cams, setCams] = useState<Reg[]>([])
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ id: '', host: '', username: '', password: '', name: '' })
  const [probe, setProbe] = useState<Probe | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = async () => { try { setCams((await api.registry()).cameras) } catch { /* */ } }
  useEffect(() => { load() }, [])

  const doProbe = async () => {
    setBusy(true); setProbe(null)
    try { setProbe((await api.probeCamera(form)).probe) } catch (e: any) { pushToast('bad', e.message) } finally { setBusy(false) }
  }
  const doCreate = async () => {
    setBusy(true)
    try {
      const r = await api.createCamera(form)
      if (r.ok) {
        pushToast('ok', `Camera "${r.camera?.name}" onboarded — restart the service to activate streaming for it`)
        setOpen(false); setForm({ id: '', host: '', username: '', password: '', name: '' }); setProbe(null)
        load()
      } else {
        pushToast('bad', r.error ?? 'onboarding failed')
        if (r.probe) setProbe(r.probe)
      }
    } catch (e: any) { pushToast('bad', e.message) } finally { setBusy(false) }
  }
  const doToggle = async (cam: Reg) => {
    await api.updateRegistryCamera(cam.id, { enabled: !cam.enabled }).catch(() => {})
    pushToast('ok', `${cam.name} ${cam.enabled ? 'disabled' : 'enabled'} — restart to apply`)
    load()
  }
  const doRemove = async (id: string) => {
    await api.removeRegistryCamera(id).catch(e => pushToast('bad', e.message))
    pushToast('ok', 'Camera removed from the registry')
    setConfirmDelete(null)
    load()
  }

  return (
    <Card>
      <SectionTitle right={
        <button className="btn btn-ghost text-xs" onClick={() => setOpen(o => !o)}>{open ? 'Close' : '+ Add camera'}</button>
      }>
        Camera registry <span className="normal-case font-normal">— onboard RTSP/ONVIF cameras; everything is verified before saving</span>
      </SectionTitle>
      <div className="flex flex-col gap-2">
        {cams.map(cam => (
          <div key={cam.id} className="flex items-center gap-3 p-2.5 rounded-xl" style={{ background: 'var(--bg-soft)' }}>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{cam.name} <span className="muted text-xs">({cam.id})</span></div>
              <div className="muted text-xs">{cam.model !== 'unknown' ? `${cam.model} · ` : ''}{cam.host}:{cam.rtspPort} · user {cam.username} · via {cam.source}</div>
            </div>
            <Pill kind={cam.enabled ? 'ok' : 'default'}>{cam.enabled ? 'enabled' : 'disabled'}</Pill>
            <button className="btn btn-ghost text-xs" onClick={() => doToggle(cam)}>{cam.enabled ? 'Disable' : 'Enable'}</button>
            {confirmDelete === cam.id
              ? <button className="btn text-xs" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }} onClick={() => doRemove(cam.id)}>Confirm remove</button>
              : <button className="btn btn-ghost text-xs" onClick={() => setConfirmDelete(cam.id)}>Remove</button>}
          </div>
        ))}
      </div>

      {open && (
        <div className="mt-3 p-3 rounded-xl space-y-2" style={{ background: 'var(--bg-soft)' }}>
          <div className="grid sm:grid-cols-2 gap-2">
            <input className="input text-sm" placeholder="id (e.g. garage)" value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} />
            <input className="input text-sm" placeholder="name (e.g. Garage)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            <input className="input text-sm" placeholder="host / IP" value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} />
            <input className="input text-sm" placeholder="username" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
            <input className="input text-sm" type="password" placeholder="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
          </div>
          <div className="flex gap-2">
            <button className="btn btn-ghost text-xs" onClick={doProbe} disabled={busy || !form.host || !form.username || !form.password}>
              {busy ? <Spinner /> : 'Test connection'}
            </button>
            <button className="btn btn-primary text-xs" onClick={doCreate} disabled={busy || !form.id || !form.host || !form.username || !form.password}>
              Onboard
            </button>
          </div>
          {probe && (
            <div className="text-xs mt-1 space-y-0.5">
              <div>{probe.ok ? '✅ verified' : '❌ not verified'} · RTSP TCP {probe.rtspTcp ? 'ok' : 'failed'}
                {probe.rtspStatus ? ` (RTSP ${probe.rtspStatus})` : ''}
                {probe.video ? ` · video ${probe.video}` : ''}{probe.audio ? ` · audio ${probe.audio}` : ''}
                {probe.onvifModel ? ` · ONVIF ${probe.onvifModel}` : ''}</div>
              {probe.errors.map((e, i) => <div key={i} className="muted">{e}</div>)}
            </div>
          )}
          <p className="muted text-xs">Credentials are stored locally on this appliance and never logged. New cameras start streaming after a service restart.</p>
        </div>
      )}
    </Card>
  )
}
