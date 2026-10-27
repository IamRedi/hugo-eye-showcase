import net from 'node:net'
import { db } from './db.js'
import { log } from './log.js'
import { maskSecrets } from './config.js'

/**
 * Camera registry (Gate 9) — the DB is the source of truth for configured
 * cameras. The CAM<n>_* environment groups seed the registry once (backward
 * compatible with 2.x setups); after seeding, onboarding/removal happens
 * through the API without touching .env.
 *
 * Credential discipline: passwords never leave this module's write path —
 * list/create/update responses and logs are password-free (masked).
 */

export function seedFromEnv(envCameras) {
  const now = new Date().toISOString()
  let seeded = 0
  for (const cam of envCameras ?? []) {
    const existing = db.prepare('SELECT id FROM cameras WHERE id = ?').get(cam.id)
    if (existing) continue
    db.prepare(`INSERT INTO cameras (id, kind, name, model, host, rtsp_port, onvif_port, main_path, sub_path, username, password, enabled, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'env', ?, ?)`)
      .run(cam.id, cam.driver ?? 'tapo', cam.name ?? cam.id, cam.model ?? 'unknown',
        cam.host, cam.rtspPort ?? 554, cam.onvifPort ?? 2020,
        cam.mainPath ?? '/stream1', cam.subPath ?? '/stream2', cam.username, cam.password, now, now)
    seeded += 1
  }
  if (seeded) log.info(`camera registry: seeded ${seeded} camera(s) from environment`)
  return seeded
}

/** Registry rows as driver configs (passwords included — internal use only). */
export function driverConfigs() {
  return db.prepare('SELECT * FROM cameras WHERE enabled = 1 ORDER BY created_at').all()
    .map(rowToDriverConfig)
}

export function driverConfigFor(cameraId) {
  const row = db.prepare('SELECT * FROM cameras WHERE id = ?').get(cameraId)
  return row ? rowToDriverConfig(row) : null
}

function rowToDriverConfig(row) {
  return {
    slot: 0,
    id: row.id,
    driver: row.kind,
    name: row.name,
    model: row.model,
    host: row.host,
    rtspPort: row.rtsp_port,
    onvifPort: row.onvif_port,
    mainPath: row.main_path,
    subPath: row.sub_path,
    username: row.username,
    password: row.password,
  }
}

/** Public listing — never includes credentials. */
export function listCameras() {
  return db.prepare('SELECT * FROM cameras ORDER BY created_at').all().map(row => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    model: row.model,
    host: row.host,
    rtspPort: row.rtsp_port,
    onvifPort: row.onvif_port,
    mainPath: row.main_path,
    subPath: row.sub_path,
    username: row.username,
    enabled: Boolean(row.enabled),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/

/**
 * Probe a candidate camera: TCP to RTSP port, ONVIF device info, SDP media
 * check. Returns what was verified so onboarding is evidence-based.
 */
export async function probeCamera({ host, rtspPort = 554, onvifPort = 2020, username, password, mainPath = '/stream1' }) {
  const result = { host, rtspTcp: false, sdp: null, onvif: null, errors: [] }
  result.rtspTcp = await tcpProbe(host, rtspPort)
  if (!result.rtspTcp) result.errors.push(`no TCP connection to rtsp://${host}:${rtspPort}`)
  // SDP DESCRIBE (unauthenticated attempt is fine for shape; we send basic auth)
  try {
    const sdp = await sdpProbe({ host, rtspPort, username, password, path: mainPath })
    result.sdp = sdp
    if (sdp.error) result.errors.push(`RTSP DESCRIBE: ${sdp.error}`)
  } catch (e) {
    result.errors.push(`RTSP DESCRIBE failed: ${e.message}`)
  }
  try {
    const { createOnvifClient } = await import('./camera/onvif.js')
    const onvif = createOnvifClient({ host, rtspPort, onvifPort, username, password })
    result.onvif = await onvif.getDeviceInformation()
    if (!result.onvif.model) result.errors.push('ONVIF reachable but no device information returned')
  } catch (e) {
    result.errors.push(`ONVIF: ${maskSecrets(e.message)}`)
  }
  result.ok = Boolean(result.onvif?.model || result.sdp?.video)
  return result
}

function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port, timeout: timeoutMs })
    socket.on('connect', () => { socket.destroy(); resolve(true) })
    socket.on('error', () => resolve(false))
    socket.on('timeout', () => { socket.destroy(); resolve(false) })
  })
}

