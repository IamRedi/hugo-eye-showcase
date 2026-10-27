import { startPipeRgbSource } from '../camera/ffmpeg.js'
import { log } from '../log.js'

/**
 * LatestChannel — bounded, latest-wins frame slot.
 *
 * Producers push frames; consumers take(). If the consumer is slow, pushes
 * overwrite the slot (stale frames are dropped, never queued) — AI work can
 * never back up into the media pipeline. take() waits for the next frame.
 */
export class LatestChannel {
  constructor(name = 'channel') {
    this.name = name
    this.frame = null
    this.waiters = []
    this.dropped = 0
    this.delivered = 0
  }

  push(frame) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      this.delivered += 1
      waiter(frame)
      return
    }
    if (this.frame) this.dropped += 1
    this.frame = frame
  }

  take() {
    if (this.closed) return Promise.resolve(null)
    if (this.frame) {
      const frame = this.frame
      this.frame = null
      this.delivered += 1
      return Promise.resolve(frame)
    }
    return new Promise(resolve => this.waiters.push(resolve))
  }

  close() {
    this.closed = true
    this.frame = null
    for (const w of this.waiters.splice(0)) w(null)
  }
}

/**
 * Rolling latency statistics (p50/p95 from a bounded sample).
 */
export class LatencyStats {
  constructor(capacity = 120) {
    this.capacity = capacity
    this.samples = []
  }

  add(ms) {
    this.samples.push(ms)
    if (this.samples.length > this.capacity) this.samples.shift()
  }

  snapshot() {
    if (this.samples.length === 0) return { p50: null, p95: null, last: null, n: 0 }
    const sorted = [...this.samples].sort((a, b) => a - b)
    const pick = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    return {
      p50: pick(0.5),
      p95: pick(0.95),
      last: this.samples[this.samples.length - 1],
      n: this.samples.length,
    }
  }
}

/**
 * VisionRuntime — one shared AI frame path per camera.
 *
 * Owns the single 'analyze' hub subscription and one RGB decode; distributes
 * frames to registered providers over LatestChannels. Providers are
 * independent: start/stop/restart one without touching the others; a stopped
 * provider receives no frames and consumes no inference resources. Provider
 * failures are supervised (bounded backoff restart) and surfaced in status.
 */
export class VisionRuntime {
  /**
   * @param driver camera driver
   * @param getHub fn (cam, path) => hub
   */
  constructor(driver, getHub) {
    this.driver = driver
    this.getHub = getHub
    this.handle = null          // hub subscription handle
    this.source = null          // ffmpeg RGB decoder
    this.channels = new Map()   // provider name -> LatestChannel
    this.providers = new Map()  // name -> { instance, wanted, state, stats, lastError, failStreak, restartTimer }
    this.frames = 0
    this.lastFrameAt = 0
    this.width = 0
    this.height = 0
    this.stopped = false
    this.partial = Buffer.alloc(0)
    this.frameChunks = []
    this.frameBytes = 0
    this.starting = null
    this.watchdog = null
  }

  /**
   * Fixed decode geometry: 640×480 letterboxed (black bars) — known frame
   * stride for reassembly, native aspect preserved for face alignment. The
   * content rectangle travels with every frame so consumers can map
   * coordinates; content-normalized boxes equal live-video-normalized boxes.
   */
  static DECODE = { width: 640, height: 480 }
  static STALL_RESTART_MS = 15_000

  /**
   * Declare the desired provider set: [{ name, factory, needs }] where
   * `needs` = { fps } (all providers share the decoded 640-wide RGB stream).
   * Safe to call repeatedly; reconcile() applies the delta.
   */
  setProviders(desired) {
    const next = new Map(desired.map(p => [p.name, p]))
    for (const [name, entry] of [...this.providers]) {
      if (!next.has(name) && entry.wanted) {
        entry.wanted = false
        entry.instance?.stop?.()
        this.channels.get(name)?.close()
        this.channels.delete(name)
        this.providers.delete(name)
      }
    }
    for (const [name, def] of next) {
      if (!this.providers.has(name)) {
        this.providers.set(name, {
          name,
          def,
          instance: null,
          wanted: true,
          state: 'idle',
          stats: { processed: 0, dropped: 0, latency: new LatencyStats(), lastError: null },
          failStreak: 0,
          restartTimer: null,
          loopRunning: false,
        })
      }
    }
  }

  /** Applies the desired provider state; starts/stops the shared decode as needed. */
  async reconcile() {
    const active = [...this.providers.values()].filter(p => p.wanted)
    if (active.length === 0) {
      this._stopSource()
      return
    }
    await this._ensureSource()
    for (const entry of active) {
      if (entry.state === 'active' || entry.state === 'starting' || entry.state === 'recovering') continue
      await this._startProvider(entry)
    }
  }

