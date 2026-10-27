import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.HUGO_EYE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eye-multicam-'))
const dbMod = await import('../src/db.js')
await dbMod.openDb()
const { seedFromEnv, driverConfigs } = await import('../src/cameras.js')
const { createDriver } = await import('../src/camera/tapo.js')
const { getHub, hubStatusForCamera, stopAllHubs } = await import('../src/camera/hub.js')
const { FakeCamera } = await import('./helpers/fakeCamera.mjs')

test('multi-camera: two synthetic cameras stream independently through their own hubs', async () => {
  // two fake RTSP cameras on ephemeral ports
  const camA = new FakeCamera({ requireAuth: false })
  const camB = new FakeCamera({ requireAuth: false })
  const portA = await camA.listen()
  const portB = await camB.listen()
  camB.locked = true   // camera B accepts sessions but is silent (offline-like)

  seedFromEnv([
    { id: 'cam-a', driver: 'tapo', name: 'A', host: '127.0.0.1', rtspPort: portA, username: '', password: '' },
    { id: 'cam-b', driver: 'tapo', name: 'B', host: '127.0.0.1', rtspPort: portB, username: '', password: '' },
  ])
  const configs = driverConfigs()
  assert.equal(configs.length, 2)
  const drivers = configs.map(cam => createDriver(cam, () => ({ rotate: 0, mirror: false, flip: false })))

  // both hubs subscribe at once — independent sessions, independent state.
  // Camera B is locked: its subscribe eventually rejects (HubUnavailableError)
  // after the bounded probe window — that rejection is EXPECTED and caught.
  const subA = await getHub(drivers[0].cam, drivers[0].cam.subPath).subscribe({ kind: 'live' })
  let subBError = null
  const subB = getHub(drivers[1].cam, drivers[1].cam.subPath)
    .subscribe({ kind: 'live' })
    .catch(e => { subBError = e; return null })
  await new Promise(r => setTimeout(r, 1500))

  const statusA = hubStatusForCamera('cam-a')
  const statusB = hubStatusForCamera('cam-b')
  assert.equal(statusA.sub.state, 'streaming', 'camera A streams')
  assert.ok(['connecting', 'recovering'].includes(statusB.sub.state), `camera B is not streaming (locked camera) — got ${statusB.sub.state}`)
  assert.notEqual(statusA.sub.state, statusB.sub.state, 'hub states are per-camera, not global')

  subA.detach()
  await subB   // settle the expected rejection (never unhandled)
  assert.ok(subBError?.code === 502 || subBError === null, 'camera B rejection is the honest unavailable error')
  await new Promise(r => setTimeout(r, 100))
  await stopAllHubs()
  camA.close()
  camB.close()
})