function sdpProbe({ host, rtspPort, username, password, path }) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port: rtspPort, timeout: 6000 })
    let buf = ''
    const request = [
      `DESCRIBE rtsp://${host}:${rtspPort}${path} RTSP/1.0`,
      'CSeq: 1',
      'Accept: application/sdp',
      `Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      '', '',
    ].join('\r\n')
    socket.on('connect', () => socket.write(request))
    socket.on('data', d => {
      buf += d.toString('latin1')
      if (buf.includes('\r\n\r\n') && (buf.includes('s=') || buf.includes('RTSP/'))) {
        const status = (buf.match(/RTSP\/1\.0 (\d+)/) ?? [])[1]
        const sdp = buf.slice(buf.indexOf('\r\n\r\n') + 4)
        const video = /m=video (\d+) ([^\r\n]+)/.exec(sdp)
        const audio = /m=audio (\d+) ([^\r\n]+)/.exec(sdp)
        resolve({
          rtspStatus: status ? Number(status) : null,
          video: video ? { codec: video[2].trim() } : null,
          audio: audio ? { spec: audio[2].trim() } : null,
        })
        socket.destroy()
      }
    })
    socket.on('error', e => resolve({ error: e.message }))
    socket.on('timeout', () => { socket.destroy(); resolve({ error: 'timeout' }) })
  })
}

/** Onboard a camera. Validates input, probes when requested, stores. */
export async function createCamera(body, { probe = true } = {}) {
  const id = String(body.id ?? '').trim()
  if (!ID_RE.test(id)) return { ok: false, code: 400, error: 'id must be 2-40 chars: lowercase letters, digits, dashes' }
  if (db.prepare('SELECT id FROM cameras WHERE id = ?').get(id)) return { ok: false, code: 409, error: 'a camera with this id already exists' }
  const host = String(body.host ?? '').trim()
  if (!host) return { ok: false, code: 400, error: 'host required' }
  const username = String(body.username ?? '').trim()
  const password = String(body.password ?? '')
  if (!username || !password) return { ok: false, code: 400, error: 'username and password required' }

  const config = {
    id, kind: String(body.kind ?? 'tapo'), name: String(body.name ?? id).slice(0, 60),
    host, rtspPort: clampPort(body.rtspPort, 554), onvifPort: clampPort(body.onvifPort, 2020),
    mainPath: normPath(body.mainPath, '/stream1'), subPath: normPath(body.subPath, '/stream2'),
    username, password,
  }

  let probeResult = null
  if (probe) {
    probeResult = await probeCamera(config)
    if (!probeResult.ok) {
      return { ok: false, code: 422, error: 'camera could not be verified', probe: summarizeProbe(probeResult) }
    }
  }
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO cameras (id, kind, name, model, host, rtsp_port, onvif_port, main_path, sub_path, username, password, enabled, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'manual', ?, ?)`)
    .run(id, config.kind, config.name, probeResult?.onvif?.model ?? String(body.model ?? 'unknown'),
      host, config.rtspPort, config.onvifPort, config.mainPath, config.subPath, username, password, now, now)
  log.info(`camera registry: onboarded ${id} (${host})`)
  return { ok: true, camera: listCameras().find(c => c.id === id), probe: probeResult ? summarizeProbe(probeResult) : null }
}

export function updateCamera(id, patch) {
  const row = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id)
  if (!row) return { ok: false, code: 404, error: 'camera not found' }
  const now = new Date().toISOString()
  db.prepare(`UPDATE cameras SET
      name = ?, host = ?, rtsp_port = ?, onvif_port = ?, main_path = ?, sub_path = ?,
      username = ?, password = ?, enabled = ?, updated_at = ? WHERE id = ?`)
    .run(
      patch.name !== undefined ? String(patch.name).slice(0, 60) : row.name,
      patch.host !== undefined ? String(patch.host).trim() : row.host,
      patch.rtspPort !== undefined ? clampPort(patch.rtspPort, row.rtsp_port) : row.rtsp_port,
      patch.onvifPort !== undefined ? clampPort(patch.onvifPort, row.onvif_port) : row.onvif_port,
      patch.mainPath !== undefined ? normPath(patch.mainPath, row.main_path) : row.main_path,
      patch.subPath !== undefined ? normPath(patch.subPath, row.sub_path) : row.sub_path,
      patch.username !== undefined ? String(patch.username).trim() : row.username,
      patch.password !== undefined && patch.password !== '' ? String(patch.password) : row.password,
      patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled,
      now, id,
    )
  return { ok: true, camera: listCameras().find(c => c.id === id) }
}

/**
 * Remove a camera and its dependent rows (presets, camera settings, health
 * history, audit-logged). Media files stay on disk (orphan cleanup is a
 * separate, explicit operation) — removal is reversible by re-pairing.
 */
export function removeCamera(id) {
  const row = db.prepare('SELECT id FROM cameras WHERE id = ?').get(id)
  if (!row) return { ok: false, code: 404, error: 'camera not found' }
  db.prepare('DELETE FROM presets WHERE camera_id = ?').run(id)
  db.prepare('DELETE FROM camera_settings WHERE camera_id = ?').run(id)
  db.prepare('DELETE FROM health WHERE camera_id = ?').run(id)
  db.prepare('DELETE FROM cameras WHERE id = ?').run(id)
  log.info(`camera registry: removed ${id}`)
  return { ok: true }
}

export function summarizeProbe(p) {
  return {
    ok: p.ok,
    rtspTcp: p.rtspTcp,
    rtspStatus: p.sdp?.rtspStatus ?? null,
    video: p.sdp?.video?.codec ?? null,
    audio: p.sdp?.audio?.spec ?? null,
    onvifModel: p.onvif?.model ?? null,
    firmware: p.onvif?.firmwareVersion ?? null,
    errors: p.errors,
  }
}

function clampPort(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n < 65536 ? Math.round(n) : fallback
}

function normPath(p, fallback) {
  const s = String(p ?? '').trim()
  if (!s) return fallback
  return s.startsWith('/') ? s : `/${s}`
}
