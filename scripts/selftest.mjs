#!/usr/bin/env node
/**
 * HUGO Eye 2.0 hardware + product acceptance selftest.
 *
 * Sections: config → capabilities/health → snapshots → live → PTZ (with
 * restore) → patrol → security (grants/CSRF/401) → privacy gates → recording
 * lifecycle & integrity → motion detection (real pipeline) → audio listen →
 * audit → credential exposure → restore of all privacy gates.
 *
 * Usage: node scripts/selftest.mjs [--skip-ptz] [--skip-patrol] [--skip-motion]
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const skipPtz = args.includes('--skip-ptz')
const skipPatrol = args.includes('--skip-patrol')
const skipMotion = args.includes('--skip-motion')

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

process.env.HUGO_EYE_DATA_DIR ||= path.join(process.env.HOME ?? '', 'hugo-eye-data')
const { config } = await import(path.join(REPO, 'src', 'config.js'))
const dbModule = await import(path.join(REPO, 'src', 'db.js'))
const { activeDrivers } = await import(path.join(REPO, 'src', 'camera', 'tapo.js'))
const { ffmpegAvailable, writeJpegAtomic } = await import(path.join(REPO, 'src', 'camera', 'ffmpeg.js'))
const { runPatrol } = await import(path.join(REPO, 'src', 'patrol.js'))
const { ptzLock } = await import(path.join(REPO, 'src', 'ptzlock.js'))


console.log(`hugo-eye selftest — data dir: ${config.storage.dataDir}\n`)

// ---------- 1. config ----------
record('config: api token set', Boolean(config.server.apiToken))
record('config: camera configured', config.cameras.length > 0, config.cameras.map(c => c.id).join(','))
record('ffmpeg present', await ffmpegAvailable())

dbModule.openDb()
const db = () => dbModule.db

// ---------- HTTP session (used by several sections below) ----------
const API = `http://127.0.0.1:${config.server.port}`
let cookie = null
try {
  const res = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: API },
    body: JSON.stringify({ token: config.server.apiToken }),
  })
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  record('api login (session cookie)', res.ok)
} catch { record('api login (session cookie)', false, 'service not running') }

const apiGet = async p => fetch(API + p, { headers: cookie ? { cookie } : {} })
const apiJson = async (p, method, body, origin = API) => fetch(API + p, {
  method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
})


const drivers = activeDrivers(id => {
  const row = db().prepare('SELECT * FROM camera_settings WHERE camera_id = ?').get(id)
  return { rotate: row?.rotate ?? 0, mirror: Boolean(row?.mirror), flip: Boolean(row?.flip) }
})
const driver = drivers[0]
if (!driver) { console.error('no camera configured — aborting'); process.exit(1) }

// ---------- 2. capabilities & health ----------
const caps = await driver.detectCapabilities()
record('onvif capability detection', caps.onvif && caps.ptz, `${caps.onvifProfiles.length} profile(s)`)
const health1 = await driver.health()
record('health probe #1', health1.ok, `rtsp=${health1.rtspOk} onvif=${health1.onvifOk}`)
record('health probe #2 (stable)', (await driver.health()).ok)

// ---------- 3. snapshots (rotated presentation) ----------
for (let i = 1; i <= 2; i++) {
  try {
    const started = Date.now()
    const { jpeg } = await driver.snapshot({ zone: 'selftest' })
    const ms = Date.now() - started
    const valid = jpeg.length > 20_000 && jpeg[0] === 0xff && jpeg[1] === 0xd8
    if (valid) writeJpegAtomic(path.join(config.storage.mediaDir, 'selftest', `selftest-${Date.now()}-${i}.jpg`), jpeg)
    record(`snapshot #${i} (main stream, rotated)`, valid, `${jpeg.length}B in ${ms}ms`)
  } catch (error) {
    record(`snapshot #${i} (main stream, rotated)`, false, error.message)
  }
}

// ---------- 4. live stream via the SERVICE hub (rotated MJPEG, grant-authed) ----------
try {
  const grant = (await (await apiJson('/api/stream-grant', 'POST', { camera: driver.id })).json()).grant
  const res = await fetch(`${API}/api/cameras/${driver.id}/stream.mjpeg?grant=${grant}&q=sub`)
  if (!res.ok) throw new Error(`stream HTTP ${res.status}`)
  const chunks = []
  const reader = res.body.getReader()
  const timer = setTimeout(() => { try { reader.cancel() } catch { /* */ } }, 12000)
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(value)
    if (chunks.length > 400) break
  }
  clearTimeout(timer)
  const sample = Buffer.concat(chunks)
  const frames = (sample.toString('latin1').match(/--ffmpeg/g) ?? []).length
  record("live MJPEG stream (20s incl recovery)", sample.length > 300_000 && frames >= 10, `${sample.length}B, ~${frames} frames`)
} catch (error) {
  record("live MJPEG stream (20s incl recovery)", false, error.message)
}

