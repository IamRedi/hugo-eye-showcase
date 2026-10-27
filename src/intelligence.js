import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { db, newId } from './db.js'
import { log } from './log.js'
import { getProductSettings } from './settings.js'
import { getHub } from './camera/hub.js'
import { grayFrameToJpeg } from './camera/ffmpeg.js'
import { activeRecordings } from './recordings.js'
import { PersonDetectorProvider, aiAvailability } from './ai/detector.js'
import { FacePipeline } from './ai/faces.js'
import { VisionRuntime } from './vision/runtime.js'
import { SceneState } from './vision/scene.js'
import { PeopleRegistry } from './people.js'
import { aiFacesAvailable } from './ai/faceDetect.js'
import { eventBus, publishEvent, signalBus } from './eventbus.js'
import { OllamaProvider, VlmQueue } from './ai/vlm.js'
import { IdentityTracker } from './vision/identity.js'
import { PostureState, overlayView, MovementProfile } from './vision/posture.js'
export { eventBus }

/**
 * Local intelligence. Honest by design: a provider is either running (real
 * analysis producing real events) or not running — the UI reads this state.
 *
 * Providers (per camera, one shared decode via VisionRuntime):
 *   motion — in-process gray frame-diff on the shared RGB stream.
 *   person — YOLOv8n (onnxruntime-node, CPU) + IoU tracker + zones.
 *   face   — YuNet detection + face tracking + SFace recognition against
 *            enrolled profiles (opt-in, People registry).
 *   object — same YOLO engine as person, configured via ai.classes.
 * EYE-023 adds scene observation folding and (planned) VLM descriptions.
 */

export class MotionProvider {
  constructor(driver) {
    this.driver = driver
    this.running = false
    this.stats = { startedAt: null, frames: 0, events: 0, suppressed: 0, lastEventAt: null, lastDiff: 0, lastMotionAt: null }
    this.recentDiffs = []   // last 3 frame diffs — temporal persistence window
    this.relay = null
    this.source = null
    this.prev = null
    this.partial = Buffer.alloc(0)
    this.lastEventTs = 0
    this.triggeredGroupAt = 0
  }

  /** VisionRuntime consumer: no own decode, gray is derived from shared RGB. */
  async start({ channel } = {}) {
    if (this.running) return
    const settings = getProductSettings()
    this.width = 160
    this.height = 90
    this.frameSize = this.width * this.height
    this.running = true
    this.state = 'active'
    this.stats.startedAt = new Date().toISOString()
    log.info(`motion detection active for ${this.driver.id} (threshold ${settings.motion.threshold})`)
  }

  stop(reason = 'settings') {
    this.running = false
    this.state = reason === 'error' ? 'error' : 'inactive'
    this.prev = null
  }

  /** Process one shared RGB frame: content region → strided 160×90 gray. */
  process(frame) {
    if (!this.running) return
    const c = frame.content
    const W = this.width, H = this.height
    const sx = Math.max(1, Math.floor(c.w / W))
    const sy = Math.max(1, Math.floor(c.h / H))
    const gray = Buffer.allocUnsafe(this.frameSize)
    for (let gy = 0; gy < H; gy++) {
      const srcRow = (c.y + Math.min(c.h - 1, gy * sy)) * frame.width
      for (let gx = 0; gx < W; gx++) {
        const j = (srcRow + c.x + Math.min(c.w - 1, gx * sx)) * 3
        gray[gy * W + gx] = (frame.rgb[j] * 77 + frame.rgb[j + 1] * 150 + frame.rgb[j + 2] * 29) >> 8
      }
    }
    this.stats.frames += 1
    this._onFrame(gray)
  }

