import { useEffect, useRef, useState } from 'react'
import { api, type OverlayTrack } from '../api'

/**
 * AiVisionOverlay (EYE-025 Layer 1+2) — product-grade AI HUD over the live feed.
 *
 * Polls /api/vision/overlay at 2 Hz and renders per tracked person:
 *  - corner-bracket tracking frames (amber=weak/possible, green=verified/tracked)
 *  - identity labels with safe wording (Redi / Redi (tracked) / Possibly Redi / Unknown)
 *  - posture · motion · facing caption
 *  - click-to-select feeds the identity detail panel
 *
 * Rendering: DOM + CSS transitions (smooth 0.45s interpolation between 2 Hz
 * samples), crisp text, no canvas raster — cheap on the mini-PC.
 */

const STATE_COLOR: Record<string, string> = {
  VERIFIED_FACE: 'var(--hud-green)',
  TRACKED_CONTINUITY: 'var(--hud-green)',
  POSSIBLE_MATCH: 'var(--amber)',
  UNKNOWN: 'var(--hud-neutral)',
}

const STATE_ICON: Record<string, string> = {
  VERIFIED_FACE: '✓',
  TRACKED_CONTINUITY: '⟳',
  POSSIBLE_MATCH: '?',
  UNKNOWN: '',
}

type Props = {
  cameraId: string
  active: boolean
  stale?: boolean
  selectedTrackId: number | null
  onSelect: (track: OverlayTrack | null) => void
}

export function AiVisionOverlay({ cameraId, active, stale = false, selectedTrackId, onSelect }: Props) {
  const [tracks, setTracks] = useState<OverlayTrack[]>([])
  const [error, setError] = useState<string | null>(null)
  const [latency, setLatency] = useState<number | null>(null)
  const boxRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  useEffect(() => {
    if (!active || !cameraId) return
    let alive = true
    let timer: any = null
    const poll = async () => {
      const t0 = performance.now()
      try {
        const d = await api.visionOverlay(cameraId)
        if (!alive) return
        setTracks(d.tracks ?? [])
        setError(null)
        setLatency(Math.round(performance.now() - t0))
      } catch (e: any) {
        if (alive) setError(e.message)
      } finally {
        if (alive) timer = setTimeout(poll, 500)
      }
    }
    poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [active, cameraId])

  if (!active) return null

  return (
    <div className="absolute inset-0 pointer-events-none select-none" data-testid="ai-overlay">
      {/* subtle top vignette so HUD text stays readable on bright scenes */}
      <div className="absolute inset-x-0 top-0 h-16" style={{ background: 'linear-gradient(rgba(4,8,18,0.55), transparent)' }} />
      <div className="absolute inset-x-0 bottom-0 h-20" style={{ background: 'linear-gradient(transparent, rgba(4,8,18,0.45))' }} />

      {stale && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 glass rounded-xl px-4 py-2.5 hud-fade text-center">
          <div className="hud-label" style={{ color: 'var(--amber)' }}>video stale</div>
          <div className="text-xs text-white/80 mt-0.5">reconnecting — tracking paused</div>
        </div>
      )}

      {tracks.map(t => {
        const color = STATE_COLOR[t.identity.state] ?? 'var(--hud-neutral)'
        const selected = selectedTrackId === t.trackId
        if (stale) return null   // never paint live boxes over a frozen frame
        const pct = {
          left: `${t.box.x * 100}%`,
          top: `${t.box.y * 100}%`,
          width: `${t.box.w * 100}%`,
          height: `${t.box.h * 100}%`,
        }
        return (
          <div key={t.trackId} className={`track-frame hud-fade ${selected ? 'ring-1 ring-white/60 rounded' : ''}`}
            style={{ ...pct, color }}>
            <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
            <span className="edge" />
            {/* identity tag */}
            <button
              className="pointer-events-auto absolute -top-7 left-0 flex items-center gap-1.5 px-2 py-1 rounded-md glass whitespace-nowrap"
              style={{ color, borderColor: selected ? 'rgba(255,255,255,0.35)' : undefined }}
              onClick={() => onSelect(selected ? null : t)}
              data-testid={`track-${t.trackId}`}>
              <span className="text-[11px] font-semibold" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.8)' }}>
                {STATE_ICON[t.identity.state] ? `${STATE_ICON[t.identity.state]} ` : ''}{t.identity.label}
              </span>
              {t.identity.state === 'VERIFIED_FACE' && <span className="hud-label" style={{ color }}>verified</span>}
              {t.identity.state === 'TRACKED_CONTINUITY' && <span className="hud-label" style={{ color }}>tracked</span>}
              {t.identity.state === 'POSSIBLE_MATCH' && <span className="hud-label" style={{ color }}>unverified</span>}
            </button>
            {/* posture · motion caption */}
            <div className="absolute -bottom-6 left-0 flex items-center gap-2 px-1.5 py-0.5 rounded-md text-[10px]"
              style={{ color: 'var(--hud-neutral)', textShadow: '0 1px 5px rgba(0,0,0,0.9)' }}>
              <span className="hud-label">{t.posture}</span>
              <span>·</span>
              <span className="hud-label">{t.motion}</span>
              <span>·</span>
              <span className="hud-label">{t.facing}</span>
            </div>
          </div>
        )
      })}

      {/* HUD status strip (top-left) */}
      <div className="absolute top-3 left-3 flex items-center gap-2 hud-fade">
        <div className="glass rounded-lg px-2.5 py-1.5 flex items-center gap-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: 'var(--amber)', boxShadow: '0 0 8px var(--amber-glow)' }} />
          <span className="hud-label" style={{ color: 'var(--amber)' }}>AI VISION</span>
        </div>
        {tracks.length > 0 && (
          <div className="glass rounded-lg px-2.5 py-1.5 hud-label">
            {tracks.length} tracked
          </div>
        )}
      </div>

      {/* engine latency (small, honest, unobtrusive) */}
      <div className="absolute top-3 right-3 glass rounded-lg px-2 py-1 hud-label" style={{ opacity: 0.7 }}>
        overlay {latency !== null ? `${latency} ms` : '…'} · 2 Hz
      </div>

      {error && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 glass rounded-lg px-3 py-1.5 text-xs" style={{ color: 'var(--hud-red)' }}>
          overlay feed: {error}
        </div>
      )}
      {tracks.length === 0 && !error && !stale && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 glass rounded-lg px-3 py-1.5 hud-label hud-fade">
          no person tracked
        </div>
      )}
    </div>
  )
}

