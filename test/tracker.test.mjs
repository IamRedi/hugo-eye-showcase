import test from 'node:test'
import assert from 'node:assert/strict'
import { Tracker, iou, pointInPolygon, classifyDirection, _resetTrackIds } from '../src/vision/tracker.js'

const person = (x, y, score = 0.8) => ({ label: 'person', score, x, y, w: 0.15, h: 0.45 })

test('iou: overlap arithmetic', () => {
  assert.equal(iou(person(0, 0), person(0, 0)), 1)
  assert.ok(iou(person(0, 0), person(0.05, 0)) > 0.3)
  assert.equal(iou(person(0, 0), person(0.9, 0)), 0)
})

test('pointInPolygon: ray casting with normalized zones', () => {
  const square = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]
  assert.equal(pointInPolygon(0.5, 0.5, square), true)
  assert.equal(pointInPolygon(0.05, 0.5, square), false)
  assert.equal(pointInPolygon(0.5, 0.5, [[0.1, 0.1]]), true) // degenerate → unrestricted
})

test('tracker: track persists across frames, appears once, disappears once', () => {
  _resetTrackIds()
  const t = new Tracker({ minHits: 2, maxAge: 3 })
  let appeared = 0, disappeared = 0
  // 5 frames with a steady detection
  for (let i = 0; i < 5; i++) {
    const ev = t.update([person(0.4, 0.3)])
    appeared += ev.filter(e => e.type === 'appeared').length
    disappeared += ev.filter(e => e.type === 'disappeared').length
  }
  assert.equal(appeared, 1, 'one track appearance for a continuous presence')
  assert.equal(disappeared, 0)
  assert.equal(t.live().length, 1)
  assert.equal(t.live()[0].state, 'active')
  // person leaves: after maxAge frames the track disappears exactly once
  for (let i = 0; i < 4; i++) {
    const ev = t.update([])
    disappeared += ev.filter(e => e.type === 'disappeared').length
  }
  assert.equal(disappeared, 1)
  assert.equal(t.live().length, 0)
})

test('tracker: minHits filters one-frame detection noise', () => {
  _resetTrackIds()
  const t = new Tracker({ minHits: 2, maxAge: 2 })
  t.update([person(0.4, 0.3, 0.9)])
  assert.equal(t.live()[0].state, 'new', 'tentative, not yet trusted')
  // the scene layer only trusts active tracks:
  assert.equal(t.live().filter(l => l.state === 'active').length, 0)
  t.update([]) // noise gone before minHits
  t.update([])
  t.update([])
  assert.equal(t.live().length, 0, 'single-frame noise was removed, never activated')
})

test('tracker: IDs stay stable through movement and brief occlusion', () => {
  _resetTrackIds()
  const t = new Tracker({ maxAge: 5 })
  const ids = []
  // move steadily right (matching range: IoU ≥ 0.3 at box width 0.15)
  for (let i = 0; i < 4; i++) {
    t.update([person(0.3 + i * 0.03, 0.3)])
    const live = t.live()
    ids.push(live[0]?.trackId ?? null)
  }
  assert.equal(new Set(ids.filter(Boolean)).size, 1, 'same track while moving')
  const id = ids[1]
  // 2 frames of occlusion (no detection) — within maxAge
  t.update([])
  t.update([])
  // person reappears near the last seen position
  t.update([person(0.42, 0.3)])
  const after = t.live()[0]
  assert.equal(after.trackId, id, 'track recovers after temporary occlusion')
})

test('tracker: two simultaneous persons keep distinct IDs', () => {
  _resetTrackIds()
  const t = new Tracker({ minHits: 2 })
  for (let i = 0; i < 3; i++) t.update([person(0.2, 0.3), person(0.7, 0.3)])
  const live = t.live().filter(l => l.label === 'person')
  assert.equal(live.length, 2)
  assert.notEqual(live[0].trackId, live[1].trackId)
})

