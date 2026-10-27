import test from 'node:test'
import assert from 'node:assert/strict'
import { IdentityTracker, identityLabel, IDENTITY_STATES } from '../src/vision/identity.js'
import { PostureState, overlayView } from '../src/vision/posture.js'

const THRESHOLD = 0.363
const track = (id, x = 0.4, y = 0.3, vx = 0, vy = 0, w = 0.15, h = 0.45) => ({
  trackId: id, label: 'person', score: 0.8, state: 'active',
  box: { x, y, w, h }, zones: [], velocity: { x: vx, y: vy },
})

test('identity: strong face match verifies; label is the name', () => {
  const t = new IdentityTracker({ matchThreshold: THRESHOLD })
  const now = 1_000_000
  const out = t.update([track(1)], new Map([[11, { personId: 'p1', name: 'Redi', score: 0.55 }]]), new Map(), [{ x: 0.42, y: 0.3, w: 0.08, h: 0.08, faceTrackId: 11 }], now)
  const v = out.get(1)
  assert.equal(v.state, IDENTITY_STATES.VERIFIED_FACE)
  assert.equal(v.label, 'Redi')
  assert.equal(v.basis, 'face verified')
})

test('identity: verified face persists as TRACKED_CONTINUITY when the face is gone', () => {
  const t = new IdentityTracker({ matchThreshold: THRESHOLD })
  const out1 = t.update([track(1)], new Map([[11, { personId: 'p1', name: 'Redi', score: 0.55 }]]), new Map(), [{ x: 0.42, y: 0.3, w: 0.08, h: 0.08, faceTrackId: 11 }], 1_000_000)
  assert.equal(out1.get(1).state, IDENTITY_STATES.VERIFIED_FACE)
  // person turns away: no face boxes any more, same track still alive
  const out2 = t.update([track(1, 0.45)], new Map(), new Map(), [], 1_000_100)
  const v = out2.get(1)
  assert.equal(v.state, IDENTITY_STATES.TRACKED_CONTINUITY)
  assert.equal(v.label, 'Redi (tracked)')
  assert.equal(v.personId, 'p1', 'identity preserved through continuity')
})

test('identity: track end kills identity — new track is UNKNOWN, not Redi', () => {
  const t = new IdentityTracker({ matchThreshold: THRESHOLD })
  t.update([track(1)], new Map([[11, { personId: 'p1', name: 'Redi', score: 0.55 }]]), new Map(), [{ x: 0.42, y: 0.3, w: 0.08, h: 0.08, faceTrackId: 11 }], 1_000_000)
  // track 1 gone; brand-new track 2 appears far away
  const out = t.update([track(2, 0.9)], new Map(), new Map(), [], 1_000_200)
  const v = out.get(2)
  assert.equal(v.state, IDENTITY_STATES.UNKNOWN)
  assert.equal(v.label, 'Unknown')
  assert.equal(v.personId, null, 'a new track never inherits a verified identity outright')
})

test('identity: re-entry near a verified exit yields POSSIBLE_MATCH only', () => {
  const t = new IdentityTracker({ matchThreshold: THRESHOLD })
  t.update([track(1)], new Map([[11, { personId: 'p1', name: 'Redi', score: 0.55 }]]), new Map(), [{ x: 0.42, y: 0.3, w: 0.08, h: 0.08, faceTrackId: 11 }], 1_000_000)
  // same track re-appears as a NEW id near where Redi was seen, seconds later
  const out = t.update([track(2, 0.43, 0.31)], new Map(), new Map(), [], 1_015_000)
  const v = out.get(2)
  assert.equal(v.state, IDENTITY_STATES.POSSIBLE_MATCH)
  assert.equal(v.label, 'Possibly Redi')
  assert.equal(v.reentered, true)
})

test('identity: uncertain face match is POSSIBLE_MATCH, never verified', () => {
  const t = new IdentityTracker({ matchThreshold: THRESHOLD })
  const score = THRESHOLD - 0.03   // inside the uncertain band
  const out = t.update([track(1)], new Map(), new Map([[11, { personId: 'p1', name: 'Redi', score }]]), [{ x: 0.42, y: 0.3, w: 0.08, h: 0.08, faceTrackId: 11 }], 1_000_000)
  const v = out.get(1)
  assert.equal(v.state, IDENTITY_STATES.POSSIBLE_MATCH)
  assert.equal(v.label, 'Possibly Redi')
})

