import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.HUGO_EYE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eye-motion-'))

const { openDb } = await import('../src/db.js')
const { setProductSettings } = await import('../src/settings.js')
const { MotionProvider } = await import('../src/intelligence.js')

openDb()

/**
 * EYE-025 regression: with the motion threshold at 0.01 (inside the measured
 * C520WS noise floor of 0.010–0.016 mean abs diff), the dev instance emitted
 * 3709 noise events in one day — isolated single-frame spikes at 0.010–0.015.
 * The temporal persistence gate (2 of the last 3 diffs at/above threshold)
 * must suppress isolated spikes without hiding sustained, genuine movement.
 */

const FRAME_BYTES = 160 * 90

function grayFrame(value) {
  return Buffer.alloc(FRAME_BYTES, value)
}

function providerWithCapturedEvents() {
  const provider = new MotionProvider({ id: 'test-cam' })
  provider.running = true
  const captured = []
  provider._emitEvent = async diff => { captured.push(diff) }
  return { provider, captured }
}

/** Feed frames so that consecutive diffs equal the given values. */
function feedDiffs(provider, diffs) {
  let prevValue = 100
  for (const d of diffs) {
    const nextValue = Math.max(0, Math.min(255, prevValue + Math.round(d * 255)))
    provider._onFrame(grayFrame(nextValue))
    prevValue = nextValue
  }
}

test('motion: isolated above-threshold spike is suppressed, not emitted', async () => {
  setProductSettings({ motion: { threshold: 0.02, minIntervalSec: 2 } })
  const { provider, captured } = providerWithCapturedEvents()

  feedDiffs(provider, [0, 0, 0])                    // settle: prev frame + clean window
  assert.equal(provider.stats.events, 0)

  feedDiffs(provider, [0.0235, 0, 0])               // one noise spike, then quiet
  assert.equal(captured.length, 0, 'single-frame spike must not become an event')
  assert.equal(provider.stats.suppressed, 1, 'spike counted as suppressed')
})

test('motion: sustained above-threshold movement emits (persistence satisfied)', async () => {
  setProductSettings({ motion: { threshold: 0.02, minIntervalSec: 2 } })
  const { provider, captured } = providerWithCapturedEvents()

  feedDiffs(provider, [0, 0, 0])
  feedDiffs(provider, [0.36, 0.30])                 // person walking: consecutive strong diffs
  assert.equal(captured.length, 1, 'sustained movement emits exactly one event')
  assert.equal(provider.stats.events, 1)
  assert.ok(captured[0] >= 0.02)
})

test('motion: sub-threshold noise floor never emits (0.01 < threshold 0.02)', async () => {
  setProductSettings({ motion: { threshold: 0.02, minIntervalSec: 2 } })
  const { provider, captured } = providerWithCapturedEvents()

  // the exact production noise pattern: alternating ±0.010 flicker
  feedDiffs(provider, Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.010 : 0)))
  assert.equal(captured.length, 0, 'noise floor must stay silent')
  assert.equal(provider.stats.events, 0)
})

test('motion: 2-of-3 window passes intermittent-but-repeated movement', async () => {
  setProductSettings({ motion: { threshold: 0.02, minIntervalSec: 2 } })
  const { provider, captured } = providerWithCapturedEvents()

  feedDiffs(provider, [0, 0, 0])
  provider.lastEventTs = 0                          // no interval interference
  feedDiffs(provider, [0.03, 0, 0.03])              // repeated change within the window
  assert.equal(captured.length, 1, 'repeated movement within the window is legitimate')
})

test('motion: minInterval still rate-limits sustained movement', async () => {
  setProductSettings({ motion: { threshold: 0.02, minIntervalSec: 2 } })
  const { provider, captured } = providerWithCapturedEvents()

  feedDiffs(provider, [0, 0, 0])
  feedDiffs(provider, [0.30, 0.30, 0.30, 0.30, 0.30])
  assert.equal(captured.length, 1, 'one event per minInterval window')
  assert.equal(provider.stats.suppressed, 1, 'only the window warm-up frame counts as suppressed')
})
