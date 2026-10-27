import test from 'node:test'
import assert from 'node:assert/strict'
import { mapPtzCommand, videoFilters, normalizeOrientation } from '../src/orientation.js'

test('orientation 0: identity', () => {
  for (const cmd of ['up', 'down', 'left', 'right', 'up_left', 'stop', 'zoom_in']) {
    assert.equal(mapPtzCommand(cmd, { rotate: 0 }), cmd)
  }
})

test('orientation 180 (inverted mount): directions invert', () => {
  assert.equal(mapPtzCommand('left', { rotate: 180 }), 'right')
  assert.equal(mapPtzCommand('right', { rotate: 180 }), 'left')
  assert.equal(mapPtzCommand('up', { rotate: 180 }), 'down')
  assert.equal(mapPtzCommand('down', { rotate: 180 }), 'up')
  assert.equal(mapPtzCommand('up_left', { rotate: 180 }), 'down_right')
  assert.equal(mapPtzCommand('zoom_in', { rotate: 180 }), 'zoom_in')
  assert.equal(mapPtzCommand('stop', { rotate: 180 }), 'stop')
})

test('orientation 90: screen-up means physical-left', () => {
  assert.equal(mapPtzCommand('up', { rotate: 90 }), 'left')
  assert.equal(mapPtzCommand('right', { rotate: 90 }), 'up')
  assert.equal(mapPtzCommand('down', { rotate: 90 }), 'right')
  assert.equal(mapPtzCommand('left', { rotate: 90 }), 'down')
})

test('orientation 270: inverse of 90', () => {
  assert.equal(mapPtzCommand('up', { rotate: 270 }), 'right')
  assert.equal(mapPtzCommand('left', { rotate: 270 }), 'up')
  assert.equal(mapPtzCommand('down', { rotate: 270 }), 'left')
  assert.equal(mapPtzCommand('right', { rotate: 270 }), 'down')
})

test('mirror swaps left/right after rotation; flip swaps up/down', () => {
  assert.equal(mapPtzCommand('left', { rotate: 0, mirror: true }), 'right')
  assert.equal(mapPtzCommand('up', { rotate: 0, flip: true }), 'down')
  assert.equal(mapPtzCommand('up', { rotate: 180, mirror: true }), 'down') // 180 up->down, mirror is L/R so unchanged
  assert.equal(mapPtzCommand('left', { rotate: 180, flip: true }), 'right') // 180 left->right, flip is U/D so unchanged
})

test('videoFilters: ffmpeg fragments per orientation', () => {
  assert.equal(videoFilters({ rotate: 0 }), null)
  assert.equal(videoFilters({ rotate: 180 }), 'transpose=1,transpose=1')
  assert.equal(videoFilters({ rotate: 90 }), 'transpose=1')
  assert.equal(videoFilters({ rotate: 270 }), 'transpose=2')
  assert.equal(videoFilters({ rotate: 180, mirror: true }), 'transpose=1,transpose=1,hflip')
  assert.equal(videoFilters({ rotate: 180, mirror: true, flip: true }), 'transpose=1,transpose=1,hflip,vflip')
})

test('normalizeOrientation: invalid rotate falls back to 0, bools coerced', () => {
  const o = normalizeOrientation({ rotate: 137, mirror: 1, flip: 'yes' })
  assert.deepEqual(o, { rotate: 0, mirror: true, flip: true })
})
