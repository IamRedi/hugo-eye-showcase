import test from 'node:test'
import assert from 'node:assert/strict'
import { mapPtzCommand, screenVelocityToPhysical, normalizeOrientation } from '../src/orientation.js'

// the velocity transform must agree with the command mapping: the unit
// screen vector for a command maps to the velocity of the mapped command
const COMMAND_VELOCITY = {
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
  up: { x: 0, y: 1 },     // ONVIF: +y = tilt up
  down: { x: 0, y: -1 },
}
const SCREEN_UNIT = {
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
  up: { x: 0, y: -1 },    // screen y grows downward
  down: { x: 0, y: 1 },
}

test('screenVelocityToPhysical agrees with mapPtzCommand for every orientation', () => {
  for (const rotate of [0, 90, 180, 270]) {
    for (const mirror of [false, true]) {
      for (const flip of [false, true]) {
        const o = { rotate, mirror, flip }
        for (const cmd of ['right', 'left', 'up', 'down']) {
          const physicalCommand = mapPtzCommand(cmd, o)
          const expected = COMMAND_VELOCITY[physicalCommand]
          const got = screenVelocityToPhysical(SCREEN_UNIT[cmd], o)
          assert.ok(
            Math.abs(got.x - expected.x) < 1e-9 && Math.abs(got.y - expected.y) < 1e-9,
            `screen ${cmd} @ rotate=${rotate} mirror=${mirror} flip=${flip}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
          )
        }
      }
    }
  }
})

test('180° mount (the C520WS reality): screen right is physical left, screen up keeps sign', () => {
  const o = normalizeOrientation({ rotate: 180 })
  assert.deepEqual(screenVelocityToPhysical({ x: 0.5, y: 0.2 }, o), { x: -0.5, y: 0.2 })
})

// ---------- controller logic (fake driver + fake tracker) ----------

import { AutoFollowController } from '../src/vision/autofollow.js'
import { getProductSettings, setProductSettings } from '../src/settings.js'
import { openDb } from '../src/db.js'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eye-follow-'))
  process.env.HUGO_EYE_DATA_DIR = dir
  openDb()
  setProductSettings({ privacy: { aiEnabled: true }, autofollow: { enabled: true, returnHome: true } })
}

function fakeDriver() {
  return {
    id: 'fake-cam',
    orientation: { rotate: 180, mirror: false, flip: false },
    moves: [],
    async ptzMoveVector(x, y) { this.moves.push({ t: Date.now(), x, y }) },
    async ptzStop() { this.moves.push({ t: Date.now(), stop: true }) },
    async gotoPosition(pos) { this.moves.push({ t: Date.now(), goto: pos }) },
    async getStatusPosition() { return { pan: 0.1, tilt: -0.9, zoom: 0 } },
  }
}

function fakeTracker(boxes) {
  return { live: () => boxes() }
}

const personAt = (cx, cy, id = 1) => ({ trackId: id, label: 'person', score: 0.8, state: 'active', box: { x: cx - 0.075, y: cy - 0.2, w: 0.15, h: 0.45 }, zones: [], velocity: { x: 0, y: 0 }, direction: 'stationary' })

test('autofollow: starts on a visible person, follows toward the screen region', async () => {
  makeEnv()
  const driver = fakeDriver()
  let boxes = [personAt(0.85, 0.45)]   // far right of the region (0.5, 0.45)
  const c = new AutoFollowController(driver, { getTracker: () => fakeTracker(() => boxes) })
  const start = c.start({ trackId: 1 })
  assert.equal(start.ok, true)
  assert.equal(c.state, 'following')
  await new Promise(r => setTimeout(r, 250))
  c.stop()
  const pans = driver.moves.filter(m => m.x !== undefined)
  assert.ok(pans.length > 0, 'issued corrections')
  // rotate=180: target right of center on screen → physical pan left (negative x)
  assert.ok(pans[0].x < 0, `physical pan is negative under 180° (got ${pans[0].x})`)
  assert.ok(Math.abs(pans[0].x) <= 0.5 + 1e-9, 'velocity bounded by max speed')
})

test('autofollow: dead zone holds position when centered', async () => {
  makeEnv()
  const driver = fakeDriver()
  const c = new AutoFollowController(driver, { getTracker: () => fakeTracker(() => [personAt(0.52, 0.46)]) })
  assert.equal(c.start({}).ok, true)
  await new Promise(r => setTimeout(r, 300))
  await c.stop()
  assert.equal(driver.moves.filter(m => m.x !== undefined).length, 0, 'no corrections inside the dead zone')
})

test('autofollow: lost target releases after hold and returns home', async () => {
  makeEnv()
  const driver = fakeDriver()
  let boxes = [personAt(0.85, 0.45)]
  const c = new AutoFollowController(driver, { getTracker: () => fakeTracker(() => boxes) })
  assert.equal(c.start({ trackId: 1 }).ok, true)
  await new Promise(r => setTimeout(r, 150))
  boxes = []   // subject gone
  await new Promise(r => setTimeout(r, 4500))   // > LOST_HOLD_MS
  assert.equal(c.state, 'idle', 'session released after the lost hold')
  assert.ok(driver.moves.some(m => m.goto), 'returned to home position')
})

test('autofollow: manual command instantly cancels', async () => {
  makeEnv()
  const driver = fakeDriver()
  const c = new AutoFollowController(driver, { getTracker: () => fakeTracker(() => [personAt(0.85, 0.45)]) })
  assert.equal(c.start({}).ok, true)
  assert.equal(c.state, 'following')
  c.handleManualCommand()
  assert.equal(c.state, 'idle', 'manual override releases immediately')
})

test('autofollow: refuses to start when disabled', async () => {
  makeEnv()
  setProductSettings({ autofollow: { enabled: false } })
  const driver = fakeDriver()
  const c = new AutoFollowController(driver, { getTracker: () => fakeTracker(() => [personAt(0.85, 0.45)]) })
  const r = c.start({})
  assert.equal(r.ok, false)
  assert.equal(r.code, 403)
})
