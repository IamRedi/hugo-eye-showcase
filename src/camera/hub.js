import { EventEmitter } from 'node:events'
import { RtspClient } from './rtsp.js'
import { log } from '../log.js'

/**
 * RelayHub — ONE authenticated RTSP session per camera stream path, fanned out
 * in-process to any number of local consumers. This is the single media
 * producer for a camera path: live viewers, recordings, motion analysis,
 * audio listening and future AI inference all subscribe here and never open
 * competing RTSP connections (the camera serves one session per path).
 *
 * Fan-out transport is byte pipes, not UDP relays: the hub receives complete
 * RTP packets from its RTSP session, depacketizes H.264 to Annex-B NAL units
 * (and PCMA audio payloads) and writes them into each consumer's ffmpeg
 * stdin. Consumers start GOP-aligned (SPS+PPS+IDR), need no port pairs, no
 * SDP files and no /tmp artifacts, and the pipe gives natural backpressure.
 *
 * Session state machine (per hub):
 *
 *   IDLE ──subscribe──▶ CONNECTING ──first RTP──▶ STREAMING
 *     ▲                     │ no media                │
 *     │                     ▼                         │ silence/error
 *     └── last sub gone ── RECOVERING ◀───────────────┘
 *              (bounded backoff probes; TEARDOWN always attempted)
 *
 * The camera keeps a dead session's path locked when it never saw a TEARDOWN
 * (e.g. after a crash). While the lock holds, a new session connects but
 * stays silent; the hub detects this with a media probe and retries with a
 * bounded backoff, always sending TEARDOWN so the camera releases the path.
 *
 * Backpressure contract:
 *   - live/fmp4/analyze consumers: when their pipe fills, NALs are dropped
 *     until the next keyframe (a slow viewer must never destabilize the
 *     camera session, a recording, or other viewers).
 *   - record consumers: bytes are buffered (video and audio separately) up
 *     to RECORD_BUFFER_MAX; beyond that onOverflow fires once so the
 *     recording can stop cleanly instead of silently corrupting.
 */

const IDLE_DROP_MS = 45_000      // drop the camera session after the last consumer leaves
const FIRST_MEDIA_MS = 6_000     // a fresh session must produce RTP within this window
const SILENCE_MS = 8_000         // watchdog: no RTP for this long ⇒ recover
const WATCHDOG_MS = 2_000
const MAX_SUBSCRIBERS = 12       // bound on concurrent consumers per hub
const SUBSCRIBE_TIMEOUT_MS = 30_000          // max wait for a subscriber to see media
const RECORD_BUFFER_MAX = 8 * 1024 * 1024    // per-pipe recording backpressure buffer
const GOP_KEEP_MAX = 4                       // completed GOPs kept for pre-event buffering
const GOP_BYTES_MAX = 12 * 1024 * 1024       // and their total byte budget
const ERROR_BACKOFF_MS = [0, 1_000, 2_000, 4_000, 8_000]   // transport errors
const LOCKED_BACKOFF_MS = [1_000, 3_000, 6_000, 10_000]    // connected but no media (path lock)

export class HubCapacityError extends Error {
  constructor() {
    super('too many stream consumers for this camera')
    this.code = 503
  }
}

/** Session connects but produces no media: the camera holds the path lock. */
export class HubPathLockError extends Error {
  constructor() {
    super('camera accepted the session but is not sending media (path lock)')
    this.code = 502
  }
}

export class HubUnavailableError extends Error {
  constructor(cause) {
    super(cause?.message ?? 'camera stream unavailable')
    this.code = 502
    this.cause = cause
  }
}

let nextSubId = 1

/** Module-wide hub state events (for SSE relay, event recording, UI status). */
export const hubBus = new EventEmitter()

