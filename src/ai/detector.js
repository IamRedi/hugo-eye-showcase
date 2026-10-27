import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { config } from '../config.js'
import { db, newId } from '../db.js'
import { log } from '../log.js'
import { getProductSettings, cameraPrivacyBlocked } from '../settings.js'
import { rgbFrameToJpeg } from '../camera/ffmpeg.js'
import { publishEvent } from '../eventbus.js'
import { Tracker } from '../vision/tracker.js'

/**
 * PersonDetectorProvider — real local object detection (YOLOv8n via ONNX
 * Runtime, CPU execution provider). Runs against the RelayHub's sub-stream:
 * a dedicated tiny RGB decode (letterboxed 640×640 at the configured
 * inference fps) feeds the session; results are decoded, NMS-filtered,
 * zone-checked, deduplicated and persisted as typed events with thumbnails.
 *
 * Honest states: 'not_installed' (runtime or model missing), 'inactive'
 * (privacy/opt-in gates off), 'starting', 'active', 'error'.
 * Privacy: inference is strictly local; nothing leaves the machine; the
 * provider only runs when aiEnabled AND personEnabled are both true.
 */

const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake',
  'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop',
  'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
  'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
  'toothbrush',
]

const MODEL_REL = path.join('models', 'yolov8n.onnx')
const INPUT_SIZE = 640
const CONF_DEFAULT = 0.45
const IOU_THRESHOLD = 0.45
const MAX_FAILURES = 5

/** Resolves the runtime availability without importing (cheap, no crash). */
export function aiAvailability() {
  const modelPath = path.join(config.storage.dataDir, MODEL_REL)
  let available = false
  try {
    createRequire(import.meta.url).resolve('onnxruntime-node')
    available = true
  } catch { /* not installed */ }
  return {
    runtime: available,
    model: fs.existsSync(modelPath),
    modelPath,
    expectedSha256: 'adda0231eeb47d888199927f6caf7b46dacaf91bad5bfeea63fde3ebd5d7846f',
  }
}

import { loadSession } from './sessions.mjs'

/**
 * PersonDetectorProvider — VisionRuntime consumer. Implements
 * process(frame) and is supervised by the runtime; frames arrive latest-wins
 * from the shared decode, so a slow inference simply skips frames.
 */
export class PersonDetectorProvider {
  constructor(driver, { onSceneChange = null, onEvent = null } = {}) {
    this.driver = driver
    this.state = 'inactive'
    this.stats = { startedAt: null, inferences: 0, detections: 0, events: 0, lastEventAt: null, lastLatencyMs: 0, failures: 0 }
    this.session = null
    this.ort = null
    this.tracker = new Tracker({ confFloor: 0.45, minHits: 2, maxAge: 12 })
    this.lastEventTs = new Map()   // `${label}:${trackId}` → ts (correlated, not per-frame)
    this.onSceneChange = onSceneChange
    this.onEvent = onEvent
  }

  async start() {
    const avail = aiAvailability()
    if (!avail.runtime || !avail.model) {
      this.state = 'not_installed'
      return
    }
    if (this.session) { this.state = 'active'; return }
    this.state = 'starting'
    try {
      ({ ort: this.ort, session: this.session } = await loadSession(avail.modelPath))
    } catch (error) {
      this.state = 'error'
      this.lastError = `inference runtime failed to load: ${error.message}`
      log.error(`person detector (${this.driver.id}): ${this.lastError}`)
      throw error
    }
    this.stats.startedAt = new Date().toISOString()
    this.state = 'active'
    log.info(`person detection active for ${this.driver.id} (yolov8n cpu)`)
  }

  stop(reason = 'settings') {
    this.session = null
    this.ort = null
    this.state = reason === 'error' ? 'error' : 'inactive'
  }

  /**
   * Process one shared frame: letterbox the content region into the model's
   * square input, infer, decode, track, zone-filter, emit correlated events.
   */
  async process(frame) {
    if (this.state !== 'active' || !this.session) return
    const t0 = Date.now()
    const settings = getProductSettings()
    const detections = await this._infer(frame, settings)
    this.stats.inferences += 1
    this.stats.lastLatencyMs = Date.now() - t0
    this._processDetections(detections, frame, settings)
  }

