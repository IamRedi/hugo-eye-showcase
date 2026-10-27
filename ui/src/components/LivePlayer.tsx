import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

export type Transport = 'mse' | 'mjpeg'

/**
 * Live player: prefers the low-latency MSE/fMP4 path (H.264 copied from the
 * relay hub, near-zero CPU) and falls back to the proven MJPEG pipeline.
 * The fMP4 stream is fetched same-origin (cookie-authenticated) and fed to
 * MediaSource; the live edge is chased so playback stays within a fragment
 * of real time. Orientation is applied by the caller via CSS transform.
 *
 * EYE-025 hardening (browser-verified freeze class): recovery must never
 * depend on a single MSE attempt's internals. An attempt can wedge below
 * JS visibility (a sourceopen that never opens in a torn-down element,
 * a play() promise that never settles) and take its per-attempt watchdog
 * with it. Therefore:
 *  - every attempt is deadline-bounded — a wedged attempt is abandoned and
 *    its resources released, so restart()/fallback always make progress;
 *  - the fetch reader is cancelled on teardown (no leaked stream slots —
 *    the server caps concurrent streams per client);
 *  - a component-level supervisor survives across attempts: a visible page
 *    whose "live" MSE video does not advance gets rebuilt, and repeated MSE
 *    failures escalate to MJPEG through the existing per-attempt watchdog.
 */