export class Hub extends EventEmitter {
  /**
   * @param cam camera config (credentials stay inside this module boundary)
   * @param streamPath RTSP path this hub owns (sub or main)
   */
  constructor(cam, streamPath, options = {}) {
    super()
    this.cam = cam
    this.path = streamPath
    // Timing/backoff knobs (testable; defaults are the production constants).
    this._t = {
      idleDropMs: options.idleDropMs ?? IDLE_DROP_MS,
      firstMediaMs: options.firstMediaMs ?? FIRST_MEDIA_MS,
      silenceMs: options.silenceMs ?? SILENCE_MS,
      watchdogMs: options.watchdogMs ?? WATCHDOG_MS,
      subscribeTimeoutMs: options.subscribeTimeoutMs ?? SUBSCRIBE_TIMEOUT_MS,
      errorBackoff: options.errorBackoff ?? ERROR_BACKOFF_MS,
      lockedBackoff: options.lockedBackoff ?? LOCKED_BACKOFF_MS,
      recordBufferMax: options.recordBufferMax ?? RECORD_BUFFER_MAX,
    }
    this.quality = streamPath === cam.subPath ? 'sub' : 'main'
    this.state = 'idle'
    this.stateSince = new Date().toISOString()
    this.client = null
    this.subs = new Map()            // id -> subscriber
    this.lastMediaAt = 0
    this.sps = null                  // latest in-stream SPS/PPS (Annex-B)
    this.pps = null
    this.pendingParams = []          // SPS/PPS awaiting their access unit
    this.completedGops = []          // [{bytes: Buffer[]}] for pre-event buffering
    this.currentGop = []
    this.gopBytes = 0
    this.frameTs = []                // recent RTP timestamps (90 kHz) for fps
    this.fps = null
    this.auSinceIdr = 0              // access units since the last keyframe
    this.keyframeIntervalS = null    // measured GOP length in seconds
    this.reconnects = 0
    this.errorStreak = 0
    this.lockedStreak = 0
    this.lastError = null
    this.generation = 0
    this.sessionPromise = null
    this.recoverTimer = null
    this.idleTimer = null
    this.lastSessionAttemptAt = 0   // anti-wedge: when the retry engine last acted
    this.watchdog = setInterval(() => this._watchdog(), this._t.watchdogMs)
    this.watchdog.unref()
  }

  status() {
    return {
      quality: this.quality,
      state: this.state,
      since: this.stateSince,
      fps: this.fps,
      keyframeIntervalS: this.keyframeIntervalS,
      subscribers: [...this.subs.values()].map(s => ({
        id: s.id, kind: s.kind, bytes: s.bytes, drops: s.drops + s.audioDrops,
      })),
      reconnects: this.reconnects,
      lastError: this.lastError,
    }
  }

  _setState(state, detail = null) {
    if (this.state === state) return
    const prev = this.state
    this.state = state
    this.stateSince = new Date().toISOString()
    log.info(`relay hub ${this.cam.id}/${this.quality}: ${prev} → ${state}${detail ? ` (${detail})` : ''}`)
    const event = { cameraId: this.cam.id, quality: this.quality, state, prev, at: this.stateSince }
    this.emit('state', event)
    hubBus.emit('state', event)
  }

  // ---------- consumer API ----------

