/**
 * IoU tracker (ByteTrack-inspired, dependency-free).
 *
 * Pure and deterministic: operates on detection arrays per frame, no clock
 * dependency (frame indices only), so it is fully unit-testable with
 * synthetic sequences. Wall-clock timestamps are optional (inject a `now`
 * function); without one, only frame indices are maintained.
 *
 * Matching: two-stage greedy IoU — high-confidence detections first, then
 * remaining low-confidence ones (ByteTrack's key idea: low-score detections
 * help bridge short occlusions without spawning tracks). Matching runs
 * against a constant-velocity *prediction* of each track's box, so brief
 * detection failures and slow motion keep their track instead of id-swapping.
 *
 * Track lifecycle: 'new' (tentative until minHits) → 'active' → 'lost'
 * (missed maxAge frames) → removed. Events are emitted as plain objects:
 * appeared / disappeared / entered_zone / exited_zone (with dwell and, where
 * derivable, direction of travel).
 *
 * Track IDs are opaque correlation handles. They are NOT identities.
 * Camera movement (PTZ) invalidates box evidence: notifyCameraMoved() forces
 * all tracks to 'lost' so post-move detections re-associate only through
 * fresh evidence, never through pre-move geometry.
 */

let nextTrackId = 1
export function _resetTrackIds(forTests = 1) { nextTrackId = forTests }

const DEFAULTS = {
  iouThreshold: 0.3,     // min IoU to match a detection to a track
  minHits: 2,            // consecutive hits before a track becomes active
  maxAge: 12,            // frames a track survives without a match
  lowConfMin: 0.15,      // second-stage floor
  velocityDecay: 0.8,    // prediction damping per missed frame
  maxPredictFrames: 4,   // never predict further than this many frames
}

// minimum normalized center displacement (per frame) to call a direction
const DIRECTION_EPSILON = 0.004