  _onFrame(frame) {
    const settings = getProductSettings()
    if (!this.prev) {
      this.prev = Buffer.from(frame)
      return
    }
    let sum = 0
    for (let i = 0; i < frame.length; i += 3) {
      sum += Math.abs(frame[i] - this.prev[i])
    }
    const sampled = frame.length / 3
    const diff = (sum / sampled) / 255
    this.stats.lastDiff = diff
    // continuous movement evidence (independent of the event threshold):
    // any visible pixel change counts as "the scene moved recently"
    if (diff > 0.005) this.stats.lastMotionAt = new Date().toISOString()
    this.prev = Buffer.from(frame)

    // Temporal persistence gate (EYE-025): sensor/H.264 noise produces isolated
    // above-threshold spikes, real scene movement sustains across frames at the
    // analysis fps. Measured on the C520WS sub-stream: the noise floor sits at
    // 0.010–0.016 mean abs diff (3247 single-frame events in one day when the
    // threshold was set to 0.01), while genuine movement yields sustained
    // above-threshold frames. Require 2 of the last 3 diffs at/above
    // threshold so a one-frame spike can never become an event.
    this.recentDiffs.push(diff)
    if (this.recentDiffs.length > 3) this.recentDiffs.shift()

    if (diff < settings.motion.threshold) return
    const above = this.recentDiffs.filter(d => d >= settings.motion.threshold).length
    if (above < 2) {
      this.stats.suppressed += 1
      return
    }
    const now = Date.now()
    if (now - this.lastEventTs < settings.motion.minIntervalSec * 1000) return
    this.lastEventTs = now
    this.stats.events += 1
    this.stats.lastEventAt = new Date().toISOString()
    this._emitEvent(diff, frame)
  }

  async _emitEvent(confidence, frame) {
    try {
      const thumbDir = path.join(config.storage.mediaDir, 'events', this.driver.id)
      fs.mkdirSync(thumbDir, { recursive: true })
      const thumbPath = path.join(thumbDir, `${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}-${newId().slice(0, 6)}.jpg`)
      const jpeg = await grayFrameToJpeg(frame, this.width, this.height)
      fs.writeFileSync(thumbPath, jpeg)
      publishEvent('motion', this.driver.id, `motion detected (score ${confidence.toFixed(3)})`, { confidence, thumbPath })
      log.info(`motion event: ${this.driver.id} score=${confidence.toFixed(3)}`)
      await this._runAutomations(confidence)
    } catch (error) {
      log.warn(`motion event processing failed: ${error.message}`)
    }
  }

  async _runAutomations(confidence) {
    const settings = getProductSettings()
    if (settings.automations.motionNotify.enabled) {
      // notification = SSE broadcast (already done via eventBus) — nothing more
    }
    const auto = settings.automations.motionRecord
    if (!auto.enabled || !settings.privacy.recordingEnabled) return
    const now = Date.now()
    if (now - this.triggeredGroupAt < auto.cooldownSec * 1000 && activeRecordings().includes(this.driver.id)) {
      // already rolling from this trigger chain — extend the quiet window
      try { await extendEventRecording(this.driver.id) } catch { /* */ }
      return
    }
    if (activeRecordings().includes(this.driver.id)) return
    if (now - this.triggeredGroupAt < auto.cooldownSec * 1000) return
    this.triggeredGroupAt = now
    try {
      const { startEventRecording, extendEventRecording } = await import('./recordings.js')
      const result = await startEventRecording(this.driver, {
        trigger: 'motion',
        postEventSec: settings.recording?.postEventSec ?? 10,
        maxSec: settings.recording?.maxSec ?? 300,
        preBufferGops: Math.max(0, Math.round(settings.motion.preBufferGops ?? 0)),
      })
      if (result.ok) {
        log.info(`automation: motion → event recording (quiet-stop ${settings.recording?.postEventSec ?? 10}s, cap ${settings.recording?.maxSec ?? 300}s)`)
        if (result.extended) await extendEventRecording(this.driver.id)
      }
    } catch (error) {
      log.warn(`automation recording failed: ${error.message}`)
    }
  }
}