  /**
   * Subscribe a consumer to this hub. Resolves once media is flowing (the
   * consumer's first output is then bounded only by its own start-up).
   *
   * kind: 'live' | 'fmp4' | 'analyze' — video only; slow consumers drop to
   *        the next keyframe. kind 'record' — no drops, bounded buffering,
   *        onOverflow() fires once past RECORD_BUFFER_MAX. kind 'audio' —
   *        PCMA payload bytes only.
   *
   * Returns { hasAudio, attach(), detach(), sub }. The consumer creates its
   * ffmpeg child and passes its stdin pipe(s) to attach({ video, audio }).
   */
  async subscribe({ kind = 'live', audio = false, preBufferGops = 0, onOverflow = null } = {}) {
    if (this.subs.size >= MAX_SUBSCRIBERS) throw new HubCapacityError()
    const sub = {
      id: nextSubId++,
      kind,
      wantsAudio: Boolean(audio),
      preBufferGops: kind === 'record' ? Math.max(0, Math.min(preBufferGops, GOP_KEEP_MAX)) : 0,
      video: null,
      audio: null,
      aligned: false,
      subSps: null,
      subPps: null,
      waitIdr: false,
      aWaitRoom: false,
      audioDrops: 0,
      drops: 0,
      bytes: 0,
      vBuf: [], vBufBytes: 0,
      aBuf: [], aBufBytes: 0,
      pending: [], pendingBytes: 0,   // bytes arriving before attach() provides the pipes
      aPending: [], aPendingBytes: 0,
      overflowed: false,
      onOverflow,
      detached: false,
      joinedAt: Date.now(),
      alignedAt: null,
    }
    this.subs.set(sub.id, sub)
    this._armIdle()
    this._kickSession()
    try {
      await this._waitStreaming(this._t.subscribeTimeoutMs)
    } catch (error) {
      this.subs.delete(sub.id)
      this._armIdle()
      throw new HubUnavailableError(error)
    }
    sub.hasAudio = Boolean(this.client?.audioTrack)
    if (kind === 'audio' && !audio) {
      this.subs.delete(sub.id)
      this._armIdle()
      throw new Error('audio-only subscriber requires audio: true')
    }
    if (kind === 'audio' && !sub.hasAudio) {
      this.subs.delete(sub.id)
      this._armIdle()
      throw new Error('camera does not expose an audio track via RTSP')
    }
    const handle = {
      hasAudio: sub.hasAudio,
      attach: ({ video = null, audio: audioPipe = null } = {}) => {
        sub.video = video
        sub.audio = audioPipe
        video?.on('drain', () => this._onVideoDrain(sub))
        audioPipe?.on('drain', () => this._onAudioDrain(sub))
        video?.on('error', () => this.release(sub.id))
        audioPipe?.on('error', () => this.release(sub.id))
        // Flush what arrived between subscribe() and attach() — the stream is
        // contiguous, so the consumer starts mid-GOP where the tail really is.
        this._flushPending(sub)
      },
      detach: () => this.release(sub.id),
      sub,
    }
    return handle
  }

  _flushPending(sub) {
    if (sub.video) {
      for (const nal of sub.pending.splice(0)) {
        sub.bytes += nal.length
        if (sub.video.write(nal) === false) {
          if (sub.kind === 'record') { sub.vBuf.push(nal); sub.vBufBytes += nal.length }
          else { sub.waitIdr = true; sub.pending = [] }
          break
        }
      }
      sub.pendingBytes = sub.pending.reduce((n, b) => n + b.length, 0)
    }
    if (sub.audio) {
      for (const payload of sub.aPending.splice(0)) {
        sub.bytes += payload.length
        if (sub.audio.write(payload) === false) {
          if (sub.kind === 'record') { sub.aBuf.push(payload); sub.aBufBytes += payload.length }
          else { sub.aWaitRoom = true; sub.aPending = [] }
          break
        }
      }
      sub.aPendingBytes = sub.aPending.reduce((n, b) => n + b.length, 0)
    }
  }

  release(subId) {
    const sub = this.subs.get(subId)
    if (!sub || sub.detached) return
    sub.detached = true
    // End (not destroy) the pipes: ffmpeg sees clean EOF and finalizes.
    try { sub.video?.end() } catch { /* gone */ }
    try { sub.audio?.end() } catch { /* gone */ }
    this.subs.delete(subId)
    this._armIdle()
  }

  // ---------- session lifecycle ----------

  _kickSession() {
    if (this.client || this.sessionPromise) return
    this._ensureSession().catch(() => { /* _down scheduled the next attempt */ })
  }

  _ensureSession() {
    if (this.state === 'streaming' && this.client) return Promise.resolve()
    if (this.sessionPromise) return this.sessionPromise
    this.lastSessionAttemptAt = Date.now()
    this._armIdle()
    // The generation is owned by the ATTEMPT, not by _openSession: when an
    // attempt is superseded (anti-wedge guard or a fresh kick), its eventual
    // failure must not touch the state machine of the newer attempt.
    const gen = ++this.generation
    const attempt = this._openSession(gen)
      .catch(error => {
        // Single retry authority: every session failure funnels through _down,
        // which schedules the bounded-backoff reconnect while consumers remain.
        // Stale attempts (superseded by a newer generation) are ignored — the
        // newer attempt owns the state machine now.
        return this._down({ unclean: false, mediaLock: error instanceof HubPathLockError, error, gen })
          .then(() => { throw error })
      })
      .finally(() => {
        // Only clear the slot if this attempt is still the current one — a
        // superseded attempt's settlement must not erase the newer attempt.
        if (this.sessionPromise === attempt) this.sessionPromise = null
      })
    this.sessionPromise = attempt
    return this.sessionPromise
  }

