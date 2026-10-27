import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { newId } from '../db.js'
import { log } from '../log.js'
import { getProductSettings } from '../settings.js'
import { eventBus, publishEvent } from '../eventbus.js'
import { Tracker } from '../vision/tracker.js'
import { FaceDetector } from './faceDetect.js'
import { FaceEmbedder, DEFAULT_MATCH_THRESHOLD, MIN_FACE_PX } from './faceEmbed.js'
import { rgbFrameToJpeg } from '../camera/ffmpeg.js'

/**
 * FacePipeline — VisionRuntime provider (Gate 4).
 *
 * Strictly separated stages:
 *   1. face detected   — YuNet box in one frame
 *   2. face tracked    — same face across frames (IoU + landmark proximity)
 *   3. person identified — embedding matched to an ENROLLED, ENABLED profile
 *                          with calibrated confidence. Nothing else.
 *
 * Recognition is opt-in (privacy.familiarFaceEnabled), fully local, and a
 * face that does not reach the threshold stays UNKNOWN — never a guess.
 * Events are correlated per track-presence (one arrival event per presence,
 * not one per frame) with a recognition-debounce window.
 */

export class FacePipeline {
  constructor(driver, { peopleRegistry = null } = {}) {
    this.driver = driver
    this.people = peopleRegistry
    this.detector = new FaceDetector({ scoreThreshold: 0.5 })
    this.embedder = new FaceEmbedder()
    this.tracker = new Tracker({ confFloor: 0.5, minHits: 2, maxAge: 15 })
    this.state = 'inactive'
    this.stats = { startedAt: null, frames: 0, faces: 0, identifications: 0, events: 0, lastEventAt: null, lastLatencyMs: 0, failures: 0 }
    this.familiarByTrack = new Map()   // faceTrackId → {personId, name, score}
    this.uncertainByTrack = new Map()  // faceTrackId → {personId, name, score} (weak band — never a claim)
    this.identifiedAt = new Map()      // `${trackId}:${personId}` → ts
    this.announcementAt = 0
    this.available = FaceDetector.available() && FaceEmbedder.available()
  }

  async start() {
    if (!this.available) {
      this.state = 'not_installed'
      return
    }
    const settings = getProductSettings()
    if (!settings.privacy.familiarFaceEnabled) {
      // detection without identification is fine; identification gates at match time
    }
    try {
      await this.detector.ensure()
    } catch (error) {
      this.state = 'error'
      this.lastError = error.message
      throw error
    }
    this.stats.startedAt = new Date().toISOString()
    this.state = 'active'
    log.info(`face pipeline active for ${this.driver.id} (yunet${FaceEmbedder.available() ? '+sface' : ''})`)
  }

  stop() {
    this.state = this.state === 'error' ? 'error' : 'inactive'
    this.familiarByTrack.clear()
    this.uncertainByTrack.clear()
    this.tracker = new Tracker({ confFloor: 0.5, minHits: 2, maxAge: 15 })
  }

  async process(frame) {
    if (this.state !== 'active') return
    const t0 = Date.now()
    const settings = getProductSettings()
    let faces
    try {
      faces = await this.detector.detect(frame.rgb, frame.width, frame.height, {
        scoreThreshold: settings.face?.detectionScore ?? 0.5,
      })
    } catch (error) {
      this.stats.failures += 1
      if (this.stats.failures % 50 === 1) log.warn(`face detect (${this.driver.id}): ${error.message}`)
      return
    }
    this.stats.frames += 1
    this.stats.lastLatencyMs = Date.now() - t0

    // faces as detections for the tracker — normalized against the CONTENT
    // rectangle (= live-video normalization; the decode is letterboxed)
    const c = frame.content
    const detections = faces.map(f => ({
      label: 'face',
      score: f.score,
      x: (f.box.x - c.x) / c.w,
      y: (f.box.y - c.y) / c.h,
      w: f.box.w / c.w,
      h: f.box.h / c.h,
      _face: f,
    }))
    const trackEvents = this.tracker.update(detections)
    this.stats.faces = this.tracker.live().length

    // recognition for newly-confirmed face tracks
    const settings2 = getProductSettings()
    const recognitionOn = settings2.privacy.familiarFaceEnabled && this.available
      && FaceEmbedder.available()
      && (this.people?.enrolledEmbeddings()?.length ?? 0) > 0
    for (const t of this.tracker.live()) {
      if (t.state !== 'active') continue
      if (this.familiarByTrack.has(t.trackId)) continue
      if (!recognitionOn) {
        // unknown-person presence events still fire (correlated) — but only
        // with real evidence: a stable track (≥3 hits) of a real-sized face,
        // announced with a crop of what was actually seen
        this._announceUnknownOnce(t, faces, frame)
        continue
      }
      const faceDet = detections.find(d => d.trackId === t.trackId)?._face
        ?? this._faceForTrack(t, faces, frame)
      if (!faceDet) continue
      if (faceDet.box.w < MIN_FACE_PX) continue
      try {
        const embedding = await this.embedder.embed(frame.rgb, frame.width, frame.height, faceDet)
        const result = await this._identify(embedding, settings2)
        if (result?.match) {
          this.familiarByTrack.set(t.trackId, result.match)
          this.stats.identifications += 1
          this._emitRecognition('person_known', t, faceDet, result.match, frame)
        } else if (result?.uncertain) {
          this._emitRecognition('recognition_uncertain', t, faceDet, result.uncertain, frame)
          this.familiarByTrack.set(t.trackId, null)  // do not retry every frame
          this.uncertainByTrack.set(t.trackId, { personId: result.uncertain.personId, name: result.uncertain.name, score: result.uncertain.score })
        } else {
          this._emitRecognition('person_unknown', t, faceDet, null, frame)
          this.familiarByTrack.set(t.trackId, null)  // stays unknown — no retry spam
          this.uncertainByTrack.delete(t.trackId)
        }
      } catch (error) {
        log.warn(`face recognition (${this.driver.id}): ${error.message}`)
      }
    }

    // clean familiar/uncertain maps for gone face tracks
    for (const trackId of [...this.familiarByTrack.keys()]) {
      if (!this.tracker.tracks.has(trackId)) this.familiarByTrack.delete(trackId)
    }
    for (const trackId of [...this.uncertainByTrack.keys()]) {
      if (!this.tracker.tracks.has(trackId)) this.uncertainByTrack.delete(trackId)
    }
  }