export class IntelligenceManager {
  constructor() {
    this.runtimes = new Map()   // cameraId -> {driver, runtime, motion, person, scene, refreshTimer}
    this.sceneTimers = new Map()
    // camera health changes must expire scene observations immediately —
    // a degraded camera must never report "fresh" scene state
    this.healthHandler = event => {
      if (event.type !== 'health.changed') return
      const ctx = this.runtimes.get(event.cameraId)
      const nowHealthy = event.detail?.includes('-> healthy') ?? false
      ctx?.scene.setOnline(nowHealthy)
    }
    eventBus.on('event', this.healthHandler)
    // VLM: optional local visual reasoning. Describes new person/object
    // events (bounded queue, cooldown) — never on the media path.
    this.vlm = new VlmQueue(new OllamaProvider(), { cooldownMs: 60_000 })
    this.vlmHandler = event => this._maybeDescribeEvent(event)
    eventBus.on('event', this.vlmHandler)
  }

  /** Event-triggered visual description (opt-in, evidence-bearing only). */
  _maybeDescribeEvent(event) {
    try {
      const settings = getProductSettings()
      if (!settings.privacy.aiEnabled || !settings.aiVision.enabled || !settings.aiVision.describeEvents) return
      const kinds = ['person', 'person_known', 'person_unknown', 'recognition_uncertain', 'object', 'visit.summary']
      if (!kinds.includes(event.type)) return
      if (!event.thumb || !fs.existsSync(event.thumb)) return
      const eventId = event.id
      const cameraId = event.cameraId
      const jpeg = fs.readFileSync(event.thumb)
      this.vlm.cooldownMs = settings.aiVision.cooldownSec * 1000
      this.vlm.submit({
        cameraId,
        jpeg,
        question: 'This is an image from a security camera at the moment an event was detected. Describe what is visible and what appears to be happening. If you cannot tell what a person is doing, say so.',
        onDone: result => {
          if (!result.ok) return
          this._storeEventDescription(eventId, result)
        },
      })
    } catch { /* description is best-effort */ }
  }

  /** Store one VLM description with provenance (model, time, uncertainty). */
  _storeEventDescription(eventId, result) {
    try {
      db.prepare('INSERT INTO event_descriptions (event_id, at, model, text, kind) VALUES (?, ?, ?, ?, ?)')
        .run(eventId, result.at, result.model, result.text, result.uncertain ? 'uncertain' : 'description')
      db.prepare('UPDATE events SET description = ? WHERE id = ? AND (description IS NULL OR description = \'\')')
        .run(result.text, eventId)
      log.info(`vlm: described event ${eventId} (${result.model}, ${result.ms}ms${result.uncertain ? ', uncertain' : ''})`)
    } catch (error) {
      log.warn(`vlm: storing description failed: ${error.message}`)
    }
  }

  setDrivers(drivers) {
    this.drivers = drivers
  }

  _context(driver) {
    let ctx = this.runtimes.get(driver.id)
    if (ctx) return ctx
    const scene = new SceneState(driver.id)
    const motion = new MotionProvider(driver)
    const person = new PersonDetectorProvider(driver, { onEvent: event => {} })
    this.people ??= new PeopleRegistry()
    const face = new FacePipeline(driver, { peopleRegistry: this.people })
    const runtime = new VisionRuntime(driver, getHub)
    ctx = {
      driver, runtime, motion, person, face, scene, people: this.people,
      trackFirstSeen: new Map(),
      identity: new IdentityTracker({ matchThreshold: getProductSettings().face.matchThreshold }),
      postures: new Map(),      // person trackId → PostureState
      movements: new Map(),     // person trackId → MovementProfile (experimental)
    }
    this.runtimes.set(driver.id, ctx)
    // PTZ movement invalidates all box evidence: both trackers drop their
    // geometry and re-detect from post-move frames.
    const onMoved = ({ cameraId }) => {
      if (cameraId !== driver.id) return
      try { person.tracker.notifyCameraMoved() } catch { /* gone */ }
      try { face.tracker.notifyCameraMoved() } catch { /* gone */ }
      ctx.trackFirstSeen.clear()
    }
    signalBus.on('camera.moved', onMoved)
    ctx.onMoved = onMoved
    // scene refresh: fold person + face tracks into the scene at 1 Hz (cheap).
    // Track first-seen wall-clock time is maintained here (the tracker is
    // deliberately frame-indexed and clock-free for testability).
    const timer = setInterval(() => {
      try {
        const live = person.tracker.live().filter(t => t.state === 'active' || t.state === 'new')
        const now = Date.now()
        const seen = ctx.trackFirstSeen
        for (const t of live) if (!seen.has(t.trackId)) seen.set(t.trackId, now)
        for (const trackId of [...seen.keys()]) {
          if (!live.some(t => t.trackId === trackId)) seen.delete(trackId)
        }
        const withAge = live.map(t => ({ ...t, sinceAgeMs: now - (seen.get(t.trackId) ?? now) }))
        const familiarByTrack = new Map()
        for (const f of face.status().faces ?? []) {
          if (f.trackId && f.familiar) familiarByTrack.set(f.trackId, f.familiar)
        }
        scene.observe(withAge, familiarByTrack, { online: true, lastMovementAt: motion.stats.lastMotionAt })
      } catch { /* scene is best-effort */ }
    }, 1000)
    timer.unref()
    this.sceneTimers.set(driver.id, timer)
    return ctx
  }

