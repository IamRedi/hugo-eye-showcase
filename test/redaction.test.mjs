import test from 'node:test'
import assert from 'node:assert/strict'
import { maskSecrets, collectSecrets, config } from '../src/config.js'

test('maskSecrets hides configured camera password', () => {
  config.cameras.push({ id: 't', username: 'camuser', password: 'S3cret!!pass' })
  const out = maskSecrets('rtsp failed with password S3cret!!pass somewhere')
  assert.equal(out.includes('S3cret!!pass'), false)
  assert.ok(out.includes('***'))
})

test('maskSecrets hides userinfo URLs even for unknown values', () => {
  const out = maskSecrets('rtsp://alice:topsecret99@192.168.1.64:554/stream1')
  assert.equal(out.includes('topsecret99'), false)
  assert.equal(out.includes('alice'), true) // username alone is not a secret class here
})

test('collectSecrets includes camera credentials and api token', () => {
  config.cameras.push({ id: 't2', username: 'u2', password: 'pw2' })
  config.server.apiToken = 'tok123'
  const secrets = collectSecrets()
  assert.ok(secrets.includes('pw2'))
  assert.ok(secrets.includes('tok123'))
})