/**
 * Identity detail panel (EYE-025 H) — glass side panel for the selected track.
 */
export function IdentityDetailPanel({ track, onClose }: { track: OverlayTrack; onClose: () => void }) {
  const color = STATE_COLOR[track.identity.state] ?? 'var(--hud-neutral)'
  const fields: [string, string][] = [
    ['identity basis', track.identity.basis ?? '—'],
    ['track id', `#${track.trackId}`],
    ['tracked for', track.identity.trackAgeMs != null ? `${Math.round(track.identity.trackAgeMs / 1000)} s` : '—'],
    ['posture', track.posture ?? '—'],
    ['motion', track.motion ?? '—'],
    ['facing', track.facing ?? '—'],
    ['face confidence', track.identity.score != null ? track.identity.score.toFixed(3) : 'not face-verified'],
    ['last verified', track.identity.verifiedAt ? new Date(track.identity.verifiedAt).toLocaleTimeString() : '—'],
    ['re-entered', track.identity.reentered ? 'yes (position hint)' : 'no'],
  ]
  return (
    <div className="absolute top-14 right-3 w-72 glass rounded-xl p-4 hud-fade pointer-events-auto" data-testid="identity-panel">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-sm font-semibold" style={{ color }}>{track.identity.label}</div>
          <div className="hud-label mt-0.5">{track.identity.state.replaceAll('_', ' ').toLowerCase()}</div>
        </div>
        <button className="text-xs muted hover:text-white" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="space-y-2">
        {fields.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3">
            <span className="hud-label shrink-0">{k}</span>
            <span className="text-xs text-right truncate" style={{ color: 'var(--text)' }}>{v}</span>
          </div>
        ))}
      </div>
      <p className="text-[10px] muted mt-3 leading-relaxed">
        Labels reflect evidence only: verified faces, tracked continuity, or explicit
        possibilities. Movement-style support is experimental and never shown as identity.
      </p>
    </div>
  )
}