  /** Applies desired state from settings; safe to call after any settings change. */
  async reconcile() {
    if (this.reconcileRunning) return
    this.reconcileRunning = true
    try {
      const settings = getProductSettings()
      const avail = aiAvailability()
      const wantMotion = settings.privacy.aiEnabled && settings.motion.enabled
      const wantPerson = settings.privacy.aiEnabled && settings.ai.personEnabled
      const personReady = avail.runtime && avail.model
      for (const driver of this.drivers ?? []) {
        const ctx = this._context(driver)
        const blocked = this._privacyBlocked(driver.id)
        const desired = []
        if (wantMotion && !blocked) {
          desired.push({ name: 'motion', needs: { fps: Math.min(5, Math.max(1, settings.motion.inferenceFps ?? 2)) }, factory: () => ctx.motion })
        }
        if (wantPerson && !blocked && personReady) {
          desired.push({ name: 'person', needs: { fps: Math.max(1, Math.min(5, Math.round(settings.ai.inferenceFps ?? 2))) }, factory: () => ctx.person })
        }
        if (wantPerson && !blocked && aiFacesAvailable()) {
          desired.push({ name: 'face', needs: { fps: Math.min(10, Math.max(1, Math.round(settings.face?.detectionFps ?? 5))) }, factory: () => ctx.face })
        }
        ctx.runtime.setProviders(desired)
        try {
          await ctx.runtime.reconcile()
        } catch (error) {
          log.warn(`vision runtime reconcile failed (${driver.id}): ${error.message}`)
        }
        ctx.scene.setOnline(true)
      }
      // VLM warmup: when the feature is on, preload the model once so the
      // first description doesn't pay the cold load (best-effort, off-path)
      if (settings.privacy.aiEnabled && settings.aiVision.enabled && !this._vlmWarmed) {
        this._vlmWarmed = true
        this.vlm.provider.warmup().then(ok => {
          if (ok) log.info(`vlm: ${this.vlm.provider.model} warmed up (kept in memory ${this.vlm.provider.keepAlive})`)
          else log.warn(`vlm: warmup failed: ${this.vlm.provider.lastError}`)
        })
      }
      // stop runtimes for removed cameras
      for (const [id, ctx] of this.runtimes) {
        if ((this.drivers ?? []).some(d => d.id === id)) continue
        ctx.runtime.stop()
        if (ctx.onMoved) signalBus.off('camera.moved', ctx.onMoved)
        clearInterval(this.sceneTimers.get(id))
        this.runtimes.delete(id)
      }
    } finally {
      this.reconcileRunning = false
    }
  }

  _privacyBlocked(cameraId) {
    return Boolean(db.prepare('SELECT privacy_disabled FROM camera_settings WHERE camera_id = ?').get(cameraId)?.privacy_disabled)
  }