test('tracker: zone enter and exit with dwell', () => {
  _resetTrackIds()
  const t = new Tracker({ minHits: 1 })
  const zones = { living_room: [[0.5, 0], [1, 0], [1, 1], [0.5, 1]] }
  // walk gradually into the zone so every step matches the same track
  let enter = null
  let x = 0.2
  for (let i = 0; i < 8 && !enter; i++) {
    x += 0.05
    enter = t.update([person(x, 0.3)], zones).find(e => e.type === 'entered_zone')
  }
  assert.equal(enter?.zone, 'living_room')
  // dwell inside
  for (let i = 0; i < 3; i++) t.update([person(x, 0.3)], zones)
  // walk out gradually
  let exit = null
  for (let i = 0; i < 10 && !exit; i++) {
    x -= 0.05
    exit = t.update([person(x, 0.3)], zones).find(e => e.type === 'exited_zone')
  }
  assert.equal(exit?.zone, 'living_room')
  assert.ok(exit.dwellFrames >= 3, 'dwell measured in frames')
})

test('tracker: low-confidence rescue bridges occlusion without new tracks', () => {
  _resetTrackIds()
  const t = new Tracker({ minHits: 2, maxAge: 4 })
  t.update([person(0.4, 0.3, 0.8)])
  t.update([person(0.4, 0.3, 0.8)])
  const id = t.live()[0].trackId
  // weak detection during occlusion (below conf floor, above low floor)
  const ev = t.update([person(0.42, 0.31, 0.3)])
  assert.equal(ev.filter(e => e.type === 'appeared').length, 0, 'weak detection rescues instead of new track')
  assert.equal(t.live()[0].trackId, id)
})

// ---------- EYE-023 Gate 2 additions ----------

test('tracker: direction classification from velocity', () => {
  assert.equal(classifyDirection({ x: 0, y: 0 }), 'stationary')
  assert.equal(classifyDirection({ x: 0.001, y: 0.001 }), 'stationary', 'below epsilon is stationary')
  assert.equal(classifyDirection({ x: 0.02, y: 0.001 }), 'right')
  assert.equal(classifyDirection({ x: -0.02, y: 0.001 }), 'left')
  assert.equal(classifyDirection({ x: 0.001, y: 0.02 }), 'down', 'image y grows downward')
  assert.equal(classifyDirection({ x: 0.001, y: -0.02 }), 'up')
})

test('tracker: constant-velocity prediction keeps ID through faster motion', () => {
  _resetTrackIds()
  const t = new Tracker({ minHits: 1, maxAge: 4 })
  // build velocity history: +0.04/frame
  for (let i = 0; i < 3; i++) t.update([person(0.2 + i * 0.04, 0.3)])
  const id = t.live()[0].trackId
  t.update([]) // one missed frame; prediction advances the box by velocity
  // detection lands where the prediction expects it (would NOT overlap the
  // stale box: 0.32 vs last-seen 0.28 → IoU 0.52... with prediction → higher)
  const ev = t.update([person(0.33, 0.3)])
  assert.equal(ev.filter(e => e.type === 'appeared').length, 0)
  assert.equal(t.live()[0].trackId, id)
})

test('tracker: notifyCameraMoved invalidates geometry — no stale association', () => {
  _resetTrackIds()
  const t = new Tracker({ minHits: 1, maxAge: 8 })
  t.update([person(0.4, 0.3)])
  const idBefore = t.live()[0].trackId
  t.notifyCameraMoved()
  // a person detected at a totally different screen position after a pan
  t.update([person(0.1, 0.6)])
  const after = t.live()[0]
  assert.notEqual(after.trackId, idBefore, 'post-move detection is a fresh track, not the stale one')
})

test('tracker: wall-clock timestamps when a clock is provided', async () => {
  _resetTrackIds()
  let clock = 1_000_000
  const t = new Tracker({ minHits: 1, now: () => clock })
  t.update([person(0.4, 0.3)])
  clock += 1500
  t.update([person(0.4, 0.3)])
  const live = t.live()[0]
  assert.equal(live.firstSeenAt, 1_000_000)
  assert.equal(live.lastSeenAt, 1_001_500)
})

test('tracker: disappeared event carries direction and dwell', () => {
  _resetTrackIds()
  const t = new Tracker({ minHits: 1, maxAge: 2 })
  for (let i = 0; i < 3; i++) t.update([person(0.3 + i * 0.02, 0.3)])
  t.update([])   // age 1 → lost
  const events = t.update([])   // age 2 → removed
  const gone = events.find(e => e.type === 'disappeared')
  assert.ok(gone, 'track expired')
  assert.equal(gone.direction, 'right')
  assert.ok(gone.dwellFrames >= 1)
})
