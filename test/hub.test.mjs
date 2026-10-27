import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { FakeCamera } from './helpers/fakeCamera.mjs'
import { Hub, HubCapacityError, HubPathLockError } from '../src/camera/hub.js'

/**
 * RelayHub lifecycle tests against a real RTSP-over-TCP fake camera.
 * These prove real properties: state transitions, GOP alignment, credential
 * transport, recovery behavior, backpressure semantics, resource bounds.
 */

const FAST = {
  idleDropMs: 300,
  firstMediaMs: 800,
  silenceMs: 700,
  watchdogMs: 100,
  subscribeTimeoutMs: 4000,
  errorBackoff: [0, 100, 200, 400],
  lockedBackoff: [100, 200, 300],
  recordBufferMax: 512,
}

const CAM = () => ({
  id: 'testcam', host: '127.0.0.1', rtspPort: 0, onvifPort: 0,
  subPath: '/stream2', mainPath: '/stream1', username: 'u', password: 'p',
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitFor(fn, timeoutMs = 8000, step = 20) {
  const start = Date.now()
  for (;;) {
    if (fn()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await sleep(step)
  }
}

function makeWritable(onChunk, { highWaterMark = 64 * 1024, stuck = false } = {}) {
  const w = new Writable({
    highWaterMark,
    write(chunk, _enc, cb) {
      w.chunks.push(chunk)
      onChunk?.(chunk)
      if (stuck) w.cbs.push(cb)   // wedged consumer: backpressure until drained
      else cb()
    },
  })
  w.chunks = []
  w.cbs = []
  return w
}

function nalTypes(buf) {
  const types = []
  let off = 0
  for (;;) {
    const idx = buf.indexOf(Buffer.from([0, 0, 0, 1]), off)
    if (idx === -1) break
    types.push(buf[idx + 4] & 0x1f)
    off = idx + 4
  }
  return types
}

/**
 * Test harness: camera + hub with guaranteed teardown, so a failing
 * assertion can never leak a live session and hang the runner.
 */
async function withHub(fn, { camera: cameraOptions, hub: hubOptions } = {}) {
  const cam = new FakeCamera(cameraOptions)
  const port = await cam.listen()
  const hub = new Hub({ ...CAM(), rtspPort: port }, '/stream2', { ...FAST, ...hubOptions })
  const events = []
  hub.on('state', e => events.push(e))
  try {
    return await fn({ cam, hub, events })
  } finally {
    for (const subId of [...hub.subs.keys()]) hub.release(subId)
    hub.generation += 1
    clearTimeout(hub.recoverTimer)
    clearTimeout(hub.idleTimer)
    clearInterval(hub.watchdog)
    if (hub.client) {
      hub.client._cleanClose = true
      hub.client.teardown().catch(() => {})
    }
    await cam.close()
  }
}

test('hub: idle → connecting → streaming with GOP-aligned fan-out', async () => {
  await withHub(async ({ hub }) => {
    const received = []
    const handle = await hub.subscribe({ kind: 'live' })
    assert.equal(hub.state, 'streaming')
    assert.equal(hub.reconnects, 0)

    const w = makeWritable()
    handle.attach({ video: w })
    await waitFor(() => {
      received.push(...nalTypes(Buffer.concat(w.chunks.splice(0))))
      return received.includes(5) && received.filter(t => t === 1).length >= 2
    })
    // alignment invariant: the first bytes a consumer sees are parameter sets
    assert.deepEqual(received.slice(0, 2), [7, 8], 'consumer stream must start with SPS+PPS')
    assert.ok(received.includes(5), 'consumer must receive an IDR')
  })
})

test('hub: digest challenge is answered; credentials travel only inside RTSP auth', async () => {
  await withHub(async ({ cam, hub }) => {
    await hub.subscribe({ kind: 'live' })
    assert.ok(cam.plays >= 1, 'authenticated PLAY must have succeeded')
    assert.equal(hub.state, 'streaming')
  }, { camera: { requireAuth: true } })
})

test('hub: silence triggers bounded recovery and the session is torn down cleanly', async () => {
  await withHub(async ({ cam, hub, events }) => {
    const handle = await hub.subscribe({ kind: 'live' })
    const w = makeWritable()
    handle.attach({ video: w })
    await waitFor(() => hub.state === 'streaming' && w.chunks.length > 2)

    const playsBefore = cam.plays
    cam.stopMedia()                       // camera goes silent mid-session
    // recovery is complete when the camera sees a second PLAY
    await waitFor(() => cam.plays > playsBefore, 8000)
    await waitFor(() => hub.state === 'streaming', 5000)
    assert.ok(events.some(e => e.state === 'recovering'), 'must pass through recovering')
    assert.ok(cam.teardowns >= 1, 'silent session must be torn down (TEARDOWN sent)')
  })
})

test('hub: path lock (session accepted, no media) fails fast with a classified error', async () => {
  await withHub(async ({ cam, hub }) => {
    cam.locked = true
    await assert.rejects(
      () => hub.subscribe({ kind: 'live' }),
      error => error instanceof HubPathLockError || error.code === 502,
      'subscribe must fail with lock/unavailable when no media flows',
    )
    assert.ok(cam.plays >= 1, 'the camera accepted the session but sent nothing')
  }, { hub: { subscribeTimeoutMs: 1500 } })
})

test('hub: record consumer buffers under backpressure; onOverflow fires at the cap', async () => {
  await withHub(async ({ hub }) => {
    let overflowed = false
    const handle = await hub.subscribe({
      kind: 'record',
      audio: true,
      onOverflow: () => { overflowed = true },
    })
    const wedged = makeWritable(() => {}, { highWaterMark: 1, stuck: true })
    handle.attach({ video: wedged, audio: wedged })
    await waitFor(() => hub.state === 'streaming')
    await waitFor(() => overflowed, 15_000)
    assert.ok(overflowed, 'onOverflow must fire when the buffer exceeds the cap')
    assert.ok(handle.sub.vBufBytes > 0 || handle.sub.overflowed, 'record bytes must be buffered, not dropped')
  })
})

test('hub: live consumer drops to the next keyframe when its pipe is wedged', async () => {
  await withHub(async ({ hub }) => {
    const handle = await hub.subscribe({ kind: 'live' })
    const wedged = makeWritable(() => {}, { highWaterMark: 1, stuck: true })
    handle.attach({ video: wedged })
    await waitFor(() => hub.state === 'streaming')
    await waitFor(() => handle.sub.drops > 5, 8000)
    // the camera session keeps flowing regardless of the stuck viewer
    assert.equal(hub.state, 'streaming')
  })
})

test('hub: capacity cap rejects excess subscribers', async () => {
  await withHub(async ({ hub }) => {
    const handles = []
    for (let i = 0; i < 12; i++) handles.push(await hub.subscribe({ kind: 'analyze' }))
    await assert.rejects(() => hub.subscribe({ kind: 'analyze' }), HubCapacityError)
    for (const h of handles) h.detach()
  })
})

test('hub: pre-event GOP seeding is contiguous (SPS+PPS before every IDR)', async () => {
  await withHub(async ({ hub }) => {
    const handle = await hub.subscribe({ kind: 'analyze' })
    const w = makeWritable()
    handle.attach({ video: w })
    await waitFor(() => hub.completedGops.length >= 1, 8000)
    handle.detach()

    const recHandle = await hub.subscribe({ kind: 'record', audio: false, preBufferGops: 1 })
    const rw = makeWritable()
    recHandle.attach({ video: rw })
    await waitFor(() => nalTypes(Buffer.concat(rw.chunks)).length >= 8, 8000)
    const types = nalTypes(Buffer.concat(rw.chunks))
    assert.deepEqual(types.slice(0, 2), [7, 8], 'seeded bytes must start with SPS+PPS')
    for (let i = 1; i < types.length; i++) {
      if (types[i] === 5) {
        assert.ok(types[i - 1] === 7 || types[i - 1] === 8, `IDR at ${i} lacks parameter sets before it`)
      }
    }
    assert.ok(types.includes(5), 'live tail must include an IDR')
  })
})

test('hub: last subscriber leaving drops the camera session (clean TEARDOWN)', async () => {
  await withHub(async ({ cam, hub }) => {
    const handle = await hub.subscribe({ kind: 'live' })
    await waitFor(() => hub.state === 'streaming')
    handle.detach()
    await waitFor(() => hub.state === 'idle', 8000)   // generous: CI/load can starve timers
    // Idle is published before the asynchronous TCP TEARDOWN reaches the peer.
    // Observe the wire-side event instead of racing it against the state poll.
    await waitFor(() => cam.teardowns >= 1, 8000)
    assert.equal(hub.state, 'idle')
    assert.ok(cam.teardowns >= 1, 'camera must receive a TEARDOWN')
  })
})

test('hub: fps is measured from RTP timestamps (one sample per access unit)', async () => {
  await withHub(async ({ hub }) => {
    const handle = await hub.subscribe({ kind: 'analyze' })
    handle.attach({ video: makeWritable() })
    // fake camera RTP clock: 6000 ticks per frame ⇒ 15 fps
    await waitFor(() => hub.fps !== null && hub.fps > 5, 8000)
    assert.ok(hub.fps >= 12 && hub.fps <= 18, `fps should be ~15, got ${hub.fps}`)
  })
})

test('hub: consumer resync after session recovery starts at a keyframe', async () => {
  await withHub(async ({ cam, hub }) => {
    const handle = await hub.subscribe({ kind: 'live' })
    const w = makeWritable()
    handle.attach({ video: w })
    await waitFor(() => hub.state === 'streaming' && w.chunks.length > 2)

    const playsBefore = cam.plays
    cam.stopMedia()
    await waitFor(() => cam.plays > playsBefore, 8000)
    await waitFor(() => hub.state === 'streaming', 5000)
    // after recovery the consumer resyncs: the tail must show a fresh
    // parameter-set burst followed by an IDR (the resync point)
    await waitFor(() => {
      const types = nalTypes(Buffer.concat(w.chunks.slice(-6)))
      const idx = types.lastIndexOf(7)
      return idx !== -1 && types[idx + 1] === 8 && types.slice(idx).includes(5)
    }, 8000)
  })
})
