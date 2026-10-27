/**
 * Posture / motion / facing inference (EYE-025 Layer 4).
 *
 * Bounded, evidence-based heuristics over the person tracker's box and
 * velocity — no invented actions. All classification is debounced: a state
 * must repeat `confirmFrames` consecutive updates before it is reported,
 * and each inferred field says what it is derived from.
 */

const DEFAULTS = {
  standingRatio: 1.9,     // box h/w ≥ this → standing
  sittingRatio: 1.05,     // h/w between sittingRatio and standingRatio → sitting
  movingSpeed: 0.006,     // normalized/frame — above → moving
  confirmFrames: 3,       // debounce: consecutive consistent frames
}

/**
 * One posture/motion/facing state machine per track.
 * update(track, facingNow, now) → { posture, motion, facing, moving }
 */
export class PostureState {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options }
    this.posture = null
    this.motion = null
    this._postureVotes = 0
    this._motionVotes = 0
  }

  update(track, facingNow, now) {
    const ratio = track.box.h / Math.max(track.box.w, 1e-6)
    const posture = ratio >= this.opts.standingRatio ? 'standing'
      : ratio >= this.opts.sittingRatio ? 'sitting' : 'sitting'
    const speed = Math.hypot(track.velocity?.x ?? 0, track.velocity?.y ?? 0)
    const motion = speed >= this.opts.movingSpeed ? 'moving' : 'stationary'

    this._postureVotes = posture === this.posture ? 0 : this._postureVotes + 1
    if (this.posture === null || this._postureVotes >= this.opts.confirmFrames) {
      this.posture = posture
      this._postureVotes = 0
    }
    this._motionVotes = motion === this.motion ? 0 : this._motionVotes + 1
    if (this.motion === null || this._motionVotes >= Math.max(1, this.opts.confirmFrames - 1)) {
      this.motion = motion
      this._motionVotes = 0
    }

    let facing = facingNow ? 'facing camera' : 'turned away'
    const b = track.box
    if (b.x <= 0.015 || b.y <= 0.015 || b.x + b.w >= 0.985 || b.y + b.h >= 0.985) {
      facing = 'partially occluded'
    }
    return {
      posture: this.posture,
      motion: this.motion,
      moving: this.motion === 'moving',
      facing,
      derivedFrom: 'bbox aspect ratio + tracker velocity + face co-observation',
    }
  }
}

/** Map the identity/posture model onto one tracker track for the overlay API. */
export function overlayView(track, identity, postureView) {
  return {
    trackId: track.trackId,
    box: { x: track.box.x, y: track.box.y, w: track.box.w, h: track.box.h },
    score: track.score,
    identity: {
      state: identity?.state ?? 'UNKNOWN',
      label: identity?.label ?? 'Unknown',
      basis: identity?.basis ?? null,
      personId: identity?.personId ?? null,
      score: identity?.score ?? null,
      verifiedAt: identity?.verifiedAt ?? null,
      reentered: identity?.reentered ?? false,
      trackAgeMs: identity?.trackAgeMs ?? null,
    },
    posture: postureView?.posture ?? null,
    motion: postureView?.motion ?? null,
    facing: postureView?.facing ?? null,
    derivedFrom: postureView?.derivedFrom ?? null,
  }
}

/**
 * MovementProfile (EYE-025 Layer 5, EXPERIMENTAL — behind a settings flag).
 *
 * Bounded movement-signature collection: mean speed, direction-change rate
 * and box-aspect oscillation over a rolling window. This is a SECONDARY
 * continuity hint only — it can support "possibly same person" style wording
 * and must never back a strong identity claim on its own. Not calibrated for
 * production accuracy; the field is emitted only when
 * settings.experimental.movementSignature is explicitly enabled.
 */
const WINDOW_MS = 20_000
const MAX_SAMPLES = 64

export class MovementProfile {
  constructor() {
    this.samples = []   // { at, speed, dir, ratio }
    this.lastDir = null
  }

  update(track, now) {
    const c = { x: track.box.x + track.box.w / 2, y: track.box.y + track.box.h / 2 }
    const dir = Math.atan2(track.velocity?.y ?? 0, track.velocity?.x ?? 0)
    const dirChange = this.lastDir !== null
      ? Math.abs(Math.atan2(Math.sin(dir - this.lastDir), Math.cos(dir - this.lastDir)))
      : 0
    this.lastDir = dir
    this.samples.push({
      at: now,
      speed: Math.hypot(track.velocity?.x ?? 0, track.velocity?.y ?? 0),
      dirChange,
      ratio: track.box.h / Math.max(track.box.w, 1e-6),
    })
    while (this.samples.length > MAX_SAMPLES || (this.samples[0] && now - this.samples[0].at > WINDOW_MS)) {
      this.samples.shift()
    }
    const n = Math.max(1, this.samples.length)
    const meanSpeed = this.samples.reduce((a, s) => a + s.speed, 0) / n
    const dirChanges = this.samples.reduce((a, s) => a + s.dirChange, 0) / n
    const ratios = this.samples.map(s => s.ratio)
    const meanRatio = ratios.reduce((a, b) => a + b, 0) / n
    const ratioOscillation = Math.sqrt(ratios.reduce((a, b) => a + (b - meanRatio) ** 2, 0) / n)
    return {
      windowMs: WINDOW_MS,
      samples: this.samples.length,
      meanSpeed: Number(meanSpeed.toFixed(5)),
      directionChangeRate: Number(dirChanges.toFixed(4)),
      aspectOscillation: Number(ratioOscillation.toFixed(4)),
      note: 'experimental secondary continuity hint — never a standalone identity claim',
    }
  }
}