  async _openSession(gen) {
    clearTimeout(this.recoverTimer)
    this.recoverTimer = null
    this._setState('connecting')
    const client = new RtspClient({
      host: this.cam.host,
      port: this.cam.rtspPort,
      path: this.path,
      username: this.cam.username,
      password: this.cam.password,
      idleTimeoutMs: 15_000,
    })
    this.client = client
    client.on('annexb', (nal, meta) => { if (gen === this.generation) this._onNal(nal, meta ?? {}) })
    client.on('audio', payload => { if (gen === this.generation) this._onAudio(payload) })
    client.on('closed', () => {
      if (gen !== this.generation || this.state === 'idle' || this.state === 'recovering') return
      this._down({ unclean: !client._cleanClose, gen })
    })
    client.on('error', error => {
      if (gen !== this.generation) return
      log.warn(`relay hub ${this.cam.id}/${this.quality}: session error: ${error.message}`)
    })

    await client.play({ audio: true })

    // Media probe: the camera accepts SETUP/PLAY yet stays silent while the
    // path is still locked by a lost session. Detect quickly and classify.
    const mediaOk = await this._waitFirstMedia(gen, this._t.firstMediaMs)
    if (gen !== this.generation) {
      // superseded while connecting: quietly release OUR socket and bow out —
      // the newer attempt owns the state machine (no _down, no churn)
      try { await this._teardownClient(client) } catch { /* gone */ }
      throw new Error('stale session attempt superseded')
    }
    if (!mediaOk) {
      const error = new HubPathLockError()
      await this._down({ unclean: false, mediaLock: true, error, gen })
      throw error
    }
    this.errorStreak = 0
    this.lockedStreak = 0
    this._setState('streaming')
    return client
  }

  _waitFirstMedia(gen, timeoutMs) {
    return new Promise(resolve => {
      const start = Date.now()
      const check = setInterval(() => {
        if (gen !== this.generation) { clearInterval(check); resolve(false); return }
        if (this.lastMediaAt > start) { clearInterval(check); resolve(true); return }
        if (Date.now() - start > timeoutMs) { clearInterval(check); resolve(false); return }
      }, 100)
    })
  }