  async _infer(frame, settings) {
    const c = frame.content
    const n = INPUT_SIZE * INPUT_SIZE
    const data = new Float32Array(3 * n)
    // content region of the letterboxed decode, stretched to the square input
    for (let oy = 0; oy < INPUT_SIZE; oy++) {
      const srcY = c.y + Math.min(c.h - 1, Math.floor(oy * c.h / INPUT_SIZE))
      const rowOff = srcY * frame.width
      const outRow = oy * INPUT_SIZE
      for (let ox = 0; ox < INPUT_SIZE; ox++) {
        const srcX = c.x + Math.min(c.w - 1, Math.floor(ox * c.w / INPUT_SIZE))
        const j = (rowOff + srcX) * 3
        const i = outRow + ox
        data[i] = frame.rgb[j] / 255
        data[n + i] = frame.rgb[j + 1] / 255
        data[2 * n + i] = frame.rgb[j + 2] / 255
      }
    }
    const input = new this.ort.Tensor('float32', data, [1, 3, INPUT_SIZE, INPUT_SIZE])
    const results = await this.session.run({ images: input })
    const out = results[this.session.outputNames[0]]
    return decodeDetections(out, {
      minConf: settings.ai.minConfidence ?? CONF_DEFAULT,
      classes: settings.ai.classes?.length ? settings.ai.classes : ['person'],
    })
  }

  _processDetections(detections, frame, settings) {
    // model (stretched content) space → content-normalized (= live-normalized)
    const boxes = detections.map(d => ({
      label: d.label,
      score: d.score,
      x: clamp01((d.cx - d.w / 2) / INPUT_SIZE),
      y: clamp01((d.cy - d.h / 2) / INPUT_SIZE),
      w: clamp01(d.w / INPUT_SIZE),
      h: clamp01(d.h / INPUT_SIZE),
    }))
    const zone = getCameraZone(this.driver.id)
    const filtered = zone
      ? boxes.filter(b => pointInPolygon(b.x + b.w / 2, b.y + b.h / 2, zone.points))
      : boxes
    if (filtered.length) this.stats.detections += filtered.length

    // tracking gives correlation + appeared/disappeared semantics
    const trackEvents = this.tracker.update(filtered, zone ? { zone: zone.points } : null)
    this._emitTrackEvents(trackEvents, frame, settings)

    // per-track detection events (deduped by track presence, not per frame)
    const now = Date.now()
    const minInterval = Math.max(2, settings.ai.minIntervalSec ?? 30) * 1000
    for (const t of this.tracker.live()) {
      if (t.state !== 'active') continue
      const key = `${t.label}:${t.trackId}`
      const last = this.lastEventTs.get(key) ?? 0
      if (now - last < minInterval) continue
      this.lastEventTs.set(key, now)
      void this._emitDetection(t, frame, settings)
    }
  }

  _emitTrackEvents(trackEvents, frame, settings) {
    for (const ev of trackEvents) {
      if (ev.type === 'appeared' && ev.label !== 'person') {
        // object arrival is the correlated signal (replaces per-frame events)
        void this._emitDetection({ label: ev.label, trackId: ev.trackId, score: ev.score, box: ev.box }, frame, settings, 'entered')
      }
      // person appeared/disappeared feed the scene state (handled via tracker.live())
    }
  }

  async _emitDetection(track, frame, settings, phase = 'present') {
    const isPerson = track.label === 'person'
    try {
      const thumbDir = path.join(config.storage.mediaDir, 'events', this.driver.id)
      fs.mkdirSync(thumbDir, { recursive: true })
      const thumbPath = path.join(thumbDir, `${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}-${newId().slice(0, 6)}.jpg`)
      const box = {
        xNorm: track.box.x, yNorm: track.box.y, wNorm: track.box.w, hNorm: track.box.h,
      }
      const jpeg = await rgbFrameToJpeg(frame.rgb, frame.width, frame.height, box)
      fs.writeFileSync(thumbPath, jpeg)
      const detail = isPerson
        ? `person ${phase} (confidence ${track.score.toFixed(2)}, track ${track.trackId})`
        : `${track.label} ${phase} (confidence ${track.score.toFixed(2)})`
      const event = publishEvent(isPerson ? 'person' : 'object', this.driver.id, detail, {
        confidence: track.score,
        thumbPath,
        provider: 'person',
        trackId: track.trackId,
        label: track.label,
      })
      event.phase = phase
      event.box = { x: track.box.x, y: track.box.y, w: track.box.w, h: track.box.h }
      this.onEvent?.(event)
      this.stats.events += 1
      this.stats.lastEventAt = new Date().toISOString()
      log.info(`detection event: ${this.driver.id} ${track.label} ${phase} score=${track.score.toFixed(2)}`)
      await this._runAutomations(track)
    } catch (error) {
      log.warn(`detection event processing failed: ${error.message}`)
    }
  }

