import { useCallback, useEffect, useRef, useState } from 'react'
import { api, fmtBytes } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/ui'

/** Compact Panel Mode — wall-mounted screens. Live picture, essential controls. */
export function Panel() {
  const { cameras, pushToast } = useApp()
  const camera = cameras[0]
  const [src, setSrc] = useState<string | null>(null)
  const [online, setOnline] = useState(false)
  const [now, setNow] = useState(new Date())
  const [showControls, setShowControls] = useState(true)
  const [scene, setScene] = useState<any>(null)
  const hideTimer = useRef<any>(null)
  const retry = useRef<any>(null)

  const restart = useCallback(async () => {
    if (!camera) return
    try {
      setSrc(await api.streamUrl(camera.id))
    } catch { /* retry below */ }
  }, [camera])

  useEffect(() => { restart() }, [restart, camera?.id])
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!camera) return
    let cancelled = false
    const poll = async () => {
      try {
        const r = await api.visionScene()
        const mine = (r.scene ?? []).find(s => s.cameraId === camera.id)
        if (!cancelled && mine) setScene(mine)
      } catch { /* offline */ }
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { cancelled = true; clearInterval(t) }
  }, [camera])

  // auto-hide controls
  const wake = useCallback(() => {
    setShowControls(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setShowControls(false), 5000)
  }, [])
  useEffect(() => {
    wake()
    window.addEventListener('pointermove', wake)
    window.addEventListener('keydown', wake)
    return () => {
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('keydown', wake)
    }
  }, [wake])

  if (!camera) return <div className="h-full grid place-items-center muted">No camera</div>

  return (
    <div className="h-full relative bg-black overflow-hidden"
      onPointerMove={wake} onPointerDown={wake}>
      {/* condensed intelligence status */}
      <div className="absolute top-4 right-4 z-10 flex flex-col items-end gap-2">
        <div className="px-3 py-1.5 rounded-xl text-sm font-medium flex items-center gap-2"
          style={{ background: 'rgba(0,0,0,0.55)', color: '#fff' }}>
          {scene?.fresh
            ? (scene.personCount > 0
              ? <>{scene.personCount} person{scene.personCount > 1 ? 's' : ''}{scene.knownPersons.length ? ` — ${scene.knownPersons.map((k: any) => k.name).join(', ')}` : ' detected'}</>
              : 'Nobody detected')
            : 'Scene unknown'}
        </div>
      </div>
      {src && (
        <img src={src} alt="Live view" className="absolute inset-0 w-full h-full object-cover"
          onLoad={() => setOnline(true)}
          onError={() => {
            setOnline(false)
            clearTimeout(retry.current)
            retry.current = setTimeout(restart, 3000)
          }} />
      )}

      {/* top overlay */}
      <div className={`absolute top-0 inset-x-0 p-4 flex items-start justify-between transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0'}`}
        style={{ background: 'linear-gradient(rgba(0,0,0,0.55), transparent)' }}>
        <div className="text-white">
          <div className="text-3xl font-bold tabular-nums">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          <div className="text-white/70 text-sm">{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`pill ${online ? 'pill-ok' : 'pill-bad'}`} style={{ background: 'rgba(0,0,0,0.4)' }}>
            {online ? 'live' : 'offline'}
          </span>
          <span className="pill" style={{ background: 'rgba(0,0,0,0.4)', color: '#fff' }}>{camera.name}</span>
        </div>
      </div>

      {/* bottom controls */}
      <div className={`absolute bottom-0 inset-x-0 p-4 flex items-center gap-2 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0'}`}
        style={{ background: 'linear-gradient(transparent, rgba(0,0,0,0.6))' }}>
        <button className="btn btn-primary" onClick={async () => {
          try { const r = await api.snapshot(camera.id); pushToast('ok', `Snapshot saved`) } catch { pushToast('bad', 'Snapshot failed') }
        }}>Snapshot</button>
        <div className="flex gap-1.5">
          {(camera as any)._presetsLoaded !== true && null}
          <PresetQuickButtons cameraId={camera.id} onMove={name => pushToast('ok', `Moving to ${name}`)} />
        </div>
        <div className="flex-1" />
        <a className="btn" href="/" style={{ background: 'rgba(0,0,0,0.4)', color: '#fff', borderColor: 'rgba(255,255,255,0.25)' }}>
          <Icon name="settings" size={16} /> Full app
        </a>
      </div>
    </div>
  )
}

function PresetQuickButtons({ cameraId, onMove }: { cameraId: string; onMove: (name: string) => void }) {
  const [presets, setPresets] = useState<any[]>([])
  useEffect(() => {
    api.presets(cameraId).then(d => setPresets(d.presets)).catch(() => {})
  }, [cameraId])
  return (
    <>
      {presets.slice(0, 4).map(p => (
        <button key={p.id} className="btn"
          style={{ background: 'rgba(0,0,0,0.4)', color: '#fff', borderColor: 'rgba(255,255,255,0.25)' }}
          onClick={async () => {
            try { await api.gotoPreset(cameraId, p.id); onMove(p.name) } catch { /* */ }
          }}>{p.name}</button>
      ))}
    </>
  )
}