  _waitStreaming(timeoutMs) {
    if (this.state === 'streaming' && this.client) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const check = setInterval(() => {
        if (this.state === 'streaming' && this.client) { clearInterval(check); resolve(); return }
        if (Date.now() - start > timeoutMs) {
          clearInterval(check)
          reject(new Error(this.lastError ?? 'stream did not start in time'))
        }
      }, 100)
    })
  }

  async _teardownClient(client) {
    client._cleanClose = true
    try { await client.teardown() } catch { /* socket already gone */ }
  }

  /**
   * Session lost. Attempts a clean TEARDOWN (so the camera releases the path
   * as early as possible), then schedules a bounded-backoff reconnect while
   * consumers remain; drops to idle otherwise.
   */
  async _down({ unclean = true, mediaLock = false, error = null, gen = null } = {}) {
    // A superseded attempt's failure must not disturb the newer attempt.
    if (gen !== null && gen !== this.generation) return
    this.generation += 1            // invalidate all handlers/probes of this session
    const client = this.client
    this.client = null
    clearTimeout(this.recoverTimer)
    if (client) await this._teardownClient(client)
    this.frameTs = []
    this.fps = null
    for (const sub of this.subs.values()) {
      sub.aligned = false           // re-align at the next keyframe after recovery
      sub.waitIdr = false
      sub.aWaitRoom = false
    }
    if (error) this.lastError = error.message ?? String(error)

    if (this.subs.size === 0) {
      this._setState('idle')
      return
    }
    if (mediaLock) { this.lockedStreak += 1; this.errorStreak = 0 }
    else if (!unclean || error) { this.errorStreak += 1; this.lockedStreak = 0 }
    this.reconnects += 1
    this._setState('recovering', mediaLock ? 'path lock' : (unclean ? 'connection loss' : 'session error'))
    const table = mediaLock ? this._t.lockedBackoff : this._t.errorBackoff
    const streak = Math.max(mediaLock ? this.lockedStreak : this.errorStreak, 1)
    const delay = table[Math.min(streak - 1, table.length - 1)] ?? table[table.length - 1]
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = null
      if (this.subs.size === 0 || this.client || this.sessionPromise) return
      this._ensureSession().catch(() => { /* next attempt already scheduled */ })
    }, delay)
    this.recoverTimer.unref?.()
  }

  _watchdog() {
    // Silence guard: a streaming session that stops producing media.
    if (this.state === 'streaming' && this.client && this.subs.size > 0) {
      const silentFor = Date.now() - this.lastMediaAt
      if (silentFor > this._t.silenceMs) {
        log.warn(`relay hub ${this.cam.id}/${this.quality}: no media for ${Math.round(silentFor / 1000)} s — recovering`)
        this._down({ unclean: true, error: new Error(`no media for ${Math.round(silentFor / 1000)} s`) })
          .catch(() => {})
      }
      return
    }
    // Crash guard: recovering with no reconnect pending (should not happen).
    if (this.state === 'recovering' && this.subs.size > 0 && !this.client && !this.sessionPromise && !this.recoverTimer) {
      this._ensureSession().catch(() => {})
      return
    }
    // Anti-wedge guard (EYE-025): a 'recovering' hub with subscribers must make
    // a bounded session attempt at least every 20 s. Whatever the stuck cause —
    // a session attempt that never settled, a cleared timer, any future bug —
    // forcibly retire the old attempt and start a fresh one. The generation
    // counter invalidates the old attempt's callbacks.
    // A pending recoverTimer IS a scheduled attempt (bounded backoff after a
    // normal silence/loss) — forcing over it would only churn, so the guard
    // fires only when NO retry is pending and the last attempt is stale.
    if (this.state === 'recovering' && this.subs.size > 0 && !this.recoverTimer &&
        Date.now() - this.lastSessionAttemptAt > 20_000) {
      log.warn(`relay hub ${this.cam.id}/${this.quality}: no session attempt for >20 s while recovering — forcing a fresh attempt`)
      this.client = null
      this.sessionPromise = null
      clearTimeout(this.recoverTimer)
      this.recoverTimer = null
      this.generation += 1
      this.lastSessionAttemptAt = Date.now()
      this._ensureSession().catch(() => {})
    }
  }

  _armIdle() {
    clearTimeout(this.idleTimer)
    if (this.subs.size > 0) return
    this.idleTimer = setTimeout(() => {
      if (this.subs.size > 0) return
      log.info(`relay hub ${this.cam.id}/${this.quality}: idle — dropping camera session`)
      const client = this.client
      this.client = null
      this.generation += 1
      this.completedGops = []
      this.currentGop = []
      if (client) this._teardownClient(client).catch(() => {})
      this._setState('idle')
    }, this._t.idleDropMs)
    this.idleTimer.unref()
  }

  // ---------- media fan-out ----------

  _onNal(nal, meta) {
    // fps from RTP clock: count one sample per finished access unit
    if (meta.auEnd && meta.ts !== undefined) {
      this.auSinceIdr += 1
      if (meta.idr) {
        if (this.lastIdrTs !== undefined) {
          const span = (meta.ts - this.lastIdrTs) / 90_000
          if (span > 0.05 && span < 30) this.keyframeIntervalS = Math.round(span * 10) / 10
        }
        this.lastIdrTs = meta.ts
        this.auSinceIdr = 0
      }
      this.frameTs.push(meta.ts)
      if (this.frameTs.length > 48) this.frameTs.shift()
      if (this.frameTs.length >= 8) {
        const span = (this.frameTs[this.frameTs.length - 1] - this.frameTs[0]) / 90_000
        if (span > 0.4) this.fps = Math.round(((this.frameTs.length - 1) / span) * 10) / 10
      }
    }
    // Bounded pre-event GOP ring buffer. Parameter sets arriving ahead of an
    // IDR belong to the NEXT GOP, so they are held aside and flushed behind
    // the boundary — every stored GOP starts with SPS/PPS when the camera
    // emits them (Tapo does).
    if (meta.idr) {
      if (this.currentGop.length > 0) {
        this.completedGops.push({ bytes: this.currentGop })
        while (this.completedGops.length > GOP_KEEP_MAX ||
               this.completedGops.reduce((n, g) => n + g.bytes.reduce((m, b) => m + b.length, 0), 0) > GOP_BYTES_MAX) {
          this.completedGops.shift()
        }
      }
      this.currentGop = this.pendingParams.splice(0)
      this.gopBytes = this.currentGop.reduce((n, b) => n + b.length, 0)
    }
    if (meta.type === 7 || meta.type === 8) {
      if (meta.type === 7) this.sps = nal
      else this.pps = nal
      this.pendingParams.push(nal)
    } else {
      if (this.pendingParams.length > 0) {
        this.currentGop.push(...this.pendingParams.splice(0))
      }
      if (this.currentGop.length > 0 || meta.idr) {
        this.currentGop.push(nal)
        this.gopBytes += nal.length
        if (this.gopBytes > GOP_BYTES_MAX) { this.currentGop = []; this.gopBytes = 0 }
      }
    }
    this.lastMediaAt = Date.now()

    for (const sub of [...this.subs.values()]) {
      this._feedNal(sub, nal, meta)
    }
  }

  _feedNal(sub, nal, meta) {
    if (!sub.aligned) {
      if (meta.type === 7) { sub.subSps = nal; return }
      if (meta.type === 8) { sub.subPps = nal; return }
      if (!meta.idr) { sub.drops += 1; return }   // discard until the first keyframe
      // Alignment point: seed pre-event GOPs here — the last completed GOP
      // ends exactly at this IDR, so seeded bytes and the live tail are
      // perfectly contiguous (no seam, no hole).
      if (sub.preBufferGops > 0 && this.completedGops.length > 0) {
        const gops = this.completedGops.slice(-Math.min(sub.preBufferGops, this.completedGops.length))
        for (const gop of gops) for (const seeded of gop.bytes) this._writeVideoNal(sub, seeded, { idr: false })
        log.info(`relay hub ${this.cam.id}/${this.quality}: record subscriber seeded with ${gops.length} pre-event GOP(s)`)
      }
      if (sub.subSps) this._writeVideoNal(sub, sub.subSps, { idr: false })
      if (sub.subPps) this._writeVideoNal(sub, sub.subPps, { idr: false })
      sub.aligned = true
      sub.alignedAt = Date.now()
      log.info(`relay hub ${this.cam.id}/${this.quality}: consumer ${sub.kind} #${sub.id} aligned at keyframe (waited ${sub.drops} NALs, ${sub.alignedAt - sub.joinedAt} ms after join)`)
    }
    if (sub.waitIdr && !meta.idr) { sub.drops += 1; return }
    if (sub.waitIdr && meta.idr) {
      log.info(`relay hub ${this.cam.id}/${this.quality}: consumer ${sub.kind} resynced at keyframe after ${sub.drops} dropped NAL(s)`)
      sub.drops = 0
      sub.waitIdr = false
    }
    this._writeVideoNal(sub, nal, meta)
  }

  _writeVideoNal(sub, nal, meta = {}) {
    if (!sub.video) {
      // Pipe not attached yet (subscribe → spawn ffmpeg window): buffer a
      // bounded amount so nothing contiguous is lost, then give up resyncing.
      sub.pending.push(nal)
      sub.pendingBytes += nal.length
      if (sub.pendingBytes > this._t.recordBufferMax) {
        if (sub.kind === 'record' && !sub.overflowed) {
          sub.overflowed = true
          try { sub.onOverflow?.() } catch { /* caller's */ }
        } else {
          sub.pending = []
          sub.pendingBytes = 0
          sub.waitIdr = true
        }
      }
      return
    }
    if (sub.kind === 'record') {
      if (sub.overflowed) return                    // recording is already being stopped
      if (sub.vBufBytes > 0) {
        sub.vBuf.push(nal)
        sub.vBufBytes += nal.length
        if (sub.vBufBytes > this._t.recordBufferMax) {
          sub.overflowed = true
          log.error(`relay hub ${this.cam.id}/${this.quality}: record consumer overflow — signaling stop`)
          try { sub.onOverflow?.() } catch { /* handler errors are the caller's */ }
        }
        return
      }
      sub.bytes += nal.length
      if (sub.video.write(nal) === false) sub.vBufBytes = 1   // buffering begins (1 = marker)
      return
    }
    sub.bytes += nal.length
    if (sub.video.write(nal) === false) sub.waitIdr = true
  }

  _onAudio(payload) {
    this.lastMediaAt = Date.now()
    for (const sub of [...this.subs.values()]) {
      if (sub.kind !== 'audio' && !(sub.kind === 'record' && sub.wantsAudio)) continue
      if (!sub.audio) {
        // Pipe not attached yet: buffer briefly so the recording stays contiguous.
        sub.aPending.push(payload)
        sub.aPendingBytes += payload.length
        if (sub.aPendingBytes > RECORD_BUFFER_MAX) {
          sub.aPending = []
          sub.aPendingBytes = 0
        }
        continue
      }
      sub.bytes += payload.length
      if (sub.kind === 'record') {
        if (sub.overflowed) continue
        if (sub.aBufBytes > 0) {
          sub.aBuf.push(payload)
          sub.aBufBytes += payload.length
          if (sub.aBufBytes > this._t.recordBufferMax) {
            sub.overflowed = true
            try { sub.onOverflow?.() } catch { /* caller's */ }
          }
          continue
        }
        if (sub.audio.write(payload) === false) sub.aBufBytes = 1
        continue
      }
      if (sub.aWaitRoom) { sub.audioDrops += 1; continue }   // live audio: losing samples is fine
      if (sub.audio.write(payload) === false) sub.aWaitRoom = true
    }
  }

  _onVideoDrain(sub) {
    if (sub.kind !== 'record') return   // live kinds resume at the next keyframe
    // vBufBytes === 1 means "pipe full, buffer empty" — clear the marker.
    while (sub.vBuf.length > 0) {
      const chunk = sub.vBuf[0]
      if (sub.video.write(chunk) === false) return
      sub.vBuf.shift()
      sub.vBufBytes -= chunk.length
    }
    sub.vBufBytes = 0
  }

  _onAudioDrain(sub) {
    if (sub.kind !== 'record') { sub.aWaitRoom = false; return }
    while (sub.aBuf.length > 0) {
      const chunk = sub.aBuf[0]
      if (sub.audio.write(chunk) === false) return
      sub.aBuf.shift()
      sub.aBufBytes -= chunk.length
    }
    sub.aBufBytes = 0
  }
}

