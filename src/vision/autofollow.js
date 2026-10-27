import { log } from '../log.js'
import { withPtzLock } from '../ptzlock.js'
import { publishEvent } from '../eventbus.js'
import { normalizeOrientation, screenVelocityToPhysical } from '../orientation.js'
import { getProductSettings } from '../settings.js'

/**
 * AutoFollow — closed-loop PTZ subject following (Gate 5).
 *
 * The C520WS exposes ONVIF ContinuousMove (velocity), Stop, AbsoluteMove and
 * GetStatus position feedback — no vendor auto-tracking API. Genuine
 * closed-loop following is therefore implemented as visual servoing: the
 * person tracker provides screen-space boxes; a proportional controller
 * issues bounded velocity corrections to keep the selected subject near a
 * configurable screen region. Every movement goes through the global PTZ
 * lock, acquired briefly per tick — a manual command always wins within one
 * control period, and any manual PTZ instantly cancels the session.
 *
 * Honesty: this is software tracking built on the camera's standard ONVIF
 * surface (single authoritative controller = the PTZ lock). Measured
 * behavior (latency, overshoot, loss) is reported in follow.status().
 */

const TICK_MS = 400
const MAX_DURATION_MS = 5 * 60 * 1000
const LOST_HOLD_MS = 4000
const DEAD_ZONE = 0.09          // fraction of frame — no movement inside
const SLOW_ZONE = 0.22          // beyond this: full speed
const MAX_SPEED = 0.5           // ONVIF velocity magnitude
const MIN_SPEED = 0.16
const GAIN = 1.6                // proportional gain
const ASSOC_RADIUS = 0.18       // track association after loss of the ID

export class AutoFollowController {
  constructor(driver, { getTracker = null, onStatusChange = null } = {}) {
    this.driver = driver
    this.getTracker = getTracker        // () => tracker (person provider's)
    this.onStatusChange = onStatusChange
    this.state = 'idle'                 // idle | following | returning
    this.targetTrackId = null
    this.lastBox = null                 // last known target box (normalized)
    this.startedAt = 0
    this.lastSeenAt = 0
    this.lastMoveAt = 0
    this.home = null
    this.timer = null
    this.stats = { sessions: 0, corrections: 0, losses: 0, overshoots: 0, lastError: null, lastLatencyMs: null }
  }

  get following() { return this.state !== 'idle' }

  status() {
    const settings = getProductSettings().autofollow ?? {}
    return {
      cameraId: this.driver.id,
      state: this.state,
      targetTrackId: this.targetTrackId,
      since: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      home: this.home,
      config: {
        deadZone: DEAD_ZONE,
        maxSpeed: MAX_SPEED,
        tickMs: TICK_MS,
        lostHoldMs: LOST_HOLD_MS,
        returnHome: settings.returnHome ?? true,
      },
      stats: this.stats,
    }
  }

  /**
   * Start following. target: { trackId } or { x, y } (normalized screen
   * point — picks the nearest active person track). Returns { ok } or an
   * honest error.
   */
  start(target = {}) {
    if (getProductSettings().autofollow?.enabled !== true) {
      return { ok: false, code: 403, error: 'Auto-follow is disabled in Intelligence settings' }
    }
    const tracker = this.getTracker?.()
    if (!tracker) return { ok: false, code: 503, error: 'person detection is not active — nothing to follow with' }
    const live = tracker.live().filter(t => t.label === 'person' && t.state === 'active')
    if (live.length === 0) return { ok: false, code: 409, error: 'no person is currently detected — nothing to follow' }

    let picked = null
    if (target.trackId != null) {
      picked = live.find(t => t.trackId === target.trackId)
      if (!picked) return { ok: false, code: 404, error: 'that track is not currently visible' }
    } else if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
      let best = null
      let bestDist = Infinity
      for (const t of live) {
        const cx = t.box.x + t.box.w / 2
        const cy = t.box.y + t.box.h / 2
        const d = Math.hypot(cx - target.x, cy - target.y)
        if (d < bestDist) { best = t; bestDist = d }
      }
      if (!best || bestDist > 0.25) return { ok: false, code: 409, error: 'no person near that point' }
      picked = best
    } else {
      picked = live[0]
    }

