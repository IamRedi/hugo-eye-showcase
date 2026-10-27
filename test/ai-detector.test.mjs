import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeDetections, pointInPolygon } from '../src/ai/detector.js'

/** Builds a YOLOv8-shaped tensor [1, 4+C, N] with given detections. */
function makeTensor(dets, N = 8400, C = 80) {
  const data = new Float32Array((4 + C) * N)
  const dims = [1, 4 + C, N]
  const put = (i, cx, cy, w, h, classIdx, score) => {
    data[0 * N + i] = cx
    data[1 * N + i] = cy
    data[2 * N + i] = w
    data[3 * N + i] = h
    data[(4 + classIdx) * N + i] = score
  }
  dets.forEach((d, i) => put(d.i ?? i, d.cx, d.cy, d.w, d.h, d.classIdx, d.score))
  return { dims, data }
}

test('decodeDetections: keeps confident detections of wanted classes, decodes xywh', () => {
  const out = makeTensor([
    { i: 10, cx: 320, cy: 300, w: 100, h: 240, classIdx: 0, score: 0.91 },  // person
    { i: 200, cx: 100, cy: 100, w: 60, h: 60, classIdx: 16, score: 0.8 },   // dog — not wanted
  ])
  const dets = decodeDetections(out, { minConf: 0.45, classes: ['person'] })
  assert.equal(dets.length, 1)
  assert.equal(dets[0].label, 'person')
  assert.equal(dets[0].cx, 320)
  assert.ok(dets[0].score > 0.9)
})

test('decodeDetections: drops detections below the confidence floor', () => {
  const out = makeTensor([
    { i: 1, cx: 320, cy: 300, w: 100, h: 240, classIdx: 0, score: 0.3 },
  ])
  assert.equal(decodeDetections(out, { minConf: 0.45, classes: ['person'] }).length, 0)
  assert.equal(decodeDetections(out, { minConf: 0.25, classes: ['person'] }).length, 1)
})

test('decodeDetections: NMS suppresses overlapping duplicates, keeps distinct objects', () => {
  const out = makeTensor([
    { i: 1, cx: 320, cy: 320, w: 100, h: 200, classIdx: 0, score: 0.9 },
    { i: 2, cx: 324, cy: 322, w: 102, h: 198, classIdx: 0, score: 0.7 },  // ~same box
    { i: 3, cx: 900, cy: 320, w: 100, h: 200, classIdx: 0, score: 0.6 },  // elsewhere
  ])
  const dets = decodeDetections(out, { minConf: 0.45, classes: ['person'] })
  assert.equal(dets.length, 2, 'duplicate must be suppressed, distant box kept')
  assert.ok(Math.abs(dets[0].score - 0.9) < 1e-5)
})

test('pointInPolygon: ray-casting on normalized coordinates', () => {
  const square = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]
  assert.equal(pointInPolygon(0.5, 0.5, square), true)
  assert.equal(pointInPolygon(0.1, 0.5, square), false)
  assert.equal(pointInPolygon(0.79, 0.21, square), true)
  // degenerate zone (fewer than 3 points) → no restriction
  assert.equal(pointInPolygon(0.99, 0.99, [[0.1, 0.1]]), true)
})
