import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, fmtBytes } from '../api'
import { useApp } from '../state'
import { Card } from '../components/ui'
import { useLivePlayer } from '../components/LivePlayer'
import { AiVisionOverlay, IdentityDetailPanel } from '../components/AiVisionOverlay'
import type { OverlayTrack } from '../api'

export function Live() {
  const { cameras, refreshCameras, pushToast } = useApp()
  const camera = cameras[0]
  const [quality, setQuality] = useState<'sub' | 'main'>('sub')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [showOrientation, setShowOrientation] = useState(false)
  const [showPresets, setShowPresets] = useState(false)
  const [showPad, setShowPad] = useState(() => typeof window === 'undefined' || window.innerWidth >= 640)
  const [showInfo, setShowInfo] = useState(false)
  const [audioOn, setAudioOn] = useState(false)
  const [presets, setPresets] = useState<any[]>([])
  const [recording, setRecording] = useState<{ recording: boolean; startedAt: string | null }>({ recording: false, startedAt: null })
  const [settings, setSettings] = useState<any>(null)
  const [productSettings, setProductSettings] = useState<any>(null)
  const [hubState, setHubState] = useState<string | null>(null)
  const [visionMode, setVisionMode] = useState<'normal' | 'ai'>('normal')
  const [selectedTrack, setSelectedTrack] = useState<OverlayTrack | null>(null)
  const [followState, setFollowState] = useState<string>('idle')
  const viewerRef = useRef<HTMLDivElement>(null)
  const player = useLivePlayer(camera?.id, quality)
  const restartStream = player.restart
  const videoStalled = player.stalled
  const streamState = player.state
  const startupMs = player.startedAt

  const loadPresets = useCallback(async () => {
    if (!camera) return
    try { setPresets((await api.presets(camera.id)).presets) } catch { /* unauthorized */ }
  }, [camera])
  useEffect(() => { loadPresets() }, [loadPresets])

  // recording + settings poll
  useEffect(() => {
    if (!camera) return
    let cancelled = false
    const tick = async () => {
      try {
        const status = await api.cameraStatus(camera.id)
        if (!cancelled) setRecording(status.recording ?? { recording: false, startedAt: null })
        const cs = await api.cameraSettings(camera.id)
        if (!cancelled) setSettings(cs.settings)
        const ps = await api.settings()
        if (!cancelled) setProductSettings(ps.settings)
        const cams = await api.cameras()
        const me = cams.cameras.find(c => c.id === camera.id)
        if (!cancelled) setHubState(me?.stream?.sub?.state ?? null)
      } catch { /* offline poll */ }
    }
    tick()
    const timer = setInterval(tick, 5000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [camera])

  // follow status poll (cheap)
  useEffect(() => {
    if (!camera) return
    let alive = true
    const tick = () => api.followStatus(camera.id)
      .then(r => { if (alive) setFollowState(r.follow.state) })
      .catch(() => {})
    tick()
    const t = setInterval(tick, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [camera])

  const startFollow = async (trackId: number) => {
    if (!camera) return
    try {
      const r = await api.follow(camera.id, { trackId })
      if (r.ok) pushToast('ok', `Following person (track ${r.trackId}) — manual PTZ takes over anytime`)
      else pushToast('warn', r.error ?? 'could not start following')
    } catch (e: any) { pushToast('bad', e.message) }
  }
  const stopFollow = async () => {
    if (!camera) return
    await api.followStop(camera.id).catch(() => {})
    pushToast('ok', 'Auto-follow stopped')
  }

  // PTZ: hold to move (refresh command before the 1 s camera timeout), stop on release
  const holdRef = useRef<{ timer: any; command: string } | null>(null)
  const ptzStart = useCallback(async (command: string) => {
    if (!camera || holdRef.current) return
    holdRef.current = { timer: null, command }
    const send = () => api.ptz(camera.id, command).catch(() => {})
    await send()
    holdRef.current.timer = setInterval(send, 700)
  }, [camera])
  const ptzStop = useCallback(async () => {
    if (!holdRef.current || !camera) return
    clearInterval(holdRef.current.timer)
    holdRef.current = null
    try { await api.ptz(camera.id, 'stop') } catch { /* best effort */ }
  }, [camera])

  // keyboard PTZ
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      const map: Record<string, string> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
      const cmd = map[e.key]
      if (cmd && !e.repeat) { e.preventDefault(); ptzStart(cmd) }
    }
    const up = (e: KeyboardEvent) => {
      const map: Record<string, string> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
      if (map[e.key]) ptzStop()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [ptzStart, ptzStop])

  // digital zoom: wheel over viewer
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    setZoom(z => Math.min(4, Math.max(1, z - Math.sign(e.deltaY) * 0.25)))
  }
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    if (zoom > 1) { dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y } }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragRef.current) {
      setPan({
        x: Math.max(-400, Math.min(400, e.clientX - dragRef.current.x)),
        y: Math.max(-260, Math.min(260, e.clientY - dragRef.current.y)),
      })
    }
  }
  const onPointerUp = () => { dragRef.current = null }

  const snapshot = async () => {
    if (!camera) return
    try {
      const r = await api.snapshot(camera.id)
      pushToast('ok', `Snapshot saved · ${fmtBytes(r.bytes)}`)
    } catch (e: any) { pushToast('bad', `Snapshot failed: ${e.message}`) }
  }

  const toggleRecording = async () => {
    if (!camera) return
    try {
      if (recording.recording) {
        await api.stopRecording(camera.id)
        pushToast('ok', 'Recording stopped and finalized')
      } else {
        await api.startRecording(camera.id)
        pushToast('ok', 'Recording started')
      }
    } catch (e: any) { pushToast('bad', e.message) }
    refreshCameras()
  }

  const patchOrientation = async (patch: any) => {
    if (!camera) return
    try {
      const r = await api.patchCameraSettings(camera.id, patch)
      setSettings(r.settings)
      pushToast('ok', 'Orientation updated — restarting stream')
      restartStream()
      refreshCameras()
    } catch (e: any) { pushToast('bad', e.message) }
  }

  const savePreset = async () => {
    if (!camera) return
    const name = prompt('Name for the current position:')
    if (!name) return
    try {
      await api.createPreset(camera.id, { name, captureZone: 'camera' })
      pushToast('ok', `Position "${name}" saved (camera did not move)`)
      loadPresets()
    } catch (e: any) { pushToast('bad', e.message) }
  }

  const fullscreen = () => viewerRef.current?.requestFullscreen?.()

  if (!camera) {
    return <Card>No camera configured.</Card>
  }

  const rotate = settings?.rotate ?? camera.orientation.rotate ?? 180
  const mirror = settings?.mirror ?? false
  const flip = settings?.flip ?? false
  const transform = `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px) rotate(${rotate}deg)${mirror ? ' scaleX(-1)' : ''}${flip ? ' scaleY(-1)' : ''}`

  return (
    <div className="relative w-full overflow-hidden rounded-2xl bg-black select-none"
      style={{ aspectRatio: '16 / 9', maxHeight: 'calc(100vh - 6.5rem)' }} data-testid="live-root">
      {/* ---------- video layer ---------- */}
      <div ref={viewerRef} className="absolute inset-0"
        onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
        <video ref={player.videoRef} playsInline muted
          className={`w-full h-full object-contain ${player.transport === 'mse' ? '' : 'hidden'}`}
          style={{ transform, transition: dragRef.current ? 'none' : 'transform 150ms ease-out' }} />
        {player.transport === 'mjpeg' && player.mjpegSrc && (
          <img src={player.mjpegSrc} className="w-full h-full object-contain"
            style={{ transform, transition: dragRef.current ? 'none' : 'transform 150ms ease-out' }}
            onLoad={player.onMjpegLoad} onError={player.onMjpegError}
            alt="Live view" draggable={false} />
        )}
      </div>

      {/* ---------- AI Vision overlay ---------- */}
      <AiVisionOverlay cameraId={camera.id} active={visionMode === 'ai' && streamState !== 'offline'}
        stale={videoStalled}
        selectedTrackId={selectedTrack?.trackId ?? null} onSelect={setSelectedTrack} />
      {videoStalled && streamState === 'live' && visionMode === 'normal' && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 glass rounded-xl px-4 py-2.5 hud-fade text-center">
          <div className="hud-label" style={{ color: 'var(--amber)' }}>video stale</div>
          <div className="text-xs text-white/80 mt-0.5">reconnecting…</div>
        </div>
      )}
      {visionMode === 'ai' && selectedTrack && (
        <IdentityDetailPanel track={selectedTrack} onClose={() => setSelectedTrack(null)} />
      )}

      {/* ---------- top-left: identity / status chips ---------- */}
      <div className="absolute top-3 left-3 flex items-center gap-2">
        <div className="glass rounded-lg px-2.5 py-1.5 flex items-center gap-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: camera.health?.ok ? 'var(--hud-green)' : 'var(--hud-red)', boxShadow: `0 0 8px ${camera.health?.ok ? 'rgba(52,211,153,0.5)' : 'rgba(248,113,113,0.5)'}` }} />
          <span className="text-xs font-medium text-white/95">{camera.name}</span>
        </div>
        {recording.recording && (
          <div className="glass rounded-lg px-2.5 py-1.5 flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--hud-red)' }} />
            <span className="hud-label" style={{ color: '#fff' }}>REC</span>
          </div>
        )}
        {(followState === 'following' || followState === 'returning') && (
          <button className="glass rounded-lg px-2.5 py-1.5 flex items-center gap-2" onClick={stopFollow}
            title="Auto-follow is active — click to stop">
            <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--amber)' }} />
            <span className="hud-label" style={{ color: 'var(--amber)' }}>FOLLOWING · STOP</span>
          </button>
        )}
      </div>

      {/* ---------- top-right: mode toggle ---------- */}
      <div className="absolute top-3 right-3 glass rounded-xl p-1 flex" data-testid="mode-toggle">
        {(['normal', 'ai'] as const).map(m => (
          <button key={m} data-testid={`mode-${m}`}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
            style={visionMode === m
              ? { background: m === 'ai' ? 'var(--amber)' : 'rgba(255,255,255,0.16)', color: m === 'ai' ? '#1a1206' : '#fff' }
              : { color: 'rgba(255,255,255,0.75)' }}
            onClick={() => { setVisionMode(m); if (m === 'normal') setSelectedTrack(null) }}>
            {m === 'normal' ? 'NORMAL' : 'AI VISION'}
          </button>
        ))}
      </div>

      {/* ---------- offline / connecting ---------- */}
      {streamState === 'offline' && (
        <div className="absolute inset-0 grid place-items-center" style={{ background: 'rgba(4,8,18,0.72)' }}>
          <div className="text-center">
            <div className="hud-label mb-3" style={{ color: 'var(--hud-red)' }}>camera stream offline</div>
            <button className="btn" onClick={restartStream}>Retry now</button>
            <div className="muted text-xs mt-2">Auto-retrying every 2 s</div>
          </div>
        </div>
      )}
      {streamState === 'connecting' && (
        <div className="absolute inset-0 grid place-items-center" style={{ background: 'rgba(4,8,18,0.45)' }}>
          <div className="glass rounded-lg px-4 py-2 hud-label" style={{ color: 'var(--amber)' }}>connecting…</div>
        </div>
      )}

      {/* ---------- bottom control bar ---------- */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 glass rounded-2xl px-2 py-1.5 flex items-center gap-1 max-w-[97%] overflow-x-auto">
        <CtlBtn label="Snapshot" icon="◎" onClick={snapshot} />
        {productSettings?.privacy.recordingEnabled ? (
          <CtlBtn label={recording.recording ? 'Stop rec' : 'Record'} icon={recording.recording ? '■' : '●'}
            danger={recording.recording} onClick={toggleRecording} />
        ) : (
          <Link to="/settings" className="ctl-btn opacity-50" title="Enable recording in Settings → Privacy">🔒 Rec</Link>
        )}
        <span className="w-px h-6 mx-0.5" style={{ background: 'rgba(255,255,255,0.12)' }} />
        <div className="flex rounded-xl overflow-hidden">
          {(['sub', 'main'] as const).map(q => (
            <button key={q} className="px-2.5 py-1.5 text-xs transition-colors rounded-lg"
              style={quality === q ? { background: 'rgba(255,255,255,0.16)', color: '#fff' } : { color: 'rgba(255,255,255,0.65)' }}
              onClick={() => setQuality(q)}>
              {q === 'sub' ? 'Preview' : 'Full'}
            </button>
          ))}
        </div>
        <span className="w-px h-6 mx-0.5" style={{ background: 'rgba(255,255,255,0.12)' }} />
        <CtlBtn label="PTZ" icon="✥" active={showPad} onClick={() => setShowPad(v => !v)} />
        <CtlBtn label="Positions" icon="⌖" active={showPresets} onClick={() => setShowPresets(v => !v)} />
        <CtlBtn label="Orientation" icon="⟳" active={showOrientation} onClick={() => setShowOrientation(v => !v)} />
        {productSettings?.privacy.microphoneEnabled ? (
          <CtlBtn label="Listen" icon="🎧" active={audioOn} onClick={() => setAudioOn(v => !v)} />
        ) : (
          <Link to="/settings" className="ctl-btn opacity-50" title="Enable microphone in Settings → Privacy">🔒 🎧</Link>
        )}
        <CtlBtn label="Fullscreen" icon="⛶" onClick={fullscreen} />
        <CtlBtn label="Info" icon="i" active={showInfo} onClick={() => setShowInfo(v => !v)} />
      </div>

      {audioOn && <audio autoPlay src={`/api/cameras/${camera.id}/audio.wav`} onError={() => { setAudioOn(false); pushToast('bad', 'Audio stream unavailable') }} />}
      {zoom > 1 && (
        <button className="absolute bottom-20 right-3 glass rounded-lg px-2.5 py-1 text-xs text-white"
          onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>
          {zoom.toFixed(2)}× · reset
        </button>
      )}

      {/* ---------- PTZ pad (floating, bottom-right) ---------- */}
      {showPad && (
        <div className="absolute bottom-20 right-2 sm:right-3 glass rounded-2xl p-2 sm:p-3 hud-fade origin-bottom-right scale-90 sm:scale-100">
          <div className="grid grid-cols-3 gap-1.5 w-[140px] sm:w-[168px] select-none">
            <PadBtn command="up_left" onStart={ptzStart} onStop={ptzStop} label="↖" />
            <PadBtn command="up" onStart={ptzStart} onStop={ptzStop} label="↑" />
            <PadBtn command="up_right" onStart={ptzStart} onStop={ptzStop} label="↗" />
            <PadBtn command="left" onStart={ptzStart} onStop={ptzStop} label="←" />
            <PadBtn command="stop" onStart={() => ptzStop()} onStop={() => {}} label="■" primary />
            <PadBtn command="right" onStart={ptzStart} onStop={ptzStop} label="→" />
            <PadBtn command="down_left" onStart={ptzStart} onStop={ptzStop} label="↙" />
            <PadBtn command="down" onStart={ptzStart} onStop={ptzStop} label="↓" />
            <PadBtn command="down_right" onStart={ptzStart} onStop={ptzStop} label="↘" />
          </div>
          <div className="flex gap-1.5 mt-2">
            <PadBtn command="zoom_in" onStart={ptzStart} onStop={ptzStop} label="Zoom +" wide />
            <PadBtn command="zoom_out" onStart={ptzStart} onStop={ptzStop} label="Zoom −" wide />
          </div>
          <p className="hud-label mt-2 text-center" style={{ opacity: 0.6 }}>arrow keys work too</p>
        </div>
      )}

      {/* ---------- presets popover (floating, left) ---------- */}
      {showPresets && (
        <div className="absolute bottom-20 left-3 w-64 glass rounded-2xl p-3 hud-fade">
          <div className="flex items-center justify-between mb-2">
            <span className="hud-label">saved positions</span>
            <button className="text-xs text-white/70 hover:text-white" onClick={savePreset}>+ save current</button>
          </div>
          {presets.length === 0 && <p className="text-xs muted">No positions yet.</p>}
          <div className="flex flex-col gap-1">
            {presets.map(p => (
              <div key={p.id} className="flex items-center gap-1.5">
                <button className="flex-1 text-left px-2 py-1.5 rounded-lg text-xs text-white/90 hover:bg-white/10 transition-colors"
                  onClick={async () => {
                    try { await api.gotoPreset(camera.id, p.id); pushToast('ok', `Moving to "${p.name}"`) } catch (e: any) { pushToast('bad', e.message) }
                  }}>
                  {p.name}
                  {p.timelapseEnabled && <span className="hud-label ml-2" style={{ color: 'var(--amber)' }}>tl</span>}
                </button>
                <button className="text-xs text-white/50 hover:text-white px-1" aria-label={`Delete ${p.name}`} onClick={async () => {
                  if (!confirm(`Delete position "${p.name}"?`)) return
                  await api.deletePreset(camera.id, p.id); loadPresets()
                }}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------- orientation popover ---------- */}
      {showOrientation && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 glass rounded-2xl p-4 hud-fade w-80">
          <div className="hud-label mb-2">presentation orientation</div>
          <div className="flex flex-wrap items-center gap-2">
            {[0, 90, 180, 270].map(r => (
              <button key={r} className="px-3 py-1.5 rounded-lg text-xs text-white/85 transition-colors"
                style={rotate === r ? { background: 'var(--amber)', color: '#1a1206' } : { background: 'rgba(255,255,255,0.08)' }}
                onClick={() => patchOrientation({ rotate: r })}>
                {r}°
              </button>
            ))}
            <span className="w-px h-5 mx-1" style={{ background: 'rgba(255,255,255,0.15)' }} />
            <button className="px-3 py-1.5 rounded-lg text-xs text-white/85"
              style={{ background: mirror ? 'var(--amber)' : 'rgba(255,255,255,0.08)', color: mirror ? '#1a1206' : '#fff' }}
              onClick={() => patchOrientation({ mirror: !mirror })}>Mirror</button>
            <button className="px-3 py-1.5 rounded-lg text-xs text-white/85"
              style={{ background: flip ? 'var(--amber)' : 'rgba(255,255,255,0.08)', color: flip ? '#1a1206' : '#fff' }}
              onClick={() => patchOrientation({ flip: !flip })}>Flip</button>
          </div>
          <p className="text-[10px] muted mt-2">Applied to live, snapshots and recordings. This camera is mounted upside-down — 180° is its factory default.</p>
        </div>
      )}

      {/* ---------- info popover ---------- */}
      {showInfo && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 glass rounded-2xl p-4 hud-fade w-80 text-xs space-y-1.5">
          <div className="hud-label mb-1">stream health</div>
          {[
            ['transport', player.transport === 'mse' ? 'RTSP → relay → MSE · fMP4' : 'RTSP → relay → MJPEG'],
            ['state', streamState],
            ['relay', hubState ?? '—'],
            ['orientation', `rotate ${rotate}°${mirror ? ' · mirrored' : ''}${flip ? ' · flipped' : ''}`],
            ['quality', quality === 'main' ? 'main · full resolution' : 'sub · preview'],
            ['startup', startupMs && streamState === 'live' ? `${((Date.now() - startupMs) / 1000).toFixed(1)}s` : '—'],
            ['ptz', camera.capabilities.ptz ? 'ready' : 'n/a'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <span className="hud-label">{k}</span>
              <span className="text-white/85">{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CtlBtn({ label, icon, onClick, active, danger }: {
  label: string; icon: string; onClick: () => void; active?: boolean; danger?: boolean
}) {
  return (
    <button onClick={onClick} title={label}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium transition-colors whitespace-nowrap"
      style={danger
        ? { background: 'rgba(248,113,113,0.2)', color: 'var(--hud-red)' }
        : active
          ? { background: 'rgba(255,181,71,0.18)', color: 'var(--amber)' }
          : { color: 'rgba(255,255,255,0.82)' }}>
      <span className="text-sm leading-none">{icon}</span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

function PadBtn({ command, onStart, onStop, label, wide, primary }: {
  command: string; onStart: (c: string) => void; onStop: () => void; label: string; wide?: boolean; primary?: boolean
}) {
  const [held, setHeld] = useState(false)
  const start = () => { setHeld(true); if (command !== 'stop') onStart(command); else onStop() }
  const end = () => { setHeld(false); onStop() }
  return (
    <button
      className={`rounded-xl transition-colors ${wide ? 'flex-1 py-1.5 text-xs' : 'py-2 text-sm'} font-medium`}
      style={primary
        ? { background: 'var(--amber)', color: '#1a1206' }
        : held
          ? { background: 'var(--amber)', color: '#1a1206' }
          : { background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)' }}
      onPointerDown={start}
      onPointerUp={end}
      onPointerLeave={end}
      onPointerCancel={end}
      aria-label={command}
    >{label}</button>
  )
}
