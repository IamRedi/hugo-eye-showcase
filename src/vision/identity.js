import { UNCERTAIN_MARGIN } from '../ai/faceEmbed.js'

/**
 * Identity continuity model (EYE-025 Layer 3).
 *
 * Four explicit states, strongest first:
 *   VERIFIED_FACE      — strong face match on THIS track (score ≥ threshold)
 *   TRACKED_CONTINUITY — the same track was verified and has stayed continuously
 *                        present; label keeps the verified identity with a
 *                        "(tracked)" qualifier while the track lives
 *   POSSIBLE_MATCH     — weak/partial evidence only: uncertain-band face score,
 *                        or position continuity near a recently-verified track
 *   UNKNOWN            — not enough evidence
 *
 * Safety invariants:
 *   - a verified face on a DIFFERENT (ended) track never becomes verified here;
 *     cross-track carry-over can only ever be POSSIBLE_MATCH (position hint)
 *   - when a track ends, its identity dies with it (downgrade to UNKNOWN)
 *   - weak evidence is never presented as certainty; uncertainty decays
 */

const STATE = {
  VERIFIED_FACE: 'VERIFIED_FACE',
  TRACKED_CONTINUITY: 'TRACKED_CONTINUITY',
  POSSIBLE_MATCH: 'POSSIBLE_MATCH',
  UNKNOWN: 'UNKNOWN',
}

const DEFAULTS = {
  positionHintWindowMs: 20_000,   // re-entry position hint lifetime
  positionHintRadius: 0.18,       // normalized distance for re-entry association
}

export function identityLabel(state, name) {
  switch (state) {
    case STATE.VERIFIED_FACE: return name
    case STATE.TRACKED_CONTINUITY: return `${name} (tracked)`
    case STATE.POSSIBLE_MATCH: return name ? `Possibly ${name}` : 'Possible match'
    default: return 'Unknown'
  }
}

export class IdentityTracker {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options }
    // trackId → { state, personId, name, basis, score, verifiedAt }
    this.tracks = new Map()
    // recently ended tracks: [{ trackId, personId, name, box, endedAt, wasVerified }]
    this.ended = []
  }

  /**
   * Advance the model one observation tick.
   * @param liveTracks person tracker live() output (active+new tracks)
   * @param faceByTrack Map faceTrackId → {personId, name, score} (verified matches)
   * @param uncertainByTrack Map faceTrackId → {personId, name, score} (uncertain band)
   * @param faceBoxes normalized face boxes for facing/association (optional)
   * @param now Date.now()
   * @returns Map trackId → identity view {state, label, basis, personId, score, verifiedAt}
   */
  update(liveTracks, faceByTrack, uncertainByTrack, faceBoxes, now) {
    faceByTrack ??= new Map()
    uncertainByTrack ??= new Map()
    const alive = new Set(liveTracks.map(t => t.trackId))

    // retire ended tracks (keep for position hints)
    for (const trackId of [...this.tracks.keys()]) {
      if (alive.has(trackId)) continue
      const rec = this.tracks.get(trackId)
      this.tracks.delete(trackId)
      // "left" means when we LAST saw the track — not when we noticed it gone
      this.ended.push({
        trackId, personId: rec.personId, name: rec.name,
        box: rec.lastBox, endedAt: rec.lastSeenAt ?? now, wasVerified: rec.state === STATE.VERIFIED_FACE,
      })
      while (this.ended.length > 12 || (this.ended[0] && now - this.ended[0].endedAt > this.opts.positionHintWindowMs * 4)) this.ended.shift()
    }
    this.ended = this.ended.filter(e => now - e.endedAt <= this.opts.positionHintWindowMs * 4)

    const out = new Map()
    for (const t of liveTracks) {
      let rec = this.tracks.get(t.trackId)
      if (!rec) {
        rec = { state: STATE.UNKNOWN, personId: null, name: null, basis: null, score: null, verifiedAt: null, firstSeenAt: now, lastBox: null }
        // re-entry position hint: near a recently ended track
        const hint = this._positionHint(t, now)
        if (hint) {
          rec.state = STATE.POSSIBLE_MATCH
          rec.personId = hint.personId
          rec.name = hint.name
          rec.basis = hint.wasVerified
            ? 'position continuity after a verified person left this spot'
            : 'position continuity'
          rec.score = null
          rec.reentered = true
        }
        this.tracks.set(t.trackId, rec)
      }
      rec.lastBox = { ...t.box }
      rec.lastSeenAt = now

      // face evidence on this track (strongest wins, applied every tick)
      const faceId = this._faceForTrack(t, faceBoxes)
      const verified = faceByTrack.get(faceId) ?? null
      const uncertain = uncertainByTrack.get(faceId) ?? null
      if (verified && verified.score >= (this.opts.matchThreshold ?? 0.363)) {
        rec.state = STATE.VERIFIED_FACE
        rec.personId = verified.personId
        rec.name = verified.name
        rec.basis = 'face verified'
        rec.score = verified.score
        rec.verifiedAt = now
        rec.reentered = false
      } else if (rec.state === STATE.VERIFIED_FACE) {
        // face no longer matched: keep continuity while the track lives
        rec.state = STATE.TRACKED_CONTINUITY
        rec.basis = 'tracked continuity from a verified face'
      } else if (uncertain && uncertain.score >= (this.opts.matchThreshold ?? 0.363) - UNCERTAIN_MARGIN) {
        // only downgrade from TRACKED to POSSIBLE if no verified history
        if (rec.state !== STATE.TRACKED_CONTINUITY || !rec.personId) {
          rec.state = STATE.POSSIBLE_MATCH
          rec.personId = uncertain.personId
          rec.name = uncertain.name
          rec.basis = 'uncertain face match'
          rec.score = uncertain.score
        }
      }

      out.set(t.trackId, this._view(t, rec, now))
    }
    return out
  }

  _faceForTrack(personTrack, faceBoxes) {
    if (!faceBoxes?.length) return null
    const c = { x: personTrack.box.x + personTrack.box.w / 2, y: personTrack.box.y + personTrack.box.h * 0.2 }
    for (const f of faceBoxes) {
      const fc = { x: f.x + f.w / 2, y: f.y + f.h / 2 }
      if (Math.abs(fc.x - c.x) < Math.max(personTrack.box.w, f.w) && Math.abs(fc.y - c.y) < personTrack.box.h * 0.5) return f.faceTrackId ?? null
    }
    return null
  }

  _positionHint(track, now) {
    const c = { x: track.box.x + track.box.w / 2, y: track.box.y + track.box.h / 2 }
    for (let i = this.ended.length - 1; i >= 0; i--) {
      const e = this.ended[i]
      if (!e.box || !e.personId) continue
      if (now - e.endedAt > this.opts.positionHintWindowMs) continue
      const ec = { x: e.box.x + e.box.w / 2, y: e.box.y + e.box.h / 2 }
      if (Math.hypot(ec.x - c.x, ec.y - c.y) <= this.opts.positionHintRadius) return e
    }
    return null
  }

  _view(track, rec, now) {
    return {
      state: rec.state,
      label: identityLabel(rec.state, rec.name),
      personId: rec.personId,
      basis: rec.basis,
      score: rec.score,
      verifiedAt: rec.verifiedAt ? new Date(rec.verifiedAt).toISOString() : null,
      trackAgeMs: now - rec.firstSeenAt,
      reentered: Boolean(rec.reentered),
    }
  }
}

export { STATE as IDENTITY_STATES }
