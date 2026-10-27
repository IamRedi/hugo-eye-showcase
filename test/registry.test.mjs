import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.HUGO_EYE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eye-registry-'))
const dbMod = await import('../src/db.js')
await dbMod.openDb()
const { seedFromEnv, listCameras, createCamera, updateCamera, removeCamera, driverConfigs, probeCamera } = await import('../src/cameras.js')
const { config } = await import('../src/config.js')

test('registry: env seeding is idempotent and drives driver configs', () => {
  const envCams = [
    { id: 'tapo-main', driver: 'tapo', name: 'Indoor', host: '192.168.1.64', username: 'u', password: 'p' },
    { id: 'garage', driver: 'tapo', name: 'Garage', host: '192.168.1.65', username: 'u', password: 'p' },
  ]
  assert.equal(seedFromEnv(envCams), 2)
  assert.equal(seedFromEnv(envCams), 0, 'second seed changes nothing')
  const configs = driverConfigs()
  assert.equal(configs.length, 2)
  assert.ok(configs.every(c => c.host && c.username && c.password), 'driver configs carry credentials internally')
  // public listing never exposes the password
  assert.ok(listCameras().every(c => c.password === undefined))
})

test('registry: onboarding validates and rejects duplicates', async () => {
  const bad = await createCamera({ id: 'Bad_ID!', host: '10.0.0.1', username: 'u', password: 'p' }, { probe: false })
  assert.equal(bad.ok, false, 'invalid id rejected')
  const dup = await createCamera({ id: 'tapo-main', host: '10.0.0.2', username: 'u', password: 'p' }, { probe: false })
  assert.equal(dup.code, 409, 'duplicate id rejected')
  const nocred = await createCamera({ id: 'doorbell', host: '10.0.0.3' }, { probe: false })
  assert.equal(nocred.ok, false, 'missing credentials rejected')
  const ok = await createCamera({ id: 'doorbell', host: '10.0.0.3', username: 'u', password: 'p', name: 'Doorbell' }, { probe: false })
  assert.equal(ok.ok, true)
  assert.equal(driverConfigs().length, 3)
})

test('registry: probe of an unreachable host reports honest errors', async () => {
  const result = await probeCamera({ host: '127.0.0.1', rtspPort: 1, onvifPort: 2, username: 'u', password: 'p' })
  assert.equal(result.ok, false)
  assert.ok(result.errors.length >= 1, 'errors are listed, not swallowed')
})

test('registry: update + remove; remove keeps media and cleans rows', async () => {
  const up = updateCamera('garage', { name: 'Garage cam', enabled: false })
  assert.equal(up.ok, true)
  assert.equal(up.camera.enabled, false)
  assert.equal(up.camera.password, undefined, 'update response is credential-free')
  assert.equal(driverConfigs().some(c => c.id === 'garage'), false, 'disabled camera produces no driver')
  // a recording row + media file that must survive camera removal
  dbMod.db.prepare(`INSERT INTO recordings (id, group_id, camera_id, path, started_at, size_bytes, trigger, status)
      VALUES ('r1', 'g1', 'garage', '/tmp/garage-seg.mp4', '2026-10-09T00:00:00Z', 1000, 'manual', 'ready')`).run()
  const removed = removeCamera('garage')
  assert.equal(removed.ok, true)
  assert.equal(dbMod.db.prepare("SELECT COUNT(*) n FROM recordings WHERE camera_id = 'garage'").get().n, 1,
    'recordings survive camera removal (retention cleans them on its own schedule)')
  assert.equal(dbMod.db.prepare('SELECT COUNT(*) n FROM cameras WHERE id = ?').get('garage').n, 0)
})
