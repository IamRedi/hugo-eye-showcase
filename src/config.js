import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function loadEnvFile(filePath) {
  const out = {}
  let content = ''
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return out
  }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) continue
    const [, key, raw] = match
    if (process.env[key] === undefined) {
      // strip trailing inline comments (only outside quotes)
      const stripped = raw.replace(/(^|[^\\])\s+#.*$/, '$1').trim()
      process.env[key] = stripped.replace(/^["']|["']$/g, '')
    }
    out[key] = process.env[key]
  }
  return out
}

loadEnvFile(path.join(REPO_ROOT, '.env'))

function envString(name, fallback = '') {
  const value = process.env[name]?.trim()
  return value || fallback
}

function envNumber(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && process.env[name]?.trim() !== '' ? value : fallback
}

function envBool(name, fallback = false) {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value)
}

const dataDir = envString('HUGO_EYE_DATA_DIR', path.join(os.homedir(), 'hugo-eye-data'))

export const config = {
  repoRoot: REPO_ROOT,
  server: {
    host: envString('HUGO_EYE_HOST', '127.0.0.1'),
    port: envNumber('HUGO_EYE_PORT', 8764),
    apiToken: envString('HUGO_EYE_API_TOKEN'),
  },
  storage: {
    dataDir,
    dbPath: envString('HUGO_EYE_DB', path.join(dataDir, 'hugo-eye.db')),
    mediaDir: envString('HUGO_EYE_MEDIA_DIR', path.join(dataDir, 'media')),
  },
  patrol: {
    enabled: envBool('PATROL_ENABLED', false),
    settleMs: Math.max(500, envNumber('PATROL_SETTLE_MS', 2500)),
    tickMs: Math.max(10_000, envNumber('PATROL_TICK_MS', 60_000)),
    limit: Math.max(1, envNumber('PATROL_LIMIT', 12)),
  },
  health: {
    intervalMs: Math.max(5_000, envNumber('HEALTH_INTERVAL_MS', 30_000)),
  },
  cameras: [],
  secretKeys: [],
}

// Cameras: every fully-configured CAM<n>_ group becomes a driver instance.
const seenCameras = new Set()
for (const key of Object.keys(process.env)) {
  const match = key.match(/^CAM(\d+)_ID$/)
  if (!match) continue
  const n = match[1]
  const id = envString(`CAM${n}_ID`)
  if (!id || seenCameras.has(id)) continue
  const driver = envString(`CAM${n}_DRIVER`, 'tapo')
  const host = envString(`CAM${n}_HOST`)
  const username = envString(`CAM${n}_USERNAME`)
  const password = envString(`CAM${n}_PASSWORD`)
  if (!host || !username || !password) {
    console.warn(`[config] camera ${id} (${driver}) is missing host/username/password — skipped`)
    continue
  }
  seenCameras.add(id)
  config.cameras.push({
    slot: n,
    id,
    driver,
    name: envString(`CAM${n}_NAME`, id),
    model: envString(`CAM${n}_MODEL`, 'unknown'),
    host,
    rtspPort: envNumber(`CAM${n}_RTSP_PORT`, 554),
    onvifPort: envNumber(`CAM${n}_ONVIF_PORT`, 2020),
    mainPath: normalizeRtspPath(envString(`CAM${n}_RTSP_MAIN_PATH`, '/stream1')),
    subPath: normalizeRtspPath(envString(`CAM${n}_RTSP_SUB_PATH`, '/stream2')),
    username,
    password,
  })
  config.secretKeys.push(`CAM${n}_PASSWORD`)
}

function normalizeRtspPath(p) {
  return p.startsWith('/') ? p : `/${p}`
}

if (!config.server.apiToken) {
  // Fail closed: no token, no API. The installer generates one.
  config.server.apiToken = ''
}

/** Secrets that must never appear in logs or diagnostics. */
export function collectSecrets() {
  const values = new Set()
  for (const cam of config.cameras) {
    if (cam.password) values.add(cam.password)
    if (cam.username) values.add(cam.username)
  }
  if (config.server.apiToken) values.add(config.server.apiToken)
  return [...values]
}

const SECRET_PLACEHOLDER = '***'

/** Masks every known secret and credential-bearing URL shape in free-form text. */
export function maskSecrets(text, secrets = collectSecrets()) {
  let out = String(text)
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(SECRET_PLACEHOLDER)
  }
  // Defense in depth: mask rtsp/http URLs that embed userinfo even for unknown secrets.
  out = out.replace(/(rtsp|https?):\/\/([^:/@\s]+):([^@\s/]*)@/gi, '$1://$2:***@')
  return out
}

export function redactedRtspUrl(cam, stream = 'main') {
  const p = stream === 'sub' ? cam.subPath : cam.mainPath
  return `rtsp://<user>:***@${cam.host}:${cam.rtspPort}${p}`
}

export function assertConfigured() {
  const problems = []
  if (!config.server.apiToken) problems.push('HUGO_EYE_API_TOKEN is not set')
  if (config.cameras.length === 0) problems.push('no fully configured cameras (CAM1_*)')
  return problems
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex')
}

/** Non-internal IPv4 addresses (for the LAN access banner). */
export function lanAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}