  async _startProvider(entry, { isRestart = false } = {}) {
    entry.state = 'starting'
    const channel = this.channels.get(entry.name) ?? this._makeChannel(entry.name)
    try {
      entry.instance = entry.def.factory()
      await entry.instance.start({ channel, runtime: this })
      entry.state = 'active'
      entry.failStreak = 0
      if (isRestart) entry.restarts = (entry.restarts ?? 0) + 1
      this._pump(entry, channel)
    } catch (error) {
      entry.lastError = error.message
      entry.state = 'error'
      entry.failStreak += 1
      throw error
    }
  }

  _makeChannel(name) {
    const channel = new LatestChannel(name)
    this.channels.set(name, channel)
    return channel
  }

  /**
   * Provider pump: take latest frame → process → repeat. The provider's own
   * processing time throttles it; frames arriving meanwhile overwrite the
   * slot (counted as drops). A provider that exits with an error is
   * restarted with bounded backoff while it remains wanted.
   */
  async _pump(entry, channel) {
    if (entry.loopRunning) return
    entry.loopRunning = true
    void (async () => {
      try {
        const interval = 1000 / Math.max(0.5, entry.def.needs?.fps ?? 2)
        let lastProcessed = 0
        for (;;) {
          if (!entry.wanted || entry.state !== 'active') break
          const frame = await channel.take()
          if (!frame || !entry.wanted) break
          // per-provider fps budget: skip frames that arrive too early
          if (Date.now() - lastProcessed < interval) {
            entry.stats.dropped += 1
            continue
          }
          lastProcessed = Date.now()
          const t0 = Date.now()
          try {
            await entry.instance.process(frame)
            entry.stats.processed += 1
            entry.stats.latency.add(Date.now() - t0)
          } catch (error) {
            entry.stats.lastError = error.message
            entry.failStreak += 1
            throw error
          }
        }
      } catch (error) {
        // supervised failure: stop the instance, schedule a bounded restart
        try { entry.instance?.stop?.() } catch { /* gone */ }
        entry.instance = null
        if (entry.wanted && !this.stopped) {
          entry.state = 'recovering'
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(entry.failStreak - 1, 5))
          entry.restartTimer = setTimeout(() => {
            entry.restartTimer = null
            if (!entry.wanted || this.stopped) return
            this._startProvider(entry, { isRestart: true }).catch(() => {
              /* state already recorded; next reconcile/watchdog retries */
            })
          }, delay)
          entry.restartTimer.unref?.()
        } else {
          entry.state = 'stopped'
        }
      } finally {
        entry.loopRunning = false
      }
    })()
  }

  async stopProvider(name) {
    const entry = this.providers.get(name)
    if (!entry) return
    entry.wanted = false
    clearTimeout(entry.restartTimer)
    try { entry.instance?.stop?.() } catch { /* gone */ }
    entry.instance = null
    entry.state = 'stopped'
    this.channels.get(name)?.close()
    this.channels.delete(name)
    if (![...this.providers.values()].some(p => p.wanted)) this._stopSource()
  }

  _armWatchdog() {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      if (!this.source || this.stopped) return
      // detect a stalled shared decode: the process may linger while no
      // frames arrive (camera silent, hub wedged, half-dead pipe)
      if (this.lastFrameAt > 0 && Date.now() - this.lastFrameAt > this.STALL_RESTART_MS) {
        log.warn(`vision source (${this.driver.id}): no frames for ${Math.round((Date.now() - this.lastFrameAt) / 1000)} s — restarting shared decode`)
        for (const [, entry] of this.providers) {
          if (entry.state === 'active') { entry.state = 'recovering'; entry.failStreak += 1 }
        }
        this._stopSource()
        if (!this.stopped) {
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null
            this.reconcile().catch(() => {})
          }, 2000)
          this.restartTimer.unref?.()
        }
      }
    }, 5000)
    this.watchdog.unref?.()
  }

  async _ensureSource() {
    if (this.source) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      const hub = this.getHub(this.driver.cam, this.driver.cam.subPath)
      this.handle = await hub.subscribe({ kind: 'analyze' })
      this.source = this._makeSource(hub)
      this.width = VisionRuntime.DECODE.width
      this.height = VisionRuntime.DECODE.height
      this.frameSize = this.width * this.height * 3
      this.handle.attach({ video: this.source.stdin })
    })()
    try {
      await this.starting
      this._armWatchdog()
    } finally {
      this.starting = null
    }
  }

  _makeSource(hub) {
    const source = startPipeRgbSource({
      streamFps: Math.max(5, Math.round(hub.fps ?? 15)),
      width: VisionRuntime.DECODE.width, height: VisionRuntime.DECODE.height,
      fps: Math.max(1, ...[...this.providers.values()].filter(p => p.wanted).map(p => p.def.needs?.fps ?? 2)),
      filters: [this.driver.orientationFilters(), 'scale=640:480:force_original_aspect_ratio=decrease:flags=area', 'pad=640:480:(ow-iw)/2:(oh-ih)/2:color=black'].filter(Boolean).join(','),
      onError: error => {
        // shared decode died: stop everything; the next reconcile() rebuilds
        log.warn(`vision source (${this.driver.id}): ${error.message}`)
        for (const [, entry] of this.providers) {
          if (entry.state === 'active') { entry.state = 'recovering'; entry.failStreak += 1 }
        }
        this._stopSource()
        if (!this.stopped) {
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null
            this.reconcile().catch(() => {})
          }, 2000)
          this.restartTimer.unref?.()
        }
      },
    })
    this.height = 0
    source.stdout.on('data', chunk => this._onSourceData(chunk))
    return source
  }

  /** Reassembles rawvideo frames from pipe chunks and fans them out. */
  _onSourceData(chunk) {
    this.frameChunks.push(chunk)
    this.frameBytes += chunk.length
    const frameSize = this.frameSize
    while (this.frameBytes >= frameSize) {
      const rgb = this._takeBytes(frameSize)
      if (!rgb) break
      this.frames += 1
      this.lastFrameAt = Date.now()
      const payload = {
        cameraId: this.driver.id,
        at: Date.now(),
        rgb,
        width: this.width,
        height: this.height,
        content: this.contentRect ?? this._contentRect(),
      }
      for (const [, entry] of this.providers) {
        if (!entry.wanted || entry.state !== 'active') continue
        const channel = this.channels.get(entry.name)
        if (channel) channel.push(payload)
      }
    }
  }

  /** Content rectangle inside the letterboxed decode (from the source dims). */
  _contentRect() {
    // the sub-stream aspect: content is centered; derive from the actual
    // scaled size (640×W' fits inside 640×480 with aspect preserved)
    const srcAr = this.driver.capabilities?.videoResolution
      ? this.driver.capabilities.videoResolution.width / this.driver.capabilities.videoResolution.height
      : 16 / 9
    let cw = VisionRuntime.DECODE.width
    let chh = Math.round(cw / srcAr)
    if (chh > VisionRuntime.DECODE.height) {
      chh = VisionRuntime.DECODE.height
      cw = Math.round(chh * srcAr)
    }
    this.contentRect = {
      x: Math.floor((VisionRuntime.DECODE.width - cw) / 2),
      y: Math.floor((VisionRuntime.DECODE.height - chh) / 2),
      w: cw,
      h: chh,
    }
    return this.contentRect
  }

  _takeBytes(n) {
    const head = this.frameChunks[0]
    if (!head) return null
    if (head.length === n) {
      this.frameChunks.shift()
      this.frameBytes -= n
      return head
    }
    if (head.length > n) {
      this.frameChunks[0] = head.subarray(n)
      this.frameBytes -= n
      return head.subarray(0, n)
    }
    const out = Buffer.allocUnsafe(n)
    let filled = 0
    while (filled < n && this.frameChunks.length > 0) {
      const piece = this.frameChunks[0]
      const take = Math.min(piece.length, n - filled)
      piece.copy(out, filled, 0, take)
      filled += take
      if (take === piece.length) this.frameChunks.shift()
      else this.frameChunks[0] = piece.subarray(take)
      this.frameBytes -= take
    }
    return filled === n ? out : null
  }

  _stopSource() {
    try { this.handle?.detach() } catch { /* gone */ }
    try { this.source?.stop() } catch { /* gone */ }
    this.handle = null
    this.source = null
    this.lastFrameAt = 0
    this.partial = Buffer.alloc(0)
    this.frameChunks = []
    this.frameBytes = 0
    clearInterval(this.watchdog)
    this.watchdog = null
  }

  stop() {
    this.stopped = true
    for (const [, entry] of this.providers) {
      entry.wanted = false
      clearTimeout(entry.restartTimer)
      try { entry.instance?.stop?.() } catch { /* gone */ }
      entry.state = 'stopped'
    }
    this._stopSource()
    for (const [, ch] of this.channels) ch.close()
    this.channels.clear()
    this.providers.clear()
  }

  status() {
    return {
      frames: this.frames,
      lastFrameAt: this.lastFrameAt ? new Date(this.lastFrameAt).toISOString() : null,
      width: this.width,
      height: this.height,
      sourceActive: Boolean(this.source),
      providers: [...this.providers.values()].map(e => ({
        name: e.name,
        wanted: e.wanted,
        state: e.state,
        restarts: e.restarts ?? 0,
        failStreak: e.failStreak,
        lastError: e.stats.lastError ?? e.lastError ?? null,
        processed: e.stats.processed,
        latency: e.stats.latency.snapshot(),
      })),
    }
  }
}