test('identity: position hint expires — late re-entry stays UNKNOWN', () => {
  const t = new IdentityTracker({ matchThreshold: THRESHOLD })
  t.update([track(1)], new Map([[11, { personId: 'p1', name: 'Redi', score: 0.55 }]]), new Map(), [{ x: 0.42, y: 0.3, w: 0.08, h: 0.08, faceTrackId: 11 }], 1_000_000)
  const out = t.update([track(2, 0.43, 0.31)], new Map(), new Map(), [], 1_100_000)   // 100 s later
  assert.equal(out.get(2).state, IDENTITY_STATES.UNKNOWN)
})

test('posture: standing vs sitting from box aspect ratio, debounced', () => {
  const p = new PostureState()
  const standing = track(1, 0.4, 0.3, 0, 0, 0.13, 0.42)   // ratio 3.2
  const sitting = track(1, 0.4, 0.3, 0, 0, 0.3, 0.38)     // ratio 1.27
  let v = p.update(standing, false, 0)
  assert.equal(v.posture, 'standing')
  // one sitting frame is not enough (debounce)
  v = p.update(sitting, false, 100)
  assert.equal(v.posture, 'standing', 'single outlier frame is debounced')
  v = p.update(sitting, false, 200)
  v = p.update(sitting, false, 300)
  assert.equal(v.posture, 'sitting')
})

test('posture: moving vs stationary with hysteresis', () => {
  const p = new PostureState()
  let v = p.update(track(1, 0.4, 0.3, 0, 0), false, 0)
  assert.equal(v.motion, 'stationary')
  v = p.update(track(1, 0.4, 0.3, 0.02, 0), false, 100)
  v = p.update(track(1, 0.42, 0.3, 0.02, 0), false, 150)   // 2 consecutive → debounced
  assert.equal(v.motion, 'moving')
  v = p.update(track(1, 0.4, 0.3, 0, 0), false, 200)
  v = p.update(track(1, 0.4, 0.3, 0, 0), false, 250)   // 2 consecutive → falls back
  assert.equal(v.motion, 'stationary', 'falls back when velocity stops')
})

test('posture: facing from face co-observation, occlusion from frame edge', () => {
  const p = new PostureState()
  const t = track(1, 0.4, 0.3)
  let v = p.update(t, true, 0)
  assert.equal(v.facing, 'facing camera')
  v = p.update(t, false, 100)
  assert.equal(v.facing, 'turned away')
  const clipped = track(1, -0.02, 0.3)
  v = p.update(clipped, true, 200)
  assert.equal(v.facing, 'partially occluded')
})

test('overlay view: payload carries identity + posture for the UI', () => {
  const p = new PostureState()
  const t = track(1, 0.4, 0.3, 0.01, 0)
  const pv = p.update(t, true, 0)
  const view = overlayView(t, { state: 'VERIFIED_FACE', label: 'Redi', basis: 'face verified', personId: 'p1', score: 0.55, trackAgeMs: 5000 }, pv)
  assert.equal(view.identity.label, 'Redi')
  assert.equal(view.posture, 'standing')
  assert.equal(view.motion, 'moving')
  assert.equal(view.facing, 'facing camera')
  assert.ok(view.box.w > 0)
})

test('identityLabel wording', () => {
  assert.equal(identityLabel(IDENTITY_STATES.VERIFIED_FACE, 'Redi'), 'Redi')
  assert.equal(identityLabel(IDENTITY_STATES.TRACKED_CONTINUITY, 'Redi'), 'Redi (tracked)')
  assert.equal(identityLabel(IDENTITY_STATES.POSSIBLE_MATCH, 'Redi'), 'Possibly Redi')
  assert.equal(identityLabel(IDENTITY_STATES.UNKNOWN, null), 'Unknown')
})
