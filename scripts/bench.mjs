#!/usr/bin/env node
/**
 * HUGO Eye performance benchmark — real measurements against the running
 * service on this hardware. Measures:
 *   - live MJPEG first frame (cold + warm tee join)
 *   - fMP4 first frame (founder + warm join)
 *   - sustained stream throughput + fps
 *   - snapshot latency (3 runs)
 *   - service process CPU (instantaneous, incl. children) + RSS
 * Usage: node scripts/bench.mjs (service must be running)
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.HUGO_EYE_DATA_DIR ||= path.join(process.env.HOME ?? '', 'hugo-eye-data')
const { config } = await import(path.join(REPO, 'src', 'config.js'))

const API = `http://127.0.0.1:${config.server.port}`
const results = []
const row = (k, v) => { results.push([k, v]); console.log(`${k.padEnd(52)} ${v}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// login
const login = await fetch(`${API}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: API },
  body: JSON.stringify({ token: config.server.apiToken }),
})
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
if (!cookie) { console.error('login failed — is the service running?'); process.exit(1) }
const H = { Cookie: cookie, 'Content-Type': 'application/json', Origin: API }

async function grantFor(camera) {
  const r = await (await fetch(`${API}/api/stream-grant`, { method: 'POST', headers: H, body: JSON.stringify({ camera }) })).json()
  return r.grant
}
async function cameraId() {
  const r = await (await fetch(`${API}/api/cameras`, { headers: { Cookie: cookie } })).json()
  return r.cameras[0].id
}

async function ttfb(url, { dwellMs = 0 } = {}) {
  const t0 = Date.now()
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  const reader = res.body.getReader()
  await reader.read()
  const first = Date.now() - t0
  if (dwellMs) await sleep(dwellMs)
  reader.cancel().catch(() => {})
  return { first, res }
}

const cam = await cameraId()

// --- 1. cold + warm MJPEG first frame ---
{
  const g = await grantFor(cam)
  const cold = await ttfb(`${API}/api/cameras/${cam}/stream.mjpeg?grant=${g}&q=sub`)
  row('live mjpeg: first frame (cold, keyframe-bound)', `${cold.first} ms`)
  // hold one viewer open, then measure warm joins
  const holder = await fetch(`${API}/api/cameras/${cam}/stream.mjpeg?grant=${g}&q=sub`)
  await sleep(2500)
  const warmMs = []
  for (let i = 0; i < 3; i++) {
    const g2 = await grantFor(cam)
    const w = await ttfb(`${API}/api/cameras/${cam}/stream.mjpeg?grant=${g2}&q=sub`)
    warmMs.push(w.first)
    await sleep(500)
  }
  row('live mjpeg: warm joins (3 runs)', warmMs.map(v => `${v} ms`).join(', '))
  holder.body.cancel().catch(() => {})
  await sleep(500)
}

// --- 2. fMP4 founder + warm join ---
{
  const g = await grantFor(cam)
  const founder = await ttfb(`${API}/api/cameras/${cam}/stream.fmp4?grant=${g}`)
  row('live fmp4: first frame (new session)', `${founder.first} ms`)
  await sleep(3000)
  const g2 = await grantFor(cam)
  const warm = await ttfb(`${API}/api/cameras/${cam}/stream.fmp4?grant=${g2}`)
  row('live fmp4: warm join (tee)', `${warm.first} ms`)
}

// --- 3. sustained throughput + fps ---
{
  const g = await grantFor(cam)
  const res = await fetch(`${API}/api/cameras/${cam}/stream.mjpeg?grant=${g}&q=sub`)
  const reader = res.body.getReader()
  let bytes = 0
  const parts = []
  const t0 = Date.now()
  while (Date.now() - t0 < 10_000) {
    const { value, done } = await reader.read()
    if (done) break
    bytes += value.length
    parts.push(value)
  }
  reader.cancel().catch(() => {})
  const secs = (Date.now() - t0) / 1000
  const frames = (Buffer.concat(parts).toString('latin1').match(/--ffmpeg/g) ?? []).length
  row('live mjpeg: sustained throughput', `${(bytes / secs / 1024).toFixed(0)} KB/s (~${(frames / secs).toFixed(1)} fps; hub warm — person detection keeps the session up)`)
}

// --- 4. snapshot latency ---
{
  const lats = []
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now()
    const r = await (await fetch(`${API}/api/cameras/${cam}/snapshot`, { method: 'POST', headers: H, body: JSON.stringify({ zone: 'bench' }) })).json()
    if (!r.ok) throw new Error(`snapshot failed: ${r.error}`)
    lats.push(Date.now() - t0)
    await sleep(300)
  }
  row('snapshot latency (3 runs)', lats.map(v => `${v} ms`).join(', '))
}

// --- 5. service CPU (instantaneous, incl. children) + RSS ---
{
  const r = await (await fetch(`${API}/api/health`, { headers: { Cookie: cookie } })).json()
  const hubs = r.hubs ?? []
  const sub = hubs.find(h => h.quality === 'sub')
  if (sub) {
    row('hub state (sub)', `${sub.state}, fps ${sub.fps}, keyframe interval ${sub.keyframeIntervalS ?? '?'} s, reconnects ${sub.reconnects}`)
  }
  const nodeProcs = []
  for (const dir of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(dir)) continue
    try {
      const cmd = fs.readFileSync(`/proc/${dir}/cmdline`, 'utf8')
      if (cmd.includes('src/index.js')) nodeProcs.push(Number(dir))
      if (cmd.includes('ffmpeg') && cmd.includes('pipe')) nodeProcs.push(Number(dir))
    } catch { /* gone */ }
  }
  const ticks = () => nodeProcs.map(p => {
    try {
      const f = fs.readFileSync(`/proc/${p}/stat`, 'utf8')
      const part = f.slice(f.lastIndexOf(')') + 2).split(' ')
      return Number(part[11]) + Number(part[12])
    } catch { return 0 }
  })
  const c0 = ticks().reduce((a, b) => a + b, 0)
  await sleep(8000)
  const c1 = ticks().reduce((a, b) => a + b, 0)
  row('service CPU (node + ffmpeg children)', `${((c1 - c0) / 100 / 8 * 100).toFixed(1)} % of one core`)
  let rss = 0
  try { rss = Number(fs.readFileSync(`/proc/${nodeProcs[0]}/statm`, 'utf8').split(' ')[1]) * 4096 / 1024 / 1024 } catch { /* */ }
  row('service (node) RSS', `${rss.toFixed(0)} MB`)
}

row('disk free (media volume)', `${(Number(fs.statfsSync(config.storage.mediaDir).bavail) * Number(fs.statfsSync(config.storage.mediaDir).bsize) / 1024 ** 3).toFixed(0)} GB`)

const stamp = new Date().toISOString()
const out = [`HUGO Eye benchmark ${stamp}`, ...results.map(([k, v]) => `${k}: ${v}`), ''].join('\n')
fs.writeFileSync(path.join(REPO, 'docs', 'BENCHMARKS-latest.txt'), out)
console.log(`\nwritten to docs/BENCHMARKS-latest.txt`)