export class Tracker {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options }
    this.tracks = new Map()   // id -> track
    this.frameIndex = 0
    this.now = options.now ?? null   // optional wall-clock source
  }

  /**
   * Process one frame of detections.
   * @param detections [{label, score, x, y, w, h}] — normalized box coords
   *                   (x,y = top-left). Confidence split at `lowConfSplit`
   *                   (default 0.5× the caller's floor, minimum lowConfMin).
   * @param zones {name: points} — optional, for enter/exit computation
   * @returns events [] — appeared, disappeared, entered_zone, exited_zone
   */
  update(detections, zones = null) {
    this.frameIndex += 1
    const events = []
    const split = Math.max(this.opts.lowConfMin, (this.opts.confFloor ?? 0.45) * 0.5)
    const high = detections.filter(d => d.score >= split)
    const low = detections.filter(d => d.score < split)

    const unmatchedTracks = new Set([...this.tracks.values()].filter(t => t.state !== 'removed').map(t => t.id))

    // stage 1: high-confidence detections, matched against predicted boxes
    const m1 = this._match(high, unmatchedTracks)
    // stage 2: low-confidence rescue against still-unmatched tracks
    const m2 = this._match(low, m1.unmatchedTracks)

    for (const [det, track] of [...m1.pairs, ...m2.pairs]) {
      det.trackId = track.id   // caller can map detections back to tracks
      this._hit(track, det, zones, events)
    }

    // unmatched detections → new tentative tracks
    for (const det of [...m1.unmatchedDets, ...m2.unmatchedDets]) {
      const track = {
        id: nextTrackId++,
        label: det.label,
        score: det.score,
        box: { ...det },
        state: 'new',
        hits: 1,
        age: 0,
        firstSeen: this.frameIndex,
        lastSeen: this.frameIndex,
        firstSeenAt: this.now ? this.now() : null,
        lastSeenAt: this.now ? this.now() : null,
        zones: zoneKeys(det, zones),
        enteredAt: {},
        velocity: { x: 0, y: 0 },
        direction: 'stationary',
      }
      this.tracks.set(track.id, track)
      unmatchedTracks.add(track.id)
      events.push({ type: 'appeared', trackId: track.id, label: det.label, score: det.score, box: { ...det }, at: this.frameIndex })
      // a person appearing inside a zone has entered it (creation transition)
      for (const z of track.zones) {
        track.enteredAt[z] = this.frameIndex
        events.push({ type: 'entered_zone', trackId: track.id, label: det.label, zone: z, box: { ...det }, at: this.frameIndex })
      }
    }

    // age unmatched tracks; activate new ones with enough hits; remove stale
    for (const track of this.tracks.values()) {
      if (track.lastSeen === this.frameIndex) {
        if (track.state === 'new' && track.hits >= this.opts.minHits) track.state = 'active'
        continue
      }
      track.age += 1
      if (track.state === 'new' || track.state === 'active') {
        if (track.age >= this.opts.maxAge) {
          track.state = 'removed'
          events.push({ type: 'disappeared', trackId: track.id, label: track.label, box: { ...track.box }, at: this.frameIndex, dwellFrames: track.lastSeen - track.firstSeen, direction: track.direction })
          this.tracks.delete(track.id)
          unmatchedTracks.delete(track.id)
        } else if (track.state === 'active') {
          track.state = 'lost'
        }
      } else if (track.state === 'lost' && track.age >= this.opts.maxAge) {
        track.state = 'removed'
        events.push({ type: 'disappeared', trackId: track.id, label: track.label, box: { ...track.box }, at: this.frameIndex, dwellFrames: track.lastSeen - track.firstSeen, direction: track.direction })
        this.tracks.delete(track.id)
        unmatchedTracks.delete(track.id)
      }
    }
    return events
  }

  /** Predicted box: last box advanced by damped velocity for `age` frames. */
  _predictedBox(track) {
    const age = Math.min(this.frameIndex - track.lastSeen, this.opts.maxPredictFrames)
    if (age <= 0) return track.box
    const damp = this.opts.velocityDecay ** age
    const dx = track.velocity.x * age * damp
    const dy = track.velocity.y * age * damp
    return { ...track.box, x: track.box.x + dx, y: track.box.y + dy }
  }

  /**
   * Greedy matching, detections ordered by confidence (high first — the
   * ByteTrack two-stage ordering). Each detection takes its best-IoU
   * same-label track (IoU against the track's predicted box); each track
   * matches at most once per stage.
   */
  _match(detections, unmatchedTrackIds) {
    const pairs = []
    const unmatchedDets = []
    const unmatched = new Set(unmatchedTrackIds)
    const ordered = [...detections].sort((a, b) => b.score - a.score)
    for (const det of ordered) {
      let best = null
      let bestIou = this.opts.iouThreshold
      for (const trackId of unmatched) {
        const track = this.tracks.get(trackId)
        if (track.label !== det.label) continue
        const overlap = iou(det, this._predictedBox(track))
        if (overlap > bestIou) { best = track; bestIou = overlap }
      }
      if (best) {
        unmatched.delete(best.id)
        pairs.push([det, best])
      } else {
        unmatchedDets.push(det)
      }
    }
    return { pairs, unmatchedTracks: unmatched, unmatchedDets }
  }

  _hit(track, det, zones, events) {
    const prevCenter = center(track.box)
    track.box = { ...det }
    track.score = det.score
    track.hits += 1
    track.age = 0
    track.lastSeen = this.frameIndex
    if (this.now) track.lastSeenAt = this.now()
    if (track.state === 'lost') track.state = 'active'
    const c = center(det)
    track.velocity = { x: c.x - prevCenter.x, y: c.y - prevCenter.y }
    track.direction = classifyDirection(track.velocity)
    if (zones) {
      const now = zoneKeys(det, zones)
      for (const z of now) {
        if (!track.zones.includes(z)) {
          track.zones.push(z)
          track.enteredAt[z] = this.frameIndex
          events.push({ type: 'entered_zone', trackId: track.id, label: det.label, zone: z, box: { ...det }, at: this.frameIndex, direction: track.direction })
        }
      }
      for (const z of [...track.zones]) {
        if (!now.includes(z)) {
          track.zones = track.zones.filter(k => k !== z)
          events.push({ type: 'exited_zone', trackId: track.id, label: det.label, zone: z, box: { ...det }, at: this.frameIndex, dwellFrames: this.frameIndex - (track.enteredAt[z] ?? track.firstSeen), direction: track.direction })
          delete track.enteredAt[z]
        }
      }
    }
  }

  /**
   * Camera moved (PTZ): all box evidence is stale. Active/new tracks become
   * 'lost' immediately; if the same subject is found after the move, it will
   * appear as a fresh track (new ID) — honest re-detection beats keeping a
   * stale-geometry association alive.
   */
  notifyCameraMoved() {
    for (const track of this.tracks.values()) {
      if (track.state === 'active' || track.state === 'new') {
        track.state = 'lost'
        track.age = Math.max(track.age, Math.floor(this.opts.maxAge / 2))
      }
    }
  }

  /** Active + tentative tracks (what the scene reports). */
  live() {
    return [...this.tracks.values()].filter(t => t.state === 'active' || t.state === 'new')
      .map(t => ({
        trackId: t.id, label: t.label, score: t.score, box: { ...t.box },
        state: t.state, hits: t.hits, sinceFrame: t.firstSeen, velocity: { ...t.velocity },
        direction: t.direction, zones: [...t.zones],
        firstSeenAt: t.firstSeenAt, lastSeenAt: t.lastSeenAt,
      }))
  }

  dwellSeconds(trackId, fps) {
    const t = this.tracks.get(trackId)
    if (!t) return null
    return (this.frameIndex - t.firstSeen) / (fps || 1)
  }
}

function center(b) { return { x: b.x + b.w / 2, y: b.y + b.h / 2 } }

/** Dominant-axis movement direction from per-frame velocity. */
export function classifyDirection(velocity) {
  const { x, y } = velocity ?? {}
  const ax = Math.abs(x ?? 0)
  const ay = Math.abs(y ?? 0)
  if (Math.max(ax, ay) < DIRECTION_EPSILON) return 'stationary'
  if (ax >= ay) return x > 0 ? 'right' : 'left'
  return y > 0 ? 'down' : 'up'
}

export function iou(a, b) {
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.w, b.x + b.w)
  const y1 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  return inter / (a.w * a.h + b.w * b.h - inter)
}

function zoneKeys(det, zones) {
  if (!zones) return []
  const c = center(det)
  const keys = []
  for (const [name, points] of Object.entries(zones)) {
    if (pointInPolygon(c.x, c.y, points)) keys.push(name)
  }
  return keys
}

export function pointInPolygon(x, y, points) {
  if (!Array.isArray(points) || points.length < 3) return true
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}