  /**
   * AI Vision overlay payload (EYE-025): per tracked person — identity state
   * (safe labeling), posture, motion, facing. Computed on demand from live
   * tracker + face state; no inference, no media cost.
   */
  overlay(cameraId) {
    const ctx = this.runtimes.get(cameraId)
    if (!ctx) return []
    const now = Date.now()
    const settings = getProductSettings()
    const live = ctx.person.tracker.live().filter(t => t.label === 'person')
    const faceStatus = ctx.face.status()
    const familiar = new Map()
    const uncertain = new Map()
    for (const f of faceStatus.faces ?? []) {
      if (f.familiar) familiar.set(f.trackId, f.familiar)
      if (f.uncertain) uncertain.set(f.trackId, f.uncertain)
    }
    const faceBoxes = (faceStatus.faces ?? []).map(f => ({ ...f.box, faceTrackId: f.trackId }))
    const identities = ctx.identity.update(live, familiar, uncertain, faceBoxes, now)
    const experimental = settings.experimental?.movementSignature === true

    // clean per-track state for ended tracks
    const alive = new Set(live.map(t => t.trackId))
    for (const map of [ctx.postures, ctx.movements]) {
      for (const id of [...map.keys()]) if (!alive.has(id)) map.delete(id)
    }

    return live.map(t => {
      const faceHit = faceBoxes.find(f => {
        const fc = { x: f.x + f.w / 2, y: f.y + f.h / 2 }
        return Math.abs(fc.x - (t.box.x + t.box.w / 2)) < Math.max(t.box.w, f.w) &&
               Math.abs(fc.y - (t.box.y + t.box.h * 0.2)) < t.box.h * 0.5
      })
      let posture = ctx.postures.get(t.trackId)
      if (!posture) { posture = new PostureState(); ctx.postures.set(t.trackId, posture) }
      const pv = posture.update(t, Boolean(faceHit), now)
      const view = overlayView(t, identities.get(t.trackId), pv)
      if (experimental) {
        let mv = ctx.movements.get(t.trackId)
        if (!mv) { mv = new MovementProfile(); ctx.movements.set(t.trackId, mv) }
        view.movementSignature = mv.update(t, now)
      }
      return view
    })
  }

  sceneSnapshot(cameraId = null) {
    const out = []
    for (const [id, ctx] of this.runtimes) {
      if (cameraId && id !== cameraId) continue
      out.push(ctx.scene.snapshot())
    }
    return out
  }