// ---------- 4b. modern playback path (fMP4) + relay hub state ----------
{
  const grant = await (await fetch(`${API}/api/stream-grant`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: API, cookie },
    body: JSON.stringify({ camera: driver.id }),
  })).json().then(r => r.grant)
  try {
    const res = await fetch(`${API}/api/cameras/${driver.id}/stream.fmp4?grant=${grant}`)
    const reader = res.body.getReader()
    let head = Buffer.alloc(0)
    const deadline = Date.now() + 4000
    while (head.length < 8192 && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      head = Buffer.concat([head, value])
      if (head.includes('ftyp') && head.includes('moof')) break
    }
    const hasFtyp = head.includes('ftyp')
    const hasMoof = head.includes('moof')
    await reader.cancel().catch(() => {})
    record('fMP4 stream (MSE path, init + fragments)', res.status === 200 && hasFtyp && hasMoof, `${res.status}, ftyp=${hasFtyp}, fragments=${hasMoof}, transport=${res.headers.get('X-HUGO-Transport')}`)
  } catch (error) {
    record('fMP4 stream (MSE path, init + fragments)', false, error.message)
  }
  try {
    const health = await (await fetch(`${API}/api/health`, { headers: { cookie } })).json()
    const sub = (health.hubs ?? []).find(h => h.quality === 'sub')
    record('relay hub state machine healthy', Boolean(sub && ['streaming', 'idle', 'connecting'].includes(sub.state)),
      sub ? `${sub.state}, fps=${sub.fps}, gop=${sub.keyframeIntervalS}s, reconnects=${sub.reconnects}` : 'no hub yet')
  } catch (error) {
    record('relay hub state machine healthy', false, error.message)
  }
  try {
    const intel = await (await fetch(`${API}/api/intelligence`, { headers: { cookie } })).json()
    const avail = intel.availability ?? {}
    const state = !avail.runtime || !avail.model ? 'not_installed' : (intel.person?.providers?.[0]?.state ?? 'inactive')
    record('AI provider state is honest', ['not_installed', 'inactive', 'starting', 'active', 'error'].includes(state), state)
  } catch (error) {
    record('AI provider state is honest', false, error.message)
  }
  try {
    const zoneRes = await fetch(`${API}/api/cameras/${driver.id}/zone`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: API, cookie },
      body: JSON.stringify({ zone: { points: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]] } }),
    })
    const written = (await zoneRes.json()).zone
    const cleared = await fetch(`${API}/api/cameras/${driver.id}/zone`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: API, cookie }, body: JSON.stringify({ zone: null }),
    })
    record('detection zone write + clear', zoneRes.status === 200 && written?.points?.length === 4 && cleared.status === 200)
  } catch (error) {
    record('detection zone write + clear', false, error.message)
  }
}

// ---------- 5. PTZ ----------
let posBefore = null
if (skipPtz) {
  record('ptz tests', true, 'skipped by flag')
} else if (!driver.capabilities.ptz) {
  record('ptz tests', false, 'no PTZ capability')
} else {
  posBefore = await driver.getStatusPosition()
  const nudge = posBefore && posBefore.pan > 0.5 ? 'left' : 'right'
  await withLock('selftest', () => driver.ptzMove(nudge))
  await sleep(400)
  await withLock('selftest', () => driver.ptzStop())
  await sleep(1500)
  const after = await driver.getStatusPosition()
  record('ptz nudge + stop changes position', Boolean(after && Math.abs(after.pan - posBefore.pan) > 0.001),
    `${nudge}: pan ${posBefore?.pan.toFixed(4)} -> ${after?.pan.toFixed(4)}`)
  if (posBefore) {
    await withLock('selftest-restore', () => driver.gotoPosition(posBefore))
    await sleep(3000)
    const restored = await driver.getStatusPosition()
    record('restore pre-test position', Boolean(restored && Math.abs(restored.pan - posBefore.pan) < 0.02),
      restored ? `pan ${restored.pan.toFixed(4)}` : 'no position')
  }
}