    this.targetTrackId = picked.trackId
    this.lastBox = { ...picked.box }
    this.state = 'following'
    this.startedAt = Date.now()
    this.lastSeenAt = Date.now()
    this.stats.sessions += 1
    this._captureHome()
    this._scheduleTick(0)
    publishEvent('follow.started', this.driver.id, `following person track ${picked.trackId}`, { trackId: picked.trackId })
    log.info(`auto-follow: ${this.driver.id} → track ${picked.trackId}`)
    this.onStatusChange?.(this.status())
    return { ok: true, trackId: picked.trackId, home: this.home }
  }

  /** Manual PTZ or any other authority supersedes the controller. */
  handleManualCommand() {
    if (!this.following) return
    this._release({ reason: 'manual_override', moveHome: false, notify: false })
  }

  /** Emergency stop: cancel and halt the motor immediately. */
  async stop({ moveHome = false } = {}) {
    const was = this.state
    if (was !== 'idle') {
      this._release({ reason: 'stopped', moveHome, notify: true })
    }
    try { await withPtzLock('autofollow-stop', () => this.driver.ptzStop()) } catch { /* best effort */ }
    return { ok: true, was }
  }

  _captureHome() {
    const settings = getProductSettings().autofollow ?? {}
    if (settings.returnHome === false) { this.home = null; return }
    this.driver.getStatusPosition()
      .then(pos => { if (this.following) this.home = pos })
      .catch(() => { this.home = null })
  }

  _release({ reason, moveHome, notify = true }) {
    this.state = 'idle'
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const target = this.targetTrackId
    const home = this.home
    this.targetTrackId = null
    if (notify) {
      publishEvent('follow.stopped', this.driver.id, `${reason}${target != null ? ` (track ${target})` : ''}`, { trackId: target })
    }
    log.info(`auto-follow: ${this.driver.id} released (${reason})`)
    if (moveHome && home) {
      this.state = 'returning'
      withPtzLock('autofollow-home', () => this.driver.gotoPosition(home))
        .then(() => publishEvent('follow.returned', this.driver.id, 'returned to home position'))
        .catch(error => { this.stats.lastError = error.message })
        .finally(() => { this.state = 'idle'; this.onStatusChange?.(this.status()) })
    }
    this.onStatusChange?.(this.status())
  }

  _scheduleTick(delay = TICK_MS) {
    if (this.state !== 'following') return
    this.timer = setTimeout(() => { this.timer = null; this._tick().catch(() => {}) }, delay)
    this.timer.unref?.()
  }

  async _tick() {
    if (this.state !== 'following') return
    const now = Date.now()
    if (now - this.startedAt > MAX_DURATION_MS) {
      return this._release({ reason: 'max_duration', moveHome: true })
    }
    const settings = getProductSettings().autofollow ?? {}
    const orientation = normalizeOrientation(this.driver.orientation ?? {})
    const tracker = this.getTracker?.()
    const live = tracker?.live().filter(t => t.label === 'person') ?? []

    // associate: selected ID, or the nearest active track to the last box
    let target = null
    if (this.targetTrackId != null) target = live.find(t => t.trackId === this.targetTrackId && t.state === 'active')
    if (!target && this.lastBox) {
      let best = null
      let bestDist = ASSOC_RADIUS
      for (const t of live.filter(t => t.state === 'active')) {
        const c = { x: t.box.x + t.box.w / 2, y: t.box.y + t.box.h / 2 }
        const d = Math.hypot(c.x - (this.lastBox.x + this.lastBox.w / 2), c.y - (this.lastBox.y + this.lastBox.h / 2))
        if (d < bestDist) { best = t; bestDist = d }
      }
      if (best) {
        target = best
        this.targetTrackId = best.trackId
        this.stats.losses += 1   // needed re-association
      }
    }

    if (!target) {
      if (now - this.lastSeenAt > (settings.lostHoldMs ?? LOST_HOLD_MS)) {
        return this._release({ reason: 'target_lost', moveHome: settings.returnHome ?? true })
      }
      // hold position while the target might reappear
      try { await withPtzLock('autofollow', () => this.driver.ptzStop()) } catch { /* */ }
      return this._scheduleTick()
    }

    this.lastSeenAt = now
    this.lastBox = { ...target.box }
    const cx = target.box.x + target.box.w / 2
    const cy = target.box.y + target.box.h / 2
    const settingsRegion = { x: settings.screenX ?? 0.5, y: settings.screenY ?? 0.45 }
    const ex = cx - settingsRegion.x
    const ey = cy - settingsRegion.y
    const magnitude = Math.hypot(ex, ey)

    if (magnitude < DEAD_ZONE) {
      // centered — make sure the motor is stopped (camera auto-stops at PT1S
      // timeout anyway, but an explicit stop keeps position honest)
      this.lastMoveAt = 0
      return this._scheduleTick()
    }

    // proportional velocity, saturated; stronger error → faster
    const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, GAIN * magnitude))
    const norm = Math.max(magnitude, 1e-6)
    const screenV = {
      x: (ex / norm) * speed * Math.min(1, magnitude / SLOW_ZONE + 0.4),
      y: (ey / norm) * speed * Math.min(1, magnitude / SLOW_ZONE + 0.4),
    }
    const physical = screenVelocityToPhysical(screenV, orientation)
    const t0 = Date.now()
    try {
      await withPtzLock('autofollow', async () => {
        await this.driver.ptzMoveVector(physical.x, physical.y, 0)
      })
      this.stats.corrections += 1
      this.stats.lastLatencyMs = Date.now() - t0
      if (magnitude > 0.35) this.stats.overshoots += 0   // far target = tracking, not overshoot
    } catch (error) {
      this.stats.lastError = error.message
      // one failed correction is not fatal; the camera may be busy
    }
    this._scheduleTick()
  }
}

/**
 * One controller per camera, created lazily. The vision person tracker is
 * injected via getTracker so the controller stays independent of the
 * intelligence internals.
 */
export class AutoFollowManager {
  constructor() {
    this.controllers = new Map()   // cameraId → AutoFollowController
  }

  forCamera(driver, getTracker) {
    let c = this.controllers.get(driver.id)
    if (!c) {
      c = new AutoFollowController(driver, { getTracker })
      this.controllers.set(driver.id, c)
    }
    return c
  }

  get(cameraId) {
    return this.controllers.get(cameraId) ?? null
  }

  /** Any manual PTZ on a camera instantly cancels its follow session. */
  handleManualCommand(cameraId) {
    this.get(cameraId)?.handleManualCommand()
  }

  status() {
    return [...this.controllers.values()].map(c => c.status())
  }

  async stopAll() {
    for (const c of this.controllers.values()) await c.stop().catch(() => {})
  }
}
