import test from 'node:test'
import assert from 'node:assert/strict'
import { Hub, _test } from '../src/camera/hub.js'
import { FakeCamera } from './helpers/fakeCamera.mjs'

/**
 * Regression test for the EYE-024/025 production finding: a hub left in
 * 'recovering' with live subscribers could freeze forever (production froze
 * for 12.75 h after an overnight camera outage — reconnects stopped at 5).
 * Whatever the stuck cause (a session attempt that never settles, a lost
 * timer, a stale client reference), the anti-wedge watchdog must force a
 * fresh bounded session attempt within ~20 s.
 */
test('hub: anti-wedge guard restarts the retry engine when recovering freezes', async () => {
  const cam = new FakeCamera({ requireAuth: false })
  const port = await cam.listen()
  const hub = new Hub(
    { id: 'cam-w', host: '127.0.0.1', rtspPort: port, subPath: '/sub', mainPath: '/main', username: '', password: '' },
    '/sub',
    { firstMediaMs: 800, errorBackoff: [50, 50], lockedBackoff: [50, 50], watchdogMs: 250 },
  )
  try {
    const handle = await hub.subscribe({ kind: 'live' })
    await new Promise(r => setTimeout(r, 1200))
    assert.equal(hub.state, 'streaming', 'baseline: streaming against the fake camera')

    // reproduce the production wedge exactly: the state machine froze in
    // 'recovering' with a never-settling session attempt, a stale client
    // reference and a 12-hour-old lastSessionAttemptAt — while real
    // subscribers stayed attached.
    hub._setState('recovering', 'simulated wedge')
    hub.sessionPromise = new Promise(() => {})   // never settles
    hub.client = { destroyed: true }             // stale client reference
    hub.lastSessionAttemptAt = Date.now() - 60_000
    const genBefore = hub.generation

    // the anti-wedge guard must force a fresh bounded attempt; the camera is
    // reachable, so the hub must return to 'streaming' on its own
    await new Promise(r => setTimeout(r, 2500))
    assert.equal(hub.sessionPromise, null, 'stale sessionPromise forcibly retired')
    assert.notEqual(hub.generation, genBefore, 'generation bumped to invalidate the wedged attempt')
    assert.equal(hub.state, 'streaming', 'hub self-recovered to streaming')
    handle.detach()
  } finally {
    hub.watchdog && clearInterval(hub.watchdog)
    await cam.close()
  }
})

test('hub: a superseded attempt\'s late failure cannot disturb the newer attempt', async () => {
  const cam = new FakeCamera({ requireAuth: false })
  const port = await cam.listen()
  const hub = new Hub(
    { id: 'cam-s', host: '127.0.0.1', rtspPort: port, subPath: '/sub', mainPath: '/main', username: '', password: '' },
    '/sub',
    { watchdogMs: 250 },
  )
  try {
    const handle = await hub.subscribe({ kind: 'live' })
    await new Promise(r => setTimeout(r, 1200))
    assert.equal(hub.state, 'streaming')
    const reconnectsBefore = hub.reconnects
    const clientBefore = hub.client

    // attempt A (stale) fails LONG after being superseded by attempt B
    const staleGen = hub.generation
    hub.generation += 1                    // anti-wedge / fresh kick supersedes A
    await hub._ensureSession()             // attempt B owns the machine now
    await new Promise(r => setTimeout(r, 800))
    assert.equal(hub.state, 'streaming', 'attempt B is streaming')

    await hub._down({ unclean: true, error: new Error('late stale failure'), gen: staleGen })
    assert.equal(hub.state, 'streaming', 'stale _down ignored — state untouched')
    assert.equal(hub.reconnects, reconnectsBefore, 'stale _down ignored — counters untouched')
    assert.equal(hub.client, clientBefore, 'the newer session\'s client is untouched')
    await new Promise(r => setTimeout(r, 600))
    assert.equal(hub.state, 'streaming', 'media still flowing after the stale failure')
    handle.detach()
  } finally {
    hub.watchdog && clearInterval(hub.watchdog)
    await cam.close()
  }
})