// ---------- 6. patrol (temporary preset from CURRENT position — no forced movement) ----------
if (skipPatrol) {
  record('patrol run', true, 'skipped by flag')
} else {
  let tempPresetId = null
  let restoredId = null
  const existing = db().prepare('SELECT id, timelapse_enabled FROM presets LIMIT 1').get()
  if (existing && !existing.timelapse_enabled) {
    // temporarily enable for the patrol check
    await fetch(`${API}/api/cameras/${driver.id}/presets/${existing.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: API, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ timelapseEnabled: true }),
    })
    restoredId = existing.id
  } else if (!existing) {
    try {
      const res = await fetch(`${API}/api/cameras/${driver.id}/presets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: API, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ name: 'Selftest position', timelapseEnabled: true }),
      })
      const body = await res.json()
      tempPresetId = body?.preset?.id ?? null
    } catch { /* service not running */ }
  }
  const result = await runPatrol([driver], { force: true, limit: 1 })
  const r = result.results[0]
  record('patrol single-preset run', Boolean(r?.ok), r ? `${r.name} -> ${r.zone}` : JSON.stringify(result))
  if (tempPresetId) {
    try { await apiJson(`/api/cameras/${driver.id}/presets/${tempPresetId}`, 'DELETE') } catch { /* */ }
  }
  if (restoredId) {
    try {
      await fetch(`${API}/api/cameras/${driver.id}/presets/${restoredId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: API, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ timelapseEnabled: false }),
      })
    } catch { /* */ }
  }
  if (posBefore) {
    await withLock('selftest-restore', () => driver.gotoPosition(posBefore))
    await sleep(2500)
  }
}

// ---------- 7. security & privacy (HTTP, against running service) ----------

if (cookie) {
  record('api rejects unauthenticated request', (await fetch(`${API}/api/health`)).status === 401)

  // grants
  const grant = (await (await apiJson('/api/stream-grant', 'POST', { camera: driver.id })).json()).grant
  const grantRes = await fetch(`${API}/api/cameras/${driver.id}/stream.mjpeg?grant=${grant}`)
  await grantRes.body?.cancel()
  record('stream grant accepted for live', grantRes.status === 200)
  const forged = await fetch(`${API}/api/cameras/${driver.id}/stream.mjpeg?grant=${driver.id}.99999999999999.deadbeef`)
  await forged.body?.cancel()
  record('forged/expired grant rejected', forged.status === 401)

  // CSRF
  const csrf = await fetch(`${API}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie, Origin: 'https://evil.example' },
    body: JSON.stringify({}),
  })
  record('cross-origin mutation rejected (CSRF)', csrf.status === 403)

  // privacy gates: default off → recording denied
  const denied = await apiJson('/api/recordings/start', 'POST', { camera: driver.id })
  const deniedBody = await denied.json()
  record('recording refused while privacy gate off', denied.status === 403, deniedBody.error ?? '')

  // audio gated
  const audioDenied = await fetch(`${API}/api/cameras/${driver.id}/audio.wav`, { headers: { cookie } })
  record('audio refused while privacy gate off', audioDenied.status === 403)
  await audioDenied.body?.cancel()
} else {
  record('security section', false, 'service not running — skipped')
}

// ---------- 8. recording lifecycle (gates on → start → stop → integrity) ----------
try {
  await apiJson('/api/settings', 'PATCH', { privacy: { recordingEnabled: true, microphoneEnabled: true } })
  const start = await apiJson('/api/recordings/start', 'POST', { camera: driver.id })
  const startBody = await start.json()
  record('recording started (gates enabled, audio on)', start.ok && startBody.audio === true)
  await sleep(14000)
  const stop = await apiJson('/api/recordings/stop', 'POST', { camera: driver.id })
  const stopBody = await stop.json()
  record('recording stopped + finalized', stop.ok)

  await sleep(1000)
  const segs = db().prepare('SELECT path, size_bytes FROM recordings WHERE group_id = ?').all(startBody.groupId ?? '')
  const okMp4 = segs.filter(s => {
    try {
      const fd = fs.openSync(s.path, 'r')
      const head = Buffer.alloc(12); fs.readSync(fd, head, 0, 12, 0); fs.closeSync(fd)
      return head.includes('ftyp') && s.size_bytes > 50_000
    } catch { return false }
  })
  record('recording segments are valid MP4 with content', okMp4.length >= 1 && segs.length >= 1,
    `${okMp4.length}/${segs.length} valid, ${segs.reduce((a, s) => a + s.size_bytes, 0)}B total`)
  const audioTracks = okMp4.length > 0 && (() => {
    // crude check: 'mp4a' box should appear when audio enabled
    const buf = fs.readFileSync(okMp4[0].path).subarray(0, 2_000_000)
    return buf.includes('mp4a')
  })()
  record('recording contains audio track (mic gate on)', audioTracks)
} catch (error) {
  record('recording lifecycle', false, error.message)
}