  status() {
    const settings = getProductSettings()
    const avail = aiAvailability()
    const providers = []
    for (const [id, ctx] of this.runtimes) {
      const rs = ctx.runtime.status()
      providers.push({
        cameraId: id,
        sourceActive: rs.sourceActive,
        frames: rs.frames,
        lastFrameAt: rs.lastFrameAt,
        providers: rs.providers,
      })
    }
    const personActive = [...this.runtimes.values()].some(c => c.person.state === 'active')
    // face provider state, read from the live runtime entries (never hardcoded)
    const faceRuntimeStates = [...this.runtimes.values()]
      .map(c => c.runtime.status().providers.find(p => p.name === 'face'))
      .filter(Boolean)
    const faceActive = faceRuntimeStates.some(p => p.state === 'active')
    const faceState = !aiFacesAvailable()
      ? 'not_installed'
      : (settings.privacy.aiEnabled && faceRuntimeStates.length > 0
          ? (faceActive ? 'active' : faceRuntimeStates.some(p => p.state === 'recovering' || p.state === 'starting') ? 'starting' : 'inactive')
          : 'inactive')
    return {
      aiEnabled: settings.privacy.aiEnabled,
      availability: avail,
      motion: {
        enabled: settings.motion.enabled,
        active: [...this.runtimes.values()].some(c => c.motion.running),
        threshold: settings.motion.threshold,
        minIntervalSec: settings.motion.minIntervalSec,
        providers: [...this.runtimes.values()].map(c => ({
          cameraId: c.driver.id,
          running: c.motion.running,
          frames: c.motion.stats.frames,
          events: c.motion.stats.events,
          suppressed: c.motion.stats.suppressed,
          lastEventAt: c.motion.stats.lastEventAt,
          lastDiff: Number((c.motion.stats.lastDiff ?? 0).toFixed(4)),
        })),
      },
      person: {
        enabled: settings.ai.personEnabled,
        classes: settings.ai.classes,
        inferenceFps: settings.ai.inferenceFps,
        minConfidence: settings.ai.minConfidence,
        minIntervalSec: settings.ai.minIntervalSec,
        active: personActive,
        providers: [...this.runtimes.values()].map(c => c.person.status()),
      },
      face: {
        familiarFaceEnabled: settings.privacy.familiarFaceEnabled,
        detectionScore: settings.face.detectionScore,
        matchThreshold: settings.face.matchThreshold,
        eventIntervalSec: settings.face.eventIntervalSec,
        available: aiFacesAvailable(),
        enrolledCount: this.people?.enrolledEmbeddings()?.length ?? 0,
        active: [...this.runtimes.values()].some(c => c.face.state === 'active'),
        providers: [...this.runtimes.values()].map(c => c.face.status()),
      },
      scene: this.sceneSnapshot(),
      vision: providers,
      aiVision: {
        enabled: settings.aiVision.enabled,
        describeEvents: settings.aiVision.describeEvents,
        cooldownSec: settings.aiVision.cooldownSec,
        ...this.vlm.status(),
      },
      providers: [
        { id: 'motion', label: 'Motion detection', state: settings.privacy.aiEnabled && settings.motion.enabled ? 'active' : 'inactive', engine: 'in-process frame diff (shared decode)' },
        {
          id: 'person',
          label: 'Person & object detection (local YOLOv8n)',
          state: !avail.runtime || !avail.model
            ? 'not_installed'
            : (settings.privacy.aiEnabled && settings.ai.personEnabled ? (personActive ? 'active' : 'starting') : 'inactive'),
          engine: 'onnxruntime-node (CPU) + YOLOv8n via VisionRuntime',
        },
        { id: 'face', label: 'Face detection / familiar-face recognition', state: faceState, engine: 'YuNet + SFace via VisionRuntime (opt-in recognition)', note: 'Enroll in People; recognition runs only while familiarFaceEnabled' },
        { id: 'object', label: 'Object detection', state: settings.ai.classes?.some(c => c !== 'person') && personActive ? 'active' : 'available', note: 'Same engine as person detection; configure ai.classes' },
      ],
    }
  }

  stopAll() {
    for (const [id, ctx] of this.runtimes) {
      ctx.runtime.stop()
      ctx.motion.stop()
      ctx.person.stop()
      ctx.face.stop()
      if (ctx.onMoved) signalBus.off('camera.moved', ctx.onMoved)
      clearInterval(this.sceneTimers.get(id))
    }
    this.runtimes.clear()
    eventBus.off('event', this.healthHandler)
    eventBus.off('event', this.vlmHandler)
    signalBus.removeAllListeners('camera.moved')
  }
}

export function listEvents({ cameraId = null, type = null, since = null, limit = 100 } = {}) {
  const rows = db.prepare(`SELECT id, at, type, camera_id, detail, confidence, thumb_path,
        provider, track_id, person_id, zone, correlation_id, clip_path, description FROM events
      WHERE (? IS NULL OR camera_id = ?) AND (? IS NULL OR type = ?) AND (? IS NULL OR at >= ?)
      ORDER BY id DESC LIMIT ?`)
    .all(cameraId, cameraId, type, type, since, since, limit)
  return rows.map(r => ({
    id: r.id,
    at: r.at,
    type: r.type,
    cameraId: r.camera_id,
    detail: r.detail,
    confidence: r.confidence,
    thumbUrl: r.thumb_path ? `/api/events/${r.id}/thumb` : null,
    provider: r.provider,
    trackId: r.track_id,
    personId: r.person_id,
    zone: r.zone,
    correlationId: r.correlation_id,
    clipPath: r.clip_path,
    description: r.description,
  }))
}

export function eventThumb(id) {
  const row = db.prepare('SELECT thumb_path FROM events WHERE id = ?').get(id)
  if (!row?.thumb_path || !fs.existsSync(row.thumb_path)) return null
  return fs.readFileSync(row.thumb_path)
}