const hubs = new Map() // "camId|path" -> Hub

/** Per-camera-path hub (one authoritative session per camera stream path). */
export function getHub(cam, streamPath) {
  const path = streamPath ?? cam.subPath
  const key = `${cam.id}|${path}`
  if (!hubs.has(key)) hubs.set(key, new Hub(cam, path))
  return hubs.get(key)
}

export function allHubStatus() {
  return [...hubs.values()].map(h => h.status())
}

/** Latest hub status per quality for one camera (null when never opened). */
export function hubStatusForCamera(cameraId) {
  const out = { sub: null, main: null }
  for (const hub of hubs.values()) {
    if (hub.cam.id !== cameraId) continue
    if (hub.quality === 'sub') out.sub = hub.status()
    else out.main = hub.status()
  }
  return out
}

export async function stopAllHubs() {
  for (const hub of hubs.values()) {
    hub.generation += 1
    clearTimeout(hub.recoverTimer)
    clearTimeout(hub.idleTimer)
    clearInterval(hub.watchdog)
    const client = hub.client
    hub.client = null
    for (const subId of [...hub.subs.keys()]) hub.release(subId)
    if (client) {
      client._cleanClose = true
      client.teardown().catch(() => {})
    }
    hub._setState('idle')
  }
  hubs.clear()
}

export const _test = {
  IDLE_DROP_MS, FIRST_MEDIA_MS, SILENCE_MS, MAX_SUBSCRIBERS,
  RECORD_BUFFER_MAX, GOP_KEEP_MAX, GOP_BYTES_MAX, ERROR_BACKOFF_MS, LOCKED_BACKOFF_MS,
}
