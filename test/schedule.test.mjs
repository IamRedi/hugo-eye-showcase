import test from 'node:test'
import assert from 'node:assert/strict'
import { intervalSlotStart, isPresetDue } from '../src/presets.js'

function at(h, m) {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d
}

function preset(overrides = {}) {
  return {
    id: 'p1',
    cameraId: 'cam',
    createdAt: at(0, 0).toISOString(),
    timelapseEveryMin: 60,
    timelapseAt: null,
    lastCapturedAt: null,
    captureZone: 'z',
    timelapseEnabled: true,
    ...overrides,
  }
}

test('interval slot: 60-min cadence anchors to clock hours', () => {
  const slot = intervalSlotStart(at(14, 37), 60, 0)
  assert.equal(slot.getHours(), 14)
  assert.equal(slot.getMinutes(), 0)
})

test('interval slot: custom offset 240-min cadence anchored at 14:30', () => {
  const slot = intervalSlotStart(at(15, 10), 240, minuteOfDay('14:30'))
  assert.equal(slot.getMinutes(), 30)
  assert.equal(slot.getHours(), 14)
})

test('due: never captured -> due at the next slot (not the creation slot)', () => {
  const p = preset({ lastCapturedAt: null, createdAt: at(8, 0).toISOString() })
  assert.equal(isPresetDue(p, at(8, 5), [p]), false)
  assert.equal(isPresetDue(p, at(9, 5), [p]), true)
})

test('due: captured this slot -> not due', () => {
  const p = preset({ lastCapturedAt: at(14, 5).toISOString() })
  assert.equal(isPresetDue(p, at(14, 30), [p]), false)
})

test('due: next slot arrived -> due', () => {
  const p = preset({ lastCapturedAt: at(13, 59).toISOString() })
  assert.equal(isPresetDue(p, at(15, 1), [p]), true)
})

test('due: daily mode fires once after anchor time', () => {
  const p = preset({ timelapseEveryMin: null, timelapseAt: '14:30', lastCapturedAt: null })
  assert.equal(isPresetDue(p, at(14, 29), [p]), false)
  assert.equal(isPresetDue(p, at(14, 31), [p]), true)
  const captured = preset({ timelapseEveryMin: null, timelapseAt: '14:30', lastCapturedAt: at(14, 35).toISOString() })
  assert.equal(isPresetDue(captured, at(15, 0), [captured]), false)
  assert.equal(isPresetDue(captured, at(23, 59), [captured]), false)
})

test('due: anchored offsets stagger group members', () => {
  const anchor = preset({ timelapseAt: '14:30', lastCapturedAt: at(14, 30).toISOString() })
  const member = preset({ id: 'p2', timelapseAt: null, lastCapturedAt: at(14, 30).toISOString() })
  // anchor defines offset 30 for the 240-min group; member inherits the group offset
  assert.equal(isPresetDue(anchor, at(14, 31), [anchor, member]), false)
  assert.equal(isPresetDue(member, at(14, 31), [anchor, member]), false)
})

function minuteOfDay(hm) {
  const [h, m] = hm.split(':').map(Number)
  return h * 60 + m
}
