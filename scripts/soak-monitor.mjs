#!/usr/bin/env node
/**
 * HUGO Eye 24h soak monitor — samples the running service every 5 minutes:
 * health, hub states, recording/event integrity, disk, CPU, RSS, and restart
 * counts. Writes JSONL to ~/hugo-eye-data/soak/soak-<ts>.jsonl and a rolling
 * summary to soak-summary.txt. Run: nohup node scripts/soak-monitor.mjs &
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.HUGO_EYE_DATA_DIR ||= path.join(process.env.HOME ?? '', 'hugo-eye-data')
const { config } = await import(path.join(REPO, 'src', 'config.js'))
const API = `http://127.0.0.1:${config.server.port}`
const INTERVAL_MS = 5 * 60 * 1000
const DURATION_MS = 24 * 60 * 60 * 1000

const soakDir = path.join(config.storage.dataDir, 'soak')
fs.mkdirSync(soakDir, { recursive: true })
const outPath = path.join(soakDir, `soak-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}.jsonl`)

let cookie = null
async function ensureLogin() {
  const login = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: API },
    body: JSON.stringify({ token: config.server.apiToken }),
  })
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  if (!cookie) throw new Error('login failed')
}
await ensureLogin()

function procCpuRss(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const p = f.slice(f.lastIndexOf(')') + 2).split(' ')
    const rss = Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4096 / 1024 / 1024
    return { cpuTicks: Number(p[11]) + Number(p[12]) + Number(p[13]) + Number(p[14]), rssMB: Number(rss.toFixed(0)) }
  } catch { return null }
}

function ffmpegChildren() {
  const out = []
  for (const dir of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(dir)) continue
    try {
      const cmd = fs.readFileSync(`/proc/${dir}/cmdline`, 'utf8')
      if (cmd.includes('ffmpeg')) out.push({ pid: Number(dir), args: cmd.replaceAll('\0', ' ').slice(0, 80) })
    } catch { /* gone */ }
  }
  return out
}

function findServicePid() {
  for (const dir of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(dir)) continue
    try {
      const cmd = fs.readFileSync(`/proc/${dir}/cmdline`, 'utf8')
      if (cmd.includes('node') && cmd.includes('src/index.js') && Number(dir) !== process.pid) return Number(dir)
    } catch { /* gone */ }
  }
  return 0
}
const servicePid = findServicePid()
let lastCpu = servicePid ? procCpuRss(servicePid) : null

const startedAt = new Date().toISOString()
console.log(`soak monitor started ${startedAt} → ${outPath}`)
const endAt = Date.now() + DURATION_MS

const tick = async () => {
  const sample = { at: new Date().toISOString() }
  try {
    let health = await (await fetch(`${API}/api/health`, { headers: { Cookie: cookie } })).json()
    let cam = await (await fetch(`${API}/api/cameras`, { headers: { Cookie: cookie } })).json()
    if (cam.error) {
      // session expired mid-soak — re-authenticate and retry once
      await ensureLogin()
      health = await (await fetch(`${API}/api/health`, { headers: { Cookie: cookie } })).json()
      cam = await (await fetch(`${API}/api/cameras`, { headers: { Cookie: cookie } })).json()
    }
    sample.ok = health.ok
    sample.hubs = (health.hubs ?? []).map(h => ({ q: h.quality, state: h.state, fps: h.fps, gop: h.keyframeIntervalS, reconnects: h.reconnects, lastError: h.lastError }))
    sample.storage = { recordingBytes: health.storage?.recordingBytes, freeBytes: health.storage?.freeBytes }
    sample.cameraHealth = cam.cameras.map(c => ({ id: c.id, ok: c.health?.ok ?? null, recording: c.recording?.recording }))
  } catch (e) {
    sample.ok = false
    sample.error = e.message.slice(0, 120)
  }
  const now = servicePid ? procCpuRss(servicePid) : null
  if (now && lastCpu) {
    sample.cpuPct = Number(((now.cpuTicks - lastCpu.cpuTicks) / 100 / (INTERVAL_MS / 1000) * 100).toFixed(1))
    sample.rssMB = now.rssMB
  }
  lastCpu = now
  sample.ffmpegChildren = ffmpegChildren().length
  sample.uptimeS = Math.round((Date.now() - Date.parse(startedAt)) / 1000)
  fs.appendFileSync(outPath, JSON.stringify(sample) + '\n')
}

while (Date.now() < endAt) {
  await tick().catch(e => console.error('soak tick failed:', e.message))
  await new Promise(r => setTimeout(r, INTERVAL_MS))
}
console.log(`soak monitor finished ${new Date().toISOString()}`)