export function useLivePlayer(cameraId: string | undefined, quality: 'sub' | 'main') {
  const [transport, setTransport] = useState<Transport | null>(null)
  const [mjpegSrc, setMjpegSrc] = useState<string | null>(null)
  const [state, setState] = useState<'connecting' | 'live' | 'offline'>('connecting')
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [stalled, setStalled] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const retry = useRef<any>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const restartRef = useRef<() => void>(() => {})
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
  const transportRef = useRef<Transport | null>(null)
  const attemptStartedAtRef = useRef(0)
  const attemptGenRef = useRef(0)

  const startMjpeg = useCallback(async (): Promise<boolean> => {
    if (!cameraId) return false
    try {
      let url: string
      try {
        url = await api.streamUrl(cameraId, quality)   // grant-based (same-origin UIs)
      } catch {
        url = api.mjpegCookieUrl(cameraId, quality)    // cookie-auth (cross-origin dev UIs)
      }
      transportRef.current = 'mjpeg'
      readerRef.current = null
      setTransport('mjpeg')
      setStartedAt(Date.now())
      setMjpegSrc(url)
      setStalled(false)
      return true
    } catch {
      setState('offline')   // honest state; the caller/watchdog retries
      return false
    }
  }, [cameraId, quality])

  /** Reads the H.264 profile/level from the fMP4 init segment's avcC box. */
  function avcCodecFromInit(init: Uint8Array): string | null {
    // avcC payload: [version][profile][compat][level] — findBox returns the
    // payload start, so the profile byte sits one past it.
    const idx = findBox(init, 'avcC')
    if (idx === -1 || idx + 3 > init.length) return null
    const hex = (v: number) => v.toString(16).padStart(2, '0')
    return `avc1.${hex(init[idx + 1])}${hex(init[idx + 2])}${hex(init[idx + 3])}`
  }

  function findBox(buf: Uint8Array, fourcc: string): number {
    const target = new TextEncoder().encode(fourcc)
    const limit = Math.min(buf.length - 4, 8192)
    for (let i = 4; i <= limit; i++) {
      let match = true
      for (let j = 0; j < 4; j++) if (buf[i + j] !== target[j]) { match = false; break }
      if (match) return i + 4
    }
    return -1
  }

  const startMse = useCallback(async (): Promise<boolean> => {
    if (!cameraId || typeof MediaSource === 'undefined' || !videoRef.current) return false
    attemptStartedAtRef.current = Date.now()
    // Generation guard (browser-verified freeze root cause): a superseded
    // attempt's LATE failure (its sourceopen timeout fires while a newer
    // attempt already owns the element) must never execute the newer
    // attempt's stop — that killed the healthy live stream ~5 s after every
    // page load. Same discipline as the hub's session generations.
    const myGen = ++attemptGenRef.current
    const genValid = () => attemptGenRef.current === myGen
    // Deadline-bounded attempt: whatever hangs inside (sourceopen, fetch,
    // first byte) must not block restart()/fallback forever.
    const attempt = (async (): Promise<boolean> => {
      const video = videoRef.current!
      const ms = new MediaSource()
      let aborted = false
      const stopThis = () => {
        aborted = true
        try { readerRef.current?.cancel().catch?.(() => { /* gone */ }) } catch { /* gone */ }
        try { if (ms.readyState === 'open') ms.endOfStream() } catch { /* closed */ }
        try { video.pause() } catch { /* */ }
        try { URL.revokeObjectURL(video.src) } catch { /* */ }
      }
      stopRef.current = stopThis
      try {
        video.srcObject = null
        video.src = URL.createObjectURL(ms)
        await new Promise<void>((resolve, reject) => {
          ms.addEventListener('sourceopen', () => resolve(), { once: true })
          setTimeout(() => reject(new Error('sourceopen timeout')), 5000)
        })
        if (aborted || !genValid()) return false

        const res = await fetch(`/api/cameras/${cameraId}/stream.fmp4?q=${quality}`, { credentials: 'same-origin' })
        if (!res.ok || !res.body) throw new Error(`fmp4 ${res.status}`)
        const reader = res.body.getReader()
        readerRef.current = reader
        if (aborted) return false

        // init bytes carry ftyp+moov → derive the exact codec string
        const first = await reader.read()
        if (aborted) return false
        if (first.done) throw new Error('stream ended during init')
        const initBuf = first.value
        const codec = avcCodecFromInit(initBuf) ?? 'avc1.42E01E'
        if (!MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`)) {
          throw new Error(`codec ${codec} unsupported`)
        }
        const sb = ms.addSourceBuffer(`video/mp4; codecs="${codec}"`)

        const queue: Uint8Array[] = []
        let appending = false
        const trim = () => {
          try {
            if (sb.buffered.length > 1 && sb.buffered.end(sb.buffered.length - 1) > 30) {
              sb.remove(0, sb.buffered.start(sb.buffered.length - 1) - 5)
            }
          } catch { /* racing */ }
        }
        const pump = () => {
          if (appending || aborted || queue.length === 0 || sb.updating) return
          appending = true
          try { sb.appendBuffer(queue.shift()! as unknown as BufferSource) } catch { appending = false }
        }
        sb.addEventListener('updateend', () => {
          appending = false
          trim()
          pump()
          // live-edge chase + autoplay recovery: stay within a fragment of now
          try {
            if (sb.buffered.length) {
              const edge = sb.buffered.end(sb.buffered.length - 1)
              // keep ~2 s of cushion: fragments land on a full-GOP cadence
              // (≈2.5 s on this camera), so a smaller cushion makes the
              // playhead hit the edge and stall every single period
              if (edge - video.currentTime > 3.5) video.currentTime = edge - 2.0
            }
            if (video.paused) video.play().catch(() => { /* gesture needed; retried here */ })
          } catch { /* */ }
        })
        sb.addEventListener('error', () => { if (!aborted) restartRef.current() })

        const push = (chunk: Uint8Array) => { queue.push(chunk); pump() }
        push(initBuf)

        void (async () => {
          try {
            for (;;) {
              const { value, done } = await reader.read()
              if (done || aborted) break
              push(value)
            }
            // Stream ended cleanly while we're still live (backend restart, proxy
            // reset): a silent endOfStream here would freeze the last frame
            // forever — reconnect instead.
            if (!aborted) restartRef.current()
          } catch {
            if (!aborted) restartRef.current()   // network reset — reconnect
          }
        })()

        // Never let a pending play() block watchdog installation: race it with
        // a short timer; updateend + supervisor keep retrying play afterwards.
        await Promise.race([
          video.play().catch(() => { /* autoplay may need the first data */ }),
          new Promise(r => setTimeout(r, 2000)),
        ])
        if (aborted) return false

        // Playback watchdog (EYE-025): the video element can end up paused or
        // parked behind the live edge (autoplay policy, a torn-down previous
        // stream, a stalled fetch). While media appends, nudge play + seek to
        // the live edge; if the frame stays frozen anyway, surface `stalled`
        // and force a full reconnect after 8 s.
        let lastTime = -1
        let stalledSince = 0
        const nudgeTimes: number[] = []   // nudge timestamps (sliding window)
        let switchedToMjpeg = false
        const recentNudges = () => {
          const cutoff = Date.now() - 60_000
          while (nudgeTimes.length && nudgeTimes[0] < cutoff) nudgeTimes.shift()
          return nudgeTimes.length
        }
        const watchdog = setInterval(() => {
          if (aborted || switchedToMjpeg) return
          try {
            const hidden = document.hidden
            const edge = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0
            const behind = edge - video.currentTime
            // nudge only when visible (hidden tabs legitimately don't paint)
            if (!hidden && video.readyState >= 2 && edge > 0 && (video.paused || behind > 3)) {
              video.currentTime = Math.max(0, edge - 2.0)
              video.play().catch(() => { /* retried next tick */ })
              nudgeTimes.push(Date.now())
              lastTime = video.currentTime   // judge advancement from the seeked position
            }
            if (switchedToMjpeg) { setStalled(false); return }   // MJPEG path: freshness is the <img>'s problem
            // a PAUSED element is never advancing — otherwise the seek-jump masks
            // the stall forever (the exact production freeze)
            const advancing = !video.paused && video.currentTime > lastTime + 0.15
            if (video.paused) lastTime = video.currentTime
            if (hidden) { stalledSince = 0; setStalled(false); return }
            if (advancing) {
              stalledSince = 0
              setStalled(false)
            } else {
              if (!stalledSince) stalledSince = Date.now()
              setStalled(true)
              // two viable triggers: continuous stall (8 s) OR repeated failed
              // nudges (play "succeeds" but the element re-pauses — flapping).
              // The nudge window is cumulative, not consecutive: environments
              // that re-pause every ~2 s (each nudge "succeeds" briefly) never
              // build a CONSECUTIVE stall, but 8 nudges in a minute is still
              // an MSE transport verdict, not a hiccup.
              const continuousStall = Date.now() - stalledSince > 8000
              const nudgeFlapping = recentNudges() >= 8
              if ((continuousStall || nudgeFlapping) && !switchedToMjpeg) {
                // MSE renders nothing (autoplay-blocked environment, or a dead
                // stream that survived one reconnect) — fall back to MJPEG,
                // which needs no autoplay and always renders. The watchdog stays
                // alive and retries the switch until MJPEG actually starts.
                switchedToMjpeg = true
                setStalled(false)
                stalledSince = 0
                void startMjpeg().then(ok => {
                  if (ok) {
                    // MSE consumer released only after MJPEG renders
                    stopRef.current?.()
                    stopRef.current = null
                  } else {
                    switchedToMjpeg = false   // retry on upcoming ticks
                  }
                })
              }
            }
          } catch { /* element gone */ }
        }, 1000)
        const stopWatchdog = () => clearInterval(watchdog)
        const prevStop = stopRef.current
        stopRef.current = () => { stopWatchdog(); prevStop?.() }

        transportRef.current = 'mse'
        setTransport('mse')
        setStartedAt(Date.now())
        setState('live')
        setStalled(false)
        return true
      } catch {
        // Only tear down if we still own the slot — a superseded attempt's
        // late failure must never kill the live successor.
        if (genValid()) {
          try { stopThis() } catch { /* */ }
          if (stopRef.current === stopThis) stopRef.current = null
        }
        return false
      }
    })()
    const ok = await Promise.race([
      attempt,
      new Promise<false>(resolve => setTimeout(() => resolve(false), 15_000)),
    ])
    if (!ok && genValid() && stopRef.current) {
      // a wedged attempt owns the element — abandon it; the supervisor and the
      // caller's fallback take over from a clean state
      try { stopRef.current() } catch { /* */ }
      stopRef.current = null
    }
    return ok
  }, [cameraId, quality])

  const restart = useCallback(async () => {
    setState('connecting')
    setMjpegSrc(null)
    stopRef.current?.()
    stopRef.current = null
    const ok = await startMseRef.current()
    if (!ok) await startMjpegRef.current()
  }, [])
  restartRef.current = () => { void restart() }

  // Primitive-only effect deps: startMse/startMjpeg identities must never tear
  // down a healthy stream (a spurious re-run during the keyframe wait killed
  // the live attempt and left the "live" badge on a frozen frame).
  const startMseRef = useRef(startMse)
  const startMjpegRef = useRef(startMjpeg)
  startMseRef.current = startMse
  startMjpegRef.current = startMjpeg

  useEffect(() => {
    let cancelled = false
    setState('connecting')
    setMjpegSrc(null)
    void (async () => {
      let ok = await startMseRef.current()
      if (cancelled) return
      if (!ok) ok = await startMjpegRef.current()
      // REAL auto-retry: if both transports failed (backend down at the
      // moment of reconnect), retry every 2 s until one comes up — the
      // offline overlay's promise must be true.
      if (!ok && !cancelled) {
        setState('offline')
        retry.current = setTimeout(() => { if (!cancelled) restartRef.current() }, 2000)
      }
    })()

    // Supervisor (EYE-025): independent of any single MSE attempt. Attempts
    // can wedge below JS visibility (observed: sourceopen never opening after
    // the cameras-poll re-run tore down the first attempt) and take their
    // per-attempt watchdog to the grave. This interval survives attempt churn:
    // a visible page whose MSE video does not advance gets a full rebuild;
    // repeated MSE failures escalate to MJPEG via the watchdog. The 25 s grace
    // covers a cold keyframe-bound start (camera GOP ≈ 2.5 s, late founder of
    // a shared transcoder up to 20 s) before stall verdicts begin.
    let lastTime = -1
    let staleTicks = 0
    const supervisor = setInterval(() => {
      try {
        if (cancelled || document.hidden) { staleTicks = 0; return }
        if (transportRef.current !== 'mse' || !stopRef.current) { staleTicks = 0; return }
        const video = videoRef.current
        if (!video) return
        // fresh attempts get a grace window (sourceopen + keyframe wait)
        if (Date.now() - attemptStartedAtRef.current < 25_000) { lastTime = video.currentTime; staleTicks = 0; return }
        const advancing = !video.paused && video.currentTime > lastTime + 0.15
        if (advancing) { staleTicks = 0; setStalled(false) } else {
          staleTicks += 1
          if (staleTicks >= 5) {
            staleTicks = -8   // rebuild budget before the next verdict
            restartRef.current()
          }
        }
        lastTime = video.currentTime
      } catch { /* element gone */ }
    }, 1000)

    return () => {
      cancelled = true
      clearInterval(supervisor)
      clearTimeout(retry.current)
      attemptGenRef.current += 1   // invalidate the current attempt's generation
      stopRef.current?.()
      stopRef.current = null
      setMjpegSrc(null)
    }
  }, [cameraId, quality, startMse, startMjpeg])

  const onMjpegError = useCallback(() => {
    setState('offline')
    clearTimeout(retry.current)
    retry.current = setTimeout(() => { void restart() }, 2000)
  }, [restart])

  const onMjpegLoad = useCallback(() => setState('live'), [])

  return { videoRef, mjpegSrc, transport, state, startedAt, stalled, restart, onMjpegError, onMjpegLoad }
}