  _faceForTrack(track, faces, frame) {
    // locate the raw detection matching the normalized track box; the track
    // box is normalized against the CONTENT rect (letterbox-corrected), so
    // compare in the same space — fall back to nearest center within tolerance
    const c = frame.content
    let best = null
    let bestDist = Infinity
    for (const f of faces) {
      const nx = (f.box.x - c.x) / c.w
      const ny = (f.box.y - c.y) / c.h
      const dist = Math.hypot(nx - track.box.x, ny - track.box.y)
      if (dist < bestDist) { best = f; bestDist = dist }
    }
    return bestDist < 0.08 ? best : null
  }

  _identify(embedding, settings) {
    const t = settings.face?.matchThreshold ?? DEFAULT_MATCH_THRESHOLD
    return this.people?.matchEmbedding(embedding, { threshold: t }) ?? { unknown: { score: 0 } }
  }

  _announceUnknownOnce(track, faces = [], frame = null) {
    // evidence discipline: no announcement without a sustained, real-sized
    // face track — single-frame YuNet noise (TV reflections, patterns) must
    // not produce "unknown person" claims
    const MIN_HITS = 3
    const MIN_FACE_PX_ANNOUNCE = 40
    if ((track.hits ?? 0) < MIN_HITS) return
    const faceDet = this._faceForTrack(track, faces, frame)
    if (!faceDet || faceDet.box.w < MIN_FACE_PX_ANNOUNCE) return
    const now = Date.now()
    if (now - this.announcementAt < 60_000) return
    this.announcementAt = now
    this._emit('person_unknown', track, faceDet, null, 'unknown person visible', frame)
  }

  _emitRecognition(type, track, faceDet, match, frame) {
    const key = `${track.trackId}:${match?.personId ?? 'unknown'}:${type}`
    const now = Date.now()
    const last = this.identifiedAt.get(key) ?? 0
    if (now - last < (getProductSettings().face?.eventIntervalSec ?? 120) * 1000) return
    this.identifiedAt.set(key, now)
    this._emit(type, track, faceDet, match, null, frame)
  }

  _emit(type, track, faceDet, match, note, frame = null) {
    try {
      let thumbPath = null
      if (faceDet && frame) {
        const thumbDir = path.join(config.storage.mediaDir, 'events', this.driver.id)
        fs.mkdirSync(thumbDir, { recursive: true })
        thumbPath = path.join(thumbDir, `${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}-${newId().slice(0, 6)}.jpg`)
        const pad = Math.max(faceDet.box.w, faceDet.box.h) * 0.3
        const box = {
          xNorm: Math.max(0, (faceDet.box.x - pad) / frame.width),
          yNorm: Math.max(0, (faceDet.box.y - pad) / frame.height),
          wNorm: Math.min(1, (faceDet.box.w + pad * 2) / frame.width),
          hNorm: Math.min(1, (faceDet.box.h + pad * 2) / frame.height),
        }
        rgbFrameToJpeg(frame.rgb, frame.width, frame.height, box)
          .then(jpeg => fs.writeFileSync(thumbPath, jpeg))
          .catch(() => { try { fs.unlinkSync(thumbPath) } catch { /* */ } thumbPath = null })
      }
      const detail = match
        ? `${match.name} recognized (similarity ${match.score.toFixed(2)})`
        : (note ?? 'face detected (not identified)')
      publishEvent(type, this.driver.id, detail, {
        confidence: match?.score ?? track.score,
        thumbPath,
        provider: 'face',
        trackId: track.trackId,
        personId: match?.personId ?? null,
        person: match ? { id: match.personId, name: match.name, score: match.score } : null,
        label: 'face',
      })
      this.stats.events += 1
      this.stats.lastEventAt = new Date().toISOString()
      log.info(`face event: ${this.driver.id} ${type}${match ? ` (${match.name}, ${match.score.toFixed(2)})` : ''}`)
    } catch (error) {
      log.warn(`face event processing failed: ${error.message}`)
    }
  }

  status() {
    return {
      cameraId: this.driver.id,
      state: this.state,
      lastError: this.lastError ?? null,
      stats: this.stats,
      faces: this.tracker.live().map(t => ({
        trackId: t.trackId,
        score: t.score,
        box: { ...t.box },
        familiar: this.familiarByTrack.get(t.trackId) ?? null,
        uncertain: this.uncertainByTrack.get(t.trackId) ?? null,
      })),
    }
  }
}

