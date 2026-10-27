import crypto from 'node:crypto'
import { config, maskSecrets } from './config.js'
import { db } from './db.js'
import { log } from './log.js'

/**
 * Security helpers: DB-backed sessions (revocable, expiring), short-lived
 * HMAC stream grants, same-origin enforcement, audit log.
 */

const SESSION_TTL_MS = 12 * 60 * 60 * 1000
export const GRANT_TTL_MS = 90 * 1000

// ---------- sessions ----------

export function createSession(label = 'panel') {
  const id = crypto.randomBytes(24).toString('hex')
  db.prepare('INSERT INTO sessions (id, label, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)')
    .run(id, label, new Date().toISOString(), new Date(Date.now() + SESSION_TTL_MS).toISOString())
  return id
}

export function sessionValid(id) {
  if (!id) return false
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
  if (!row || row.revoked) return false
  if (new Date(row.expires_at).getTime() < Date.now()) return false
  return true
}

export function revokeSession(id) {
  db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(id)
  audit('session.revoked', id.slice(0, 8))
}

export function listSessions() {
  return db.prepare(`SELECT id, label, created_at, expires_at, revoked FROM sessions
      ORDER BY created_at DESC LIMIT 50`).all()
    .map(r => ({
      ...r,
      id: r.id.slice(0, 8) + '…',
      revoked: Boolean(r.revoked),
      expired: new Date(r.expires_at).getTime() < Date.now(),
    }))
}

export function revokeAllSessions() {
  db.prepare('UPDATE sessions SET revoked = 1 WHERE revoked = 0').run()
  audit('session.revoked_all')
}

// ---------- stream grants ----------

function hmac(data) {
  return crypto.createHmac('sha256', config.server.apiToken).update(data).digest('hex').slice(0, 32)
}

export function createStreamGrant(cameraId) {
  const exp = Date.now() + GRANT_TTL_MS
  return `${cameraId}.${exp}.${hmac(`${cameraId}.${exp}`)}`
}

export function grantValid(grant, cameraId) {
  if (!grant) return false
  const [cid, expStr, sig] = String(grant).split('.')
  if (cid !== cameraId) return false
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const expected = hmac(`${cid}.${exp}`)
  const a = Buffer.from(sig ?? '')
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ---------- same-origin (CSRF) ----------

/**
 * Mutating requests authenticated by COOKIE must be same-origin (browsers
 * attach cookies cross-site). Bearer-token requests are exempt (no ambient
 * credentials). Returns null when OK, or an HTTP status code.
 */
export function sameOriginViolation(req) {
  const usingCookie = Boolean(parseCookieHeader(req.headers.cookie)?.hugo_eye_session)
  const usingBearer = Boolean(req.headers.authorization)
  if (!usingCookie || usingBearer) return null
  const host = req.headers.host
  const origin = req.headers.origin ?? req.headers.referer ?? null
  if (!origin) return 403 // cookie-authenticated mutations must declare origin
  try {
    const originHost = new URL(origin).host
    return originHost === host ? null : 403
  } catch {
    return 403
  }
}

export function parseCookieHeader(header) {
  const out = {}
  if (!header) return out
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=')
    if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }
  return out
}

// ---------- audit ----------

export function audit(action, detail = '') {
  try {
    db.prepare('INSERT INTO audit (at, action, detail) VALUES (?, ?, ?)')
      .run(new Date().toISOString(), action, String(detail).slice(0, 500))
  } catch (error) {
    log.warn(`audit write failed: ${maskSecrets(error.message)}`)
  }
}

export function listAudit(limit = 100) {
  return db.prepare('SELECT at, action, detail FROM audit ORDER BY id DESC LIMIT ?').all(limit)
}