  async _runAutomations(track) {
    const settings = getProductSettings()
    const auto = settings.automations.motionRecord
    if (!auto.enabled || !settings.privacy.recordingEnabled) return
    if (Date.now() - (this._lastAutoTs ?? 0) < auto.cooldownSec * 1000) {
      // inside cooldown but the rolling window should extend while detections continue
      try { await extendEventRecording(this.driver.id) } catch { /* */ }
      return
    }
    this._lastAutoTs = Date.now()
    try {
      const { startEventRecording, extendEventRecording } = await import('../recordings.js')
      const result = await startEventRecording(this.driver, {
        trigger: `ai_${track.label}`,
        postEventSec: settings.recording?.postEventSec ?? 10,
        maxSec: settings.recording?.maxSec ?? 300,
        preBufferGops: Math.max(0, Math.round(settings.motion.preBufferGops ?? 0)),
      })
      if (result.ok && result.extended) await extendEventRecording(this.driver.id)
      if (result.ok) log.info(`automation: ${track.label} → event recording (${this.driver.id})`)
    } catch (error) {
      log.warn(`automation recording failed: ${error.message}`)
    }
  }

  status() {
    return {
      cameraId: this.driver.id,
      state: this.state,
      lastError: this.lastError ?? null,
      stats: this.stats,
      live: this.tracker.live().filter(t => t.state === 'active'),
    }
  }
}

// ---------- decode / geometry / helpers ----------

/**
 * YOLOv8 output decode: tensor [1, 4+C, N] (xywh + per-class scores).
 * Returns model-space detections sorted by confidence after NMS.
 */
export function decodeDetections(out, { minConf = CONF_DEFAULT, classes = ['person'] } = {}) {
  const [_, channels, boxes] = out.dims
  const raw = out.data
  const wanted = new Set(classes)
  const candidates = []
  for (let i = 0; i < boxes; i++) {
    let bestScore = 0
    let bestClass = -1
    for (let c = 4; c < channels; c++) {
      const score = raw[c * boxes + i]
      if (score > bestScore) { bestScore = score; bestClass = c - 4 }
    }
    if (bestScore < minConf || bestClass < 0) continue
    const label = COCO_CLASSES[bestClass]
    if (!label || !wanted.has(label)) continue
    candidates.push({
      label,
      score: bestScore,
      cx: raw[0 * boxes + i], cy: raw[1 * boxes + i],
      w: raw[2 * boxes + i], h: raw[3 * boxes + i],
    })
  }
  return nms(candidates, IOU_THRESHOLD)
}

function nms(candidates, iouThreshold) {
  candidates.sort((a, b) => b.score - a.score)
  const kept = []
  for (const cand of candidates) {
    if (kept.every(k => iou(k, cand) < iouThreshold)) kept.push(cand)
    if (kept.length >= 20) break
  }
  return kept
}

function iou(a, b) {
  const a0 = a.cx - a.w / 2, a1 = a.cy - a.h / 2
  const b0 = b.cx - b.w / 2, b1 = b.cy - b.h / 2
  const x0 = Math.max(a0, b0), y0 = Math.max(a1, b1)
  const x1 = Math.min(a0 + a.w, b0 + b.w), y1 = Math.min(a1 + a.h, b1 + b.h)
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  return inter / (a.w * a.h + b.w * b.h - inter)
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v))
}

import { pointInPolygon as _pip } from '../vision/tracker.js'
export const pointInPolygon = _pip

// ---------- per-camera zones (normalized polygon) ----------

export function getCameraZone(cameraId) {
  const raw = db.prepare('SELECT value FROM kv WHERE key = ?').get(`zone:${cameraId}`)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw.value)
    if (parsed && Array.isArray(parsed.points) && parsed.points.length >= 3) return parsed
    return null
  } catch {
    return null
  }
}

export function setCameraZone(cameraId, zone) {
  if (!zone || !Array.isArray(zone.points)) {
    db.prepare('DELETE FROM kv WHERE key = ?').run(`zone:${cameraId}`)
    return null
  }
  const points = zone.points
    .map(p => [Number(p[0]), Number(p[1])])
    .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))])
    .slice(0, 32)
  if (points.length < 3) {
    db.prepare('DELETE FROM kv WHERE key = ?').run(`zone:${cameraId}`)
    return null
  }
  const value = JSON.stringify({ points })
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`zone:${cameraId}`, value)
  return { points }
}

export { COCO_CLASSES }