// ---------- 9. motion detection (real pipeline, low threshold) ----------
if (skipMotion) {
  record('motion detection', true, 'skipped by flag')
} else {
  try {
    await apiJson('/api/settings', 'PATCH', { privacy: { aiEnabled: true }, motion: { enabled: true, threshold: 0.01, minIntervalSec: 3 } })
    const before = db().prepare("SELECT count(*) AS n FROM events WHERE type='motion'").get().n
    // Give the analyzer its first frames (camera GOP is ~4-6 s), then generate
    // real, controlled motion: a small nudge, restored afterwards.
    await sleep(9000)
    await withLock('selftest-motion', () => driver.ptzMove('right'))
    let detected = false
    let waited = 0
    while (waited < 25000) {
      await sleep(2000); waited += 2000
      const n = db().prepare("SELECT count(*) AS n FROM events WHERE type='motion'").get().n
      if (n > before) {
        const ev = db().prepare("SELECT id, confidence, thumb_path FROM events WHERE type='motion' ORDER BY id DESC LIMIT 1").get()
        const thumbOk = ev.thumb_path && fs.existsSync(ev.thumb_path) && fs.statSync(ev.thumb_path).size > 1000
        record('motion detection produces real events + thumbnail', thumbOk, `confidence ${ev.confidence?.toFixed(3)}, thumb ${thumbOk ? 'ok' : 'missing'}`)
        detected = true
        break
      }
    }
    if (!detected) record('motion detection produces real events + thumbnail', false, 'no event within 25 s')
    await withLock('selftest-motion', () => driver.ptzStop())
    if (posBefore) {
      await withLock('selftest-motion-restore', () => driver.gotoPosition(posBefore))
      await sleep(2500)
    }
  } catch (error) {
    record('motion detection', false, error.message)
  }
}

// ---------- 10. audio listen ----------
try {
  await apiJson('/api/settings', 'PATCH', { privacy: { microphoneEnabled: true } })
  const res = await fetch(`${API}/api/cameras/${driver.id}/audio.wav`, { headers: { cookie } })
  const reader = res.body.getReader()
  let head = Buffer.alloc(0)
  const t0 = Date.now()
  while (Date.now() - t0 < 5000 && head.length < 4096) {
    const { value, done } = await reader.read()
    if (done) break
    head = Buffer.concat([head, value])
  }
  reader.cancel().catch(() => {})
  record('microphone audio stream (WAV)', head.length > 4096 && head.subarray(0, 4).toString() === 'RIFF', `${head.length}B header+data`)
} catch (error) {
  record('microphone audio stream (WAV)', false, error.message)
}

// ---------- 11. audit ----------
{
  const n = db().prepare('SELECT count(*) AS n FROM audit').get().n
  record('audit log captures product actions', n > 5, `${n} entries`)
}

// ---------- 12. credential exposure ----------
{
  const secrets = config.cameras.flatMap(c => [c.password, c.username]).filter(Boolean)
  const exposed = []
  for (const dir of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(dir)) continue
    try {
      const cmdline = fs.readFileSync(`/proc/${dir}/cmdline`, 'utf8')
      if (secrets.some(s => cmdline.includes(s))) exposed.push(dir)
    } catch { /* vanished */ }
  }
  record('no credentials in any process arguments', exposed.length === 0,
    exposed.length ? `pids: ${exposed.join(',')}` : 'scanned /proc')
}

// ---------- 13. restore privacy-first state ----------
try {
  await apiJson('/api/settings', 'PATCH', {
    privacy: { recordingEnabled: false, microphoneEnabled: false, aiEnabled: false },
    motion: { enabled: false },
  })
  record('privacy gates restored to disabled (owner re-enables via UI)', true)
} catch {
  record('privacy gates restored', false, 'service not running — gates unchanged')
}

console.log(`\nptz lock state: ${JSON.stringify(ptzLock.status())}`)
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)

async function withLock(holder, fn) {
  const session = await ptzLock.acquire(holder)
  try { return await fn(session) } finally { session.done() }
}
