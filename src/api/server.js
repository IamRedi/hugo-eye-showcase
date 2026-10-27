import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, maskSecrets } from '../config.js'
import { log } from '../log.js'
import { db, recordEvent } from '../db.js'
import { withPtzLock, ptzLock } from '../ptzlock.js'
import { mapPtzCommand } from '../orientation.js'
import { writeJpegAtomic } from '../camera/ffmpeg.js'
import { commandNames } from '../camera/onvif.js'
import {
  getProductSettings, setProductSettings, getCameraSettings, setCameraSettings, cameraPrivacyBlocked,
} from '../settings.js'
import {
  listPresets, getPreset, createPreset, updatePreset, deletePreset, safeZone,
} from '../presets.js'
import { listMedia, mediaZones, resolveMediaPath } from '../media.js'
import { runPatrol, patrolStatus } from '../patrol.js'
import { adapterManifest } from '../adapter/deviceAdapter.js'
import {
  createSession, sessionValid, revokeSession, revokeAllSessions, listSessions,
  createStreamGrant, grantValid, sameOriginViolation, parseCookieHeader,
  audit, listAudit, GRANT_TTL_MS,
} from '../security.js'
import { signalBus } from '../eventbus.js'
import { searchEvents } from '../search.js'
import { listCameras, probeCamera, createCamera, updateCamera, removeCamera, summarizeProbe } from '../cameras.js'
import {
  startRecording, stopRecording, recordingState, storageStats,
  enforceQuotaAndRetention, deleteRecordingGroup,
} from '../recordings.js'
import { listEvents, eventThumb, eventBus } from '../intelligence.js'
import { getCameraZone, setCameraZone } from '../ai/detector.js'
import { PeopleRegistry } from '../people.js'
import * as rules from '../automations.js'
import {
  executeCapabilityRequest, cancelCapabilityRequest, negotiate, runtimeSnapshot, bumpGeneration,
  capabilityDescriptors, providerIdentity,
  pairRequest, approvePairing, rejectPairing, revokePairing,
  pairingStatus, pairingTokenValid,
} from '../adapter/deviceAdapter.js'
import { getHub, allHubStatus, hubStatusForCamera } from '../camera/hub.js'

const UI_DIST = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), 'ui', 'dist')
const LEGACY_PANEL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'panel.html')
const COOKIE = 'hugo_eye_session'
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.json': 'application/json', '.map': 'application/json',
}
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
}

/**
 * Sliding-window rate limiter for sensitive or expensive endpoints
 * (per remote address; the appliance is local-first, so this is a
 * defensible backstop rather than a public-internet defense).
 */
function rateLimiter({ limit, windowMs }) {
  const hits = new Map()
  return req => {
    const ip = req.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    const entry = hits.get(ip)
    if (!entry || now > entry.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs })
      return false
    }
    entry.count += 1
    if (entry.count % 50 === 0) {  // opportunistic GC of stale entries
      for (const [key, value] of hits) if (now > value.resetAt) hits.delete(key)
    }
    return entry.count > limit
  }
}

const MAX_STREAMS_PER_CLIENT = 4

export function createServer({ drivers, healthMonitor, intelligence, searchIndexer = null, autoFollow = null, reconcileRecordings = null, sessionizer = null }) {
  const driverById = new Map(drivers.map(d => [d.id, d]))
  const people = new PeopleRegistry()
  const loginAttempts = new Map()
  const LOGIN_LIMIT = 5
  const LOGIN_WINDOW_MS = 15 * 60 * 1000
  const limitGrant = rateLimiter({ limit: 30, windowMs: 60_000 })
  const limitSnapshot = rateLimiter({ limit: 12, windowMs: 60_000 })
  const liveStreamsPerClient = new Map()  // remote address -> count

  const server = http.createServer((req, res) => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value)
    handle(req, res).catch(error => {
      log.error(`api: ${maskSecrets(error.stack ?? error.message)}`)
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' })
      else res.end()
    })
  })

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const parts = url.pathname.split('/').filter(Boolean)

    // ---- public: login + UI shell + legacy panel ----
    if (req.method === 'POST' && url.pathname === '/api/login') return handleLogin(req, res)
    if (req.method === 'GET' && url.pathname === '/legacy') {
      const html = fs.readFileSync(LEGACY_PANEL)
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html)
    }

    // ---- static UI (unauthenticated shell; data is behind auth) ----
    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/media/')) {
      return serveStatic(url.pathname, res)
    }

    // ---- everything else requires auth ----
    // Stream endpoints accept a short-lived grant instead of a session
    // (shareable, self-expiring); the route handler validates it strictly.
    const isGrantStream = req.method === 'GET' &&
      /^\/api\/cameras\/[^/]+\/stream\.(mjpeg|fmp4)$/.test(url.pathname) &&
      Boolean(url.searchParams.get('grant'))
    const session = isGrantStream ? { kind: 'grant', id: null } : authenticate(req)
    if (!session) {
      return json(res, 401, { ok: false, error: 'unauthorized' })
    }

    // ---- CSRF / same-origin for mutations ----
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const violation = sameOriginViolation(req)
      if (violation) {
        audit('security.csrf_blocked', `${req.method} ${url.pathname} origin=${req.headers.origin ?? 'none'}`)
        return json(res, violation, { ok: false, error: 'cross-origin request rejected' })
      }
    }

    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : {}

    // ---- meta ----
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        product: 'HUGO Eye',
        version: '2.1.0',
        cameras: Object.fromEntries(drivers.map(d => [d.id, healthMonitor.snapshot(d.id)])),
        hubs: allHubStatus(),
        ptzLock: ptzLock.status(),
        storage: storageStats(),
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return json(res, 200, { ok: true, settings: getProductSettings() })
    }
    if (req.method === 'PATCH' && url.pathname === '/api/settings') {
      const before = getProductSettings()
      const settings = setProductSettings(body)
      for (const key of ['recordingEnabled', 'microphoneEnabled', 'aiEnabled']) {
        if (before.privacy[key] !== settings.privacy[key]) {
          audit(`privacy.${key}`, String(settings.privacy[key]))
        }
      }
      if (before.recording?.mode !== settings.recording?.mode) {
        audit('recording.mode', String(settings.recording.mode))
        reconcileRecordings?.()
      }
      if (JSON.stringify(before.motion) !== JSON.stringify(settings.motion) ||
          JSON.stringify(before.automations) !== JSON.stringify(settings.automations)) {
        audit('settings.updated', JSON.stringify({ motion: settings.motion, automations: settings.automations }))
      }
      await intelligence.reconcile()
      return json(res, 200, { ok: true, settings })
    }

    if (req.method === 'GET' && url.pathname === '/api/cameras') {
      return json(res, 200, {
        ok: true,
        cameras: drivers.map(d => {
          const cs = getCameraSettings(d.id)
          return {
            id: d.id,
            kind: d.kind,
            name: cs?.displayName ?? d.cam.name,
            model: d.cam.model,
            host: d.cam.host,
            rtspPort: d.cam.rtspPort,
            onvifPort: d.cam.onvifPort,
            mainPath: d.cam.mainPath,
            subPath: d.cam.subPath,
            orientation: { rotate: cs?.rotate ?? 0, mirror: cs?.mirror ?? false, flip: cs?.flip ?? false },
            privacyBlocked: cs?.privacyDisabled ?? false,
            capabilities: d.capabilities,
            health: healthMonitor.snapshot(d.id),
            recording: recordingState(d.id),
            stream: hubStatusForCamera(d.id),
          }
        }),
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/storage') {
      return json(res, 200, { ok: true, ...storageStats() })
    }
    if (req.method === 'GET' && url.pathname === '/api/access/sessions') {
      return json(res, 200, { ok: true, sessions: listSessions() })
    }
    if (req.method === 'POST' && url.pathname === '/api/access/sessions/revoke-all') {
      revokeAllSessions()
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      if (session.id) revokeSession(session.id)
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`)
      return json(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/api/audit') {
      return json(res, 200, { ok: true, entries: listAudit(100) })
    }
    if (req.method === 'POST' && url.pathname === '/api/stream-grant') {
      if (limitGrant(req)) return json(res, 429, { ok: false, error: 'too many grant requests' })
      const cameraId = String(body.camera ?? drivers[0]?.id ?? '')
      if (!driverById.has(cameraId)) return json(res, 404, { ok: false, error: 'camera not found' })
      return json(res, 200, { ok: true, grant: createStreamGrant(cameraId), expiresInMs: GRANT_TTL_MS })
    }

    // ---- events (Activity) ----
    if (req.method === 'GET' && url.pathname === '/api/events') {
      return json(res, 200, {
        ok: true,
        events: listEvents({
          cameraId: url.searchParams.get('camera'),
          type: url.searchParams.get('type'),
          since: url.searchParams.get('since'),
          limit: Math.min(500, Number(url.searchParams.get('limit') ?? 100)),
        }),
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/events/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      const onEvent = event => {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch { /* closed */ }
      }
      eventBus.on('event', onEvent)
      const ping = setInterval(() => { try { res.write(': ping\n\n') } catch { /* closed */ } }, 25000)
      req.on('close', () => { eventBus.off('event', onEvent); clearInterval(ping) })
      return
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'events' && parts[2] && parts[3] === 'thumb') {
      const thumb = eventThumb(Number(parts[2]))
      if (!thumb) return json(res, 404, { ok: false, error: 'thumb not found' })
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' })
      return res.end(thumb)
    }
    // Wrong-match correction: the owner re-attributes a recognition event
    // (or clears it to unknown). Audit-logged; never rewrites history silently.
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'events' && parts[2] && parts[3] === 'attribute') {
      const eventId = Number(parts[2])
      const row = db.prepare('SELECT id, type, person_id FROM events WHERE id = ?').get(eventId)
      if (!row) return json(res, 404, { ok: false, error: 'event not found' })
      const personId = body.personId ?? null
      if (personId !== null) {
        const person = people.get(String(personId))
        if (!person) return json(res, 404, { ok: false, error: 'person not found' })
      }
      db.prepare('UPDATE events SET person_id = ? WHERE id = ?').run(personId, eventId)
      audit('recognition.corrected', `event ${eventId}: ${row.person_id ?? 'unknown'} → ${personId ?? 'unknown'}`)
      return json(res, 200, { ok: true, eventId, personId })
    }

    // ---- intelligence ----
    if (req.method === 'GET' && url.pathname === '/api/intelligence') {
      return json(res, 200, { ok: true, ...intelligence.status() })
    }

    // ---- recordings ----
    if (req.method === 'GET' && url.pathname === '/api/recordings') {
      const camera = url.searchParams.get('camera')
      const rows = db.prepare(`SELECT id, group_id, camera_id, path, started_at, ended_at, duration_s, size_bytes, trigger, status, thumb_path
          FROM recordings WHERE (? IS NULL OR camera_id = ?) ORDER BY started_at DESC LIMIT 500`)
        .all(camera, camera)
      return json(res, 200, {
        ok: true,
        recordings: rows.map(r => ({
          id: r.id, groupId: r.group_id, cameraId: r.camera_id,
          startedAt: r.started_at, endedAt: r.ended_at, sizeBytes: r.size_bytes,
          durationS: r.duration_s, trigger: r.trigger, status: r.status,
          thumbUrl: r.thumb_path ? `/api/recordings/${r.id}/thumb` : null,
          url: `/api/recordings/${r.id}/file`,
        })),
      })
    }
    if (req.method === 'POST' && url.pathname === '/api/recordings/start') {
      const driver = driverById.get(String(body.camera ?? drivers[0]?.id ?? ''))
      if (!driver) return json(res, 404, { ok: false, error: 'camera not found' })
      const result = await startRecording(driver, { trigger: 'manual' })
      return json(res, result.ok ? 200 : (result.code ?? 400), result)
    }
    if (req.method === 'POST' && url.pathname === '/api/recordings/stop') {
      const cameraId = String(body.camera ?? drivers[0]?.id ?? '')
      const result = await stopRecording(cameraId, { reason: 'manual' })
      return json(res, result.ok ? 200 : (result.code ?? 400), result)
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'recordings' && parts[2] && parts[3] === 'thumb') {
      const rec = db.prepare('SELECT thumb_path FROM recordings WHERE id = ?').get(parts[2])
      if (!rec?.thumb_path || !fs.existsSync(rec.thumb_path)) return json(res, 404, { ok: false, error: 'no thumbnail' })
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' })
      return res.end(fs.readFileSync(rec.thumb_path))
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'recordings' && parts[2] && parts[3] === 'file') {
      const row = db.prepare('SELECT path FROM recordings WHERE id = ?').get(parts[2])
      if (!row || !fs.existsSync(row.path)) return json(res, 404, { ok: false, error: 'recording not found' })
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': fs.statSync(row.path).size,
        'Content-Disposition': `attachment; filename="${path.basename(row.path)}"`,
        'Cache-Control': 'private, no-store',
      })
      return fs.createReadStream(row.path).pipe(res)
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'recordings' && parts[2] && !parts[3]) {
      if (body?.confirm !== true && url.searchParams.get('confirm') !== 'true') {
        return json(res, 400, { ok: false, error: 'confirm=true required' })
      }
      const deleted = deleteRecordingGroup(parts[2])
      return json(res, 200, { ok: true, deleted })
    }

    // ---- automations (bounded) ----
    if (req.method === 'GET' && url.pathname === '/api/automations') {
      const s = getProductSettings()
      return json(res, 200, {
        ok: true,
        automations: [
          {
            id: 'motion_record',
            label: 'Motion → record',
            description: `When motion is detected, record for ${s.automations.motionRecord.seconds} s (requires recording + AI enabled)`,
            enabled: s.automations.motionRecord.enabled,
            requires: ['aiEnabled', 'recordingEnabled'],
            configurable: { seconds: '5-300' },
          },
          {
            id: 'motion_notify',
            label: 'Motion → notify',
            description: 'Show a live notification in the panel when motion is detected',
            enabled: s.automations.motionNotify.enabled,
            requires: ['aiEnabled'],
          },
        ],
        customRulesAvailable: true,
      })
    }
    if (req.method === 'PATCH' && url.pathname === '/api/automations') {
      const patch = {}
      if (body.id === 'motion_record') {
        patch.automations = { motionRecord: { enabled: Boolean(body.enabled) } }
        if (body.seconds !== undefined) patch.automations.motionRecord.seconds = Number(body.seconds)
      } else if (body.id === 'motion_notify') {
        patch.automations = { motionNotify: { enabled: Boolean(body.enabled) } }
      } else {
        return json(res, 400, { ok: false, error: 'unknown automation' })
      }
      const settings = setProductSettings(patch)
      audit('automation.updated', `${body.id} → ${JSON.stringify(body.enabled)}`)
      await intelligence.reconcile()
      return json(res, 200, { ok: true, automations: settings.automations })
    }

    // ---- HUGO Core DeviceAdapter boundary (contract: hugo-core cf03ce5) ----
    // Discovery documents are public-read within the LAN (they contain no
    // credentials); pairing approval is owner-gated; execute/cancel accept
    // the pairing token (transport) while authority stays with the Core gate.
    const adapterDriver = drivers[0]
    if (req.method === 'GET' && url.pathname === '/api/adapter/manifest') {
      return json(res, 200, adapterManifest(adapterDriver))
    }
    if (req.method === 'GET' && url.pathname === '/api/adapter/capabilities') {
      return json(res, 200, { providerInstanceId: providerIdentity(adapterDriver).instanceId, registrations: capabilityDescriptors(adapterDriver) })
    }
    if (req.method === 'GET' && url.pathname === '/api/adapter/runtime-snapshot') {
      const snapshot = runtimeSnapshot(adapterDriver, healthMonitor)
      return json(res, snapshot.ok ? 200 : 500, snapshot.ok ? snapshot.snapshot : { error: snapshot.error })
    }
    if (req.method === 'POST' && url.pathname === '/api/adapter/negotiate') {
      const requested = Array.isArray(body.capabilities) ? body.capabilities : []
      const result = negotiate(adapterDriver, requested)
      return json(res, result.ok ? 200 : 400, result.ok
        ? { ...result.result, generation: runtimeSnapshot(adapterDriver, healthMonitor).ok ? runtimeSnapshot(adapterDriver, healthMonitor).snapshot.generation : 0 }
        : { error: result.error })
    }
    const adapterEnvelopeRoute = url.pathname === '/api/adapter/execute' || url.pathname === '/api/adapter/cancel'
    if (adapterEnvelopeRoute) {
      const ownerSession = Boolean(authenticate(req))
      const pairingBearer = req.headers.authorization?.startsWith('Bearer ')
        ? pairingTokenValid(req.headers.authorization.slice(7))
        : false
      if (!ownerSession && !pairingBearer) return json(res, 401, { ok: false, error: 'pairing token or owner session required' })
      if (!pairingStatus().paired && !ownerSession) return json(res, 403, { ok: false, error: 'not paired' })
      const driver = driverById.get(String(body.provider ?? drivers[0]?.id ?? ''))
      if (!driver) return json(res, 404, { ok: false, error: 'camera not found' })
      const ctx = { driver, healthMonitor, intelligence, stopRecording }
      const envelope = body.request ?? body
      const result = url.pathname.endsWith('/cancel')
        ? await cancelCapabilityRequest(envelope, ctx)
        : await executeCapabilityRequest(envelope, ctx)
      if (!result.ok) return json(res, 422, { ok: false, errors: result.errors })
      audit('adapter.execute', `${envelope.capability ?? 'unknown'} → ${result.result.state}`)
      return json(res, 200, result.result)
    }
    if (req.method === 'POST' && url.pathname === '/api/adapter/pair/request') {
      const result = pairRequest({ name: body.name })
      log.info(`adapter: pairing requested by "${body.name ?? 'hugo-core'}" — awaiting owner approval`)
      return json(res, 202, { ok: true, ...result })
    }
    if (url.pathname.startsWith('/api/adapter/pairing')) {
      const ownerSession = Boolean(authenticate(req))
      if (!ownerSession) return json(res, 401, { ok: false, error: 'owner session required' })
      if (req.method === 'GET' && url.pathname === '/api/adapter/pairing') {
        return json(res, 200, { ok: true, ...pairingStatus() })
      }
      if (req.method === 'POST' && url.pathname === '/api/adapter/pairing/approve') {
        const approved = approvePairing()
        if (!approved) return json(res, 404, { ok: false, error: 'no pending pairing request' })
        audit('adapter.paired', `${approved.name} — token minted`)
        return json(res, 200, { ok: true, ...approved, note: 'hand this token to HUGO Core once; it is stored hashed' })
      }
      if (req.method === 'POST' && url.pathname === '/api/adapter/pairing/reject') {
        rejectPairing()
        audit('adapter.pairing_rejected')
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && url.pathname === '/api/adapter/pairing/revoke') {
        const revoked = revokePairing()
        audit('adapter.unpaired', revoked.name ?? '')
        return json(res, 200, { ok: true, ...revoked })
      }
    }

    // ---- vision: scene + detections (Live overlay, Compact panel, HUGO) ----
    if (req.method === 'GET' && url.pathname === '/api/vision/visits') {
      return json(res, 200, { ok: true, ...(sessionizer?.status() ?? { openVisits: [] }) })
    }
    if (req.method === 'GET' && url.pathname === '/api/vision/overlay') {
      const camId = url.searchParams.get('camera') ?? drivers[0]?.id
      if (!driverById.has(camId)) return json(res, 404, { ok: false, error: 'camera not found' })
      if (cameraPrivacyBlocked(camId)) return json(res, 403, { ok: false, error: 'This camera is privacy-blocked' })
      return json(res, 200, { ok: true, at: new Date().toISOString(), tracks: intelligence.overlay(camId) })
    }
    if (req.method === 'GET' && url.pathname === '/api/vision/scene') {
      return json(res, 200, { ok: true, scene: intelligence.sceneSnapshot(url.searchParams.get('camera')) })
    }
    if (req.method === 'GET' && url.pathname === '/api/vision/detections') {
      const cameraId = url.searchParams.get('camera')
      const out = []
      for (const ctx of intelligence.runtimes?.values?.() ?? []) {
        if (cameraId && ctx.driver.id !== cameraId) continue
        const person = ctx.person.status()
        for (const t of person.live ?? []) {
          out.push({ cameraId: ctx.driver.id, kind: 'object', label: t.label, trackId: t.trackId, score: t.score, box: t.box, at: ctx.runtime.lastFrameAt ? new Date(ctx.runtime.lastFrameAt).toISOString() : null })
        }
        for (const f of ctx.face.status().faces ?? []) {
          out.push({ cameraId: ctx.driver.id, kind: 'face', label: f.familiar ? 'known_face' : 'face', name: f.familiar?.name ?? null, trackId: f.trackId, score: f.score, box: f.box, at: ctx.runtime.lastFrameAt ? new Date(ctx.runtime.lastFrameAt).toISOString() : null })
        }
      }
      return json(res, 200, { ok: true, detections: out })
    }

    // ---- people registry ----
    if (req.method === 'GET' && url.pathname === '/api/people') {
      return json(res, 200, { ok: true, people: people.list() })
    }
    if (req.method === 'POST' && url.pathname === '/api/people') {
      if (!body.name) return json(res, 400, { ok: false, error: 'name required' })
      const person = people.create({ name: body.name, notes: body.notes })
      audit('people.created', person.name)
      return json(res, 201, { ok: true, person })
    }
    if (req.method === 'PATCH' && /^\/api\/people\/[^/]+$/.test(url.pathname)) {
      const person = people.update(parts[2], body)
      if (!person) return json(res, 404, { ok: false, error: 'profile not found' })
      audit('people.updated', `${person.name} (enabled=${person.enabled})`)
      await intelligence.reconcile()
      return json(res, 200, { ok: true, person })
    }
    if (req.method === 'DELETE' && /^\/api\/people\/[^/]+$/.test(url.pathname)) {
      const removed = people.remove(parts[2])
      audit('people.deleted', `${parts[2]} (${removed} references removed)`)
      return json(res, 200, { ok: true, removed: removed })
    }
    if (req.method === 'POST' && /^\/api\/people\/[^/]+\/enroll$/.test(url.pathname)) {
      if (cameraPrivacyBlocked(parts[2]) && body.source === 'camera') {
        return json(res, 403, { ok: false, error: 'This camera is privacy-blocked' })
      }
      let jpeg = null
      let source = String(body.source ?? 'upload')
      try {
        if (body.image) {
          const match = /^data:image\/(jpeg|jpg|png);base64,(.+)$/.exec(body.image)
          if (!match) return json(res, 400, { ok: false, error: 'image must be a base64 data URL (jpeg/png)' })
          jpeg = Buffer.from(match[2], 'base64')
          source = 'upload'
        } else if (body.camera) {
          const driver = driverById.get(String(body.camera))
          if (!driver) return json(res, 404, { ok: false, error: 'camera not found' })
          const snap = await driver.snapshot({ zone: 'enrollment' })
          jpeg = snap.jpeg
          source = 'camera'
        } else {
          return json(res, 400, { ok: false, error: 'provide image (data URL) or camera' })
        }
        const result = await people.enroll(parts[2], jpeg, { source })
        if (result.ok) {
          audit('people.enrolled', `${parts[2]} ref=${result.referenceId} quality=${result.quality?.toFixed(2)} source=${source}`)
          await intelligence.reconcile()
        }
        return json(res, result.ok ? 200 : 422, { ok: result.ok, ...result })
      } catch (error) {
        return json(res, 500, { ok: false, error: maskSecrets(error.message) })
      }
    }
    // ---------- Camera registry (Gate 9) ----------
    if (req.method === 'GET' && url.pathname === '/api/cameras/registry') {
      return json(res, 200, { ok: true, cameras: listCameras() })
    }
    if (req.method === 'POST' && url.pathname === '/api/cameras/registry/probe') {
      try {
        const result = await probeCamera({
          host: String(body.host ?? '').trim(),
          rtspPort: body.rtspPort, onvifPort: body.onvifPort,
          username: String(body.username ?? ''), password: String(body.password ?? ''),
          mainPath: body.mainPath,
        })
        return json(res, 200, { ok: result.ok, probe: summarizeProbe(result) })
      } catch (error) {
        return json(res, 500, { ok: false, error: maskSecrets(error.message) })
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/cameras/registry') {
      const result = await createCamera(body)
      if (result.ok) {
        audit('camera.onboarded', `${result.camera.id} (${result.camera.host})`)
      }
      return json(res, result.ok ? 201 : (result.code ?? 400), { ok: result.ok, ...result })
    }
    if (req.method === 'PATCH' && parts[0] === 'api' && parts[1] === 'cameras' && parts[2] === 'registry' && parts[3]) {
      const result = updateCamera(parts[3], body)
      if (result.ok) {
        audit('camera.registry_updated', `${parts[3]}: ${JSON.stringify({ ...body, password: body.password ? '***' : undefined })}`)
      }
      return json(res, result.ok ? 200 : (result.code ?? 400), { ok: result.ok, ...result })
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'cameras' && parts[2] === 'registry' && parts[3]) {
      const driver = driverById.get(parts[3])
      if (driver) {
        // stop everything the camera is doing before removal
        autoFollow?.get(parts[3]) ? await autoFollow.get(parts[3]).stop() : null
        await stopRecording(parts[3], { reason: 'camera_removed' }).catch(() => { /* not recording */ })
      }
      const result = removeCamera(parts[3])
      if (result.ok) audit('camera.removed', parts[3])
      return json(res, result.ok ? 200 : (result.code ?? 400), { ok: result.ok, ...result })
    }

    // ---------- Semantic search (Gate 4) ----------
    if (req.method === 'GET' && url.pathname === '/api/search') {
      if (!searchIndexer) return json(res, 503, { ok: false, error: 'search not available' })
      const result = await searchEvents(searchIndexer, {
        q: url.searchParams.get('q'),
        cameraId: url.searchParams.get('camera'),
        type: url.searchParams.get('type'),
        personId: url.searchParams.get('person'),
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        limit: Math.min(200, Number(url.searchParams.get('limit') ?? 60)),
      })
      return json(res, result.ok ? 200 : 503, { ok: result.ok, ...result })
    }
    if (req.method === 'GET' && url.pathname === '/api/search/status') {
      if (!searchIndexer) return json(res, 503, { ok: false, error: 'search not available' })
      return json(res, 200, { ok: true, ...searchIndexer.status() })
    }
    if (req.method === 'POST' && url.pathname === '/api/search/reindex') {
      if (!searchIndexer) return json(res, 503, { ok: false, error: 'search not available' })
      const result = await searchIndexer.backfill({ limit: Math.min(2000, Number(body.limit ?? 500)) })
      return json(res, 200, { ok: true, ...result })
    }
    // ---------- AI vision (local VLM, Gate 3) ----------
    if (req.method === 'GET' && url.pathname === '/api/ai/vision') {
      const st = intelligence.status().aiVision
      return json(res, 200, { ok: true, ...st })
    }
    // On-demand scene question: fresh full-frame snapshot → local VLM answer.
    // Evidence (the exact image the answer is grounded in) is stored.
    if (req.method === 'POST' && url.pathname === '/api/ai/ask') {
      const camId = String(body.camera ?? drivers[0]?.id ?? '')
      const driver = driverById.get(camId)
      if (!driver) return json(res, 404, { ok: false, error: 'camera not found' })
      if (cameraPrivacyBlocked(camId)) return json(res, 403, { ok: false, error: 'This camera is privacy-blocked' })
      const question = String(body.question ?? '').slice(0, 500)
      if (!question) return json(res, 400, { ok: false, error: 'question required' })
      try {
        const snap = await driver.snapshot({ zone: 'ai-ask' })
        const result = await intelligence.vlm.submitP({ cameraId: camId, jpeg: snap.jpeg, question, force: true })
        if (!result.ok) return json(res, 503, { ok: false, error: `visual reasoning unavailable: ${result.error}` })
        // evidence + answer persisted (kind distinguishes on-demand answers)
        db.prepare('INSERT INTO event_descriptions (event_id, at, model, text, kind) VALUES (NULL, ?, ?, ?, ?)')
          .run(result.at, result.model, `${question}\n---\n${result.text}`, 'answer')
        return json(res, 200, {
          ok: true,
          question,
          answer: result.text,
          model: result.model,
          ms: result.ms,
          uncertain: result.uncertain,
          evidence: { zone: 'ai-ask', file: snap.file ?? null, at: result.at },
        })
      } catch (error) {
        return json(res, 500, { ok: false, error: maskSecrets(error.message) })
      }
    }
    // Describe an existing event's evidence image on demand.
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'events' && parts[2] && parts[3] === 'describe') {
      const eventId = Number(parts[2])
      const row = db.prepare('SELECT id, thumb_path FROM events WHERE id = ?').get(eventId)
      if (!row) return json(res, 404, { ok: false, error: 'event not found' })
      if (!row.thumb_path || !fs.existsSync(row.thumb_path)) return json(res, 409, { ok: false, error: 'event has no evidence image' })
      const result = await intelligence.vlm.submitP({ cameraId: `event:${eventId}`, jpeg: fs.readFileSync(row.thumb_path), force: true })
      if (!result.ok) return json(res, 503, { ok: false, error: `visual reasoning unavailable: ${result.error}` })
      intelligence._storeEventDescription(eventId, result)
      return json(res, 200, { ok: true, eventId, description: result.text, model: result.model, ms: result.ms, uncertain: result.uncertain })
    }
    // Threshold calibration: embed a probe face and report similarity to
    // every enrolled profile. Read-only; used with People to tune settings.
    if (req.method === 'POST' && url.pathname === '/api/face/score-test') {
      try {
        let jpeg = null
        if (body.image) {
          const match = /^data:image\/(jpeg|jpg|png);base64,(.+)$/.exec(body.image)
          if (!match) return json(res, 400, { ok: false, error: 'image must be a base64 data URL (jpeg/png)' })
          jpeg = Buffer.from(match[2], 'base64')
        } else if (body.camera) {
          const driver = driverById.get(String(body.camera))
          if (!driver) return json(res, 404, { ok: false, error: 'camera not found' })
          jpeg = (await driver.snapshot({ zone: 'score-test' })).jpeg
        } else {
          return json(res, 400, { ok: false, error: 'provide image (data URL) or camera' })
        }
        return json(res, 200, { ok: true, ...(await people.scoreTest(jpeg)) })
      } catch (error) {
        return json(res, 500, { ok: false, error: maskSecrets(error.message) })
      }
    }
    if (req.method === 'DELETE' && /^\/api\/people\/[^/]+\/references\/[^/]+$/.test(url.pathname)) {
      const ok = people.removeReference(parts[2], parts[4])
      audit('people.reference_removed', ok ? `${parts[2]}/${parts[4]}` : `${parts[4]} not found`)
      return ok ? json(res, 200, { ok: true }) : json(res, 404, { ok: false, error: 'reference not found' })
    }
    if (req.method === 'GET' && /^\/api\/people\/reference-image\/[^/]+$/.test(url.pathname)) {
      const imagePath = people.referenceImagePath(parts[3])
      if (!imagePath || !fs.existsSync(imagePath)) return json(res, 404, { ok: false, error: 'not found' })
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' })
      return res.end(fs.readFileSync(imagePath))
    }

    // ---- automation rules (data-driven; extends the built-in automations) ----
    if (req.method === 'GET' && url.pathname === '/api/rules') {
      return json(res, 200, { ok: true, rules: rules.listRules(), sceneFlags: intelligence.automations?.sceneState() ?? {} })
    }
    if (req.method === 'POST' && url.pathname === '/api/rules') {
      if (!body.name || !Array.isArray(body.actions) || body.actions.length === 0) {
        return json(res, 400, { ok: false, error: 'name and at least one action required' })
      }
      return json(res, 201, { ok: true, rule: rules.createRule(body) })
    }
    if (req.method === 'PATCH' && /^\/api\/rules\/[^/]+$/.test(url.pathname)) {
      const rule = rules.updateRule(parts[2], body)
      if (!rule) return json(res, 404, { ok: false, error: 'rule not found' })
      return json(res, 200, { ok: true, rule })
    }
    if (req.method === 'DELETE' && /^\/api\/rules\/[^/]+$/.test(url.pathname)) {
      const ok = rules.deleteRule(parts[2])
      return json(res, ok ? 200 : 404, { ok })
    }
    if (req.method === 'POST' && /^\/api\/rules\/[^/]+\/test$/.test(url.pathname)) {
      const synthetic = body.event ?? {
        type: body.eventType ?? 'person', cameraId: body.cameraId ?? drivers[0]?.id,
        label: body.label ?? 'person', confidence: body.confidence ?? 0.8,
        person: body.person ?? null, at: new Date().toISOString(),
      }
      const results = await intelligence.automations?.evaluate(synthetic, { dryRuleId: parts[2] })
      return json(res, 200, { ok: true, dry: true, matched: (results?.length ?? 0) > 0, results })
    }

    // ---- per-camera ----
    if (parts[0] === 'api' && parts[1] === 'cameras' && parts[2]) {
      const driver = driverById.get(parts[2])
      if (!driver) return json(res, 404, { ok: false, error: 'camera not found' })
      const camId = driver.id
      const rest = parts.slice(3).join('/')

      if (req.method === 'PATCH' && rest === 'settings') {
        const settings = setCameraSettings(camId, body)
        bumpGeneration()   // orientation/privacy affect the adapter's view — Core must see a new generation
        reconcileRecordings?.()   // per-camera recordingEnabled participates in modes
        audit('camera.settings', `${camId}: ${JSON.stringify(body)}`)
        return json(res, 200, { ok: true, settings })
      }
      if (req.method === 'GET' && rest === 'settings') {
        return json(res, 200, { ok: true, settings: getCameraSettings(camId) })
      }
      if (req.method === 'GET' && rest === 'capabilities') {
        return json(res, 200, { ok: true, ...driver.capabilityMatrix() })
      }
      if (req.method === 'GET' && rest === 'status') {
        const position = driver.capabilities.ptz ? await driver.getStatusPosition() : null
        return json(res, 200, { ok: true, camera: camId, position, health: healthMonitor.snapshot(camId), recording: recordingState(camId) })
      }
      if (req.method === 'POST' && rest === 'snapshot') {
        if (cameraPrivacyBlocked(camId)) return json(res, 403, { ok: false, error: 'This camera is privacy-blocked' })
        if (limitSnapshot(req)) return json(res, 429, { ok: false, error: 'too many snapshot requests — wait a moment' })
        const zone = safeZone(body.zone || 'camera')
        const started = Date.now()
        const { jpeg } = await driver.snapshot({ zone })
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
        const finalPath = path.join(config.storage.mediaDir, zone, `${stamp}.jpg`)
        writeJpegAtomic(finalPath, jpeg)
        recordEvent('snapshot', camId, `${zone} in ${Date.now() - started}ms`)
        return json(res, 200, { ok: true, camera: camId, zone, file: finalPath, bytes: jpeg.length, ms: Date.now() - started })
      }
      if (req.method === 'GET' && rest === 'stream.mjpeg') {
        // auth: session cookie OR short-lived grant (shareable, self-expiring)
        const grant = url.searchParams.get('grant')
        const cookieAuth = parseCookieHeader(req.headers.cookie)?.[COOKIE]
        if (!grantValid(grant, camId) && !sessionValid(cookieAuth)) {
          return json(res, 401, { ok: false, error: 'unauthorized' })
        }
        if (cameraPrivacyBlocked(camId)) return json(res, 403, { ok: false, error: 'This camera is privacy-blocked' })
        const clientKey = req.socket.remoteAddress ?? 'unknown'
        const open = liveStreamsPerClient.get(clientKey) ?? 0
        if (open >= MAX_STREAMS_PER_CLIENT) {
          return json(res, 429, { ok: false, error: 'too many concurrent streams for this client' })
        }
        const quality = url.searchParams.get('q') === 'main' ? 'main' : 'sub'
        return serveLiveStream(driver, req, res, { quality, onOpen: () => {
          liveStreamsPerClient.set(clientKey, (liveStreamsPerClient.get(clientKey) ?? 0) + 1)
        }, onClose: () => {
          const now = Math.max(0, (liveStreamsPerClient.get(clientKey) ?? 1) - 1)
          if (now === 0) liveStreamsPerClient.delete(clientKey)
          else liveStreamsPerClient.set(clientKey, now)
        } })
      }
      if (req.method === 'GET' && rest === 'stream.fmp4') {
        // Modern low-latency path: H.264 → fragmented MP4 for MSE playback.
        // Same authorization model as stream.mjpeg (session or grant).
        const grant = url.searchParams.get('grant')
        const cookieAuth = parseCookieHeader(req.headers.cookie)?.[COOKIE]
        if (!grantValid(grant, camId) && !sessionValid(cookieAuth)) {
          return json(res, 401, { ok: false, error: 'unauthorized' })
        }
        if (cameraPrivacyBlocked(camId)) return json(res, 403, { ok: false, error: 'This camera is privacy-blocked' })
        const clientKey = req.socket.remoteAddress ?? 'unknown'
        const open = liveStreamsPerClient.get(clientKey) ?? 0
        if (open >= MAX_STREAMS_PER_CLIENT) {
          return json(res, 429, { ok: false, error: 'too many concurrent streams for this client' })
        }
        const fmp4Quality = url.searchParams.get('q') === 'main' ? 'main' : 'sub'
        return serveFmp4Stream(driver, req, res, { quality: fmp4Quality,
          onOpen: () => liveStreamsPerClient.set(clientKey, (liveStreamsPerClient.get(clientKey) ?? 0) + 1),
          onClose: () => {
            const now = Math.max(0, (liveStreamsPerClient.get(clientKey) ?? 1) - 1)
            if (now === 0) liveStreamsPerClient.delete(clientKey)
            else liveStreamsPerClient.set(clientKey, now)
          },
        })
      }
      if (req.method === 'GET' && rest === 'audio.wav') {
        const settings = getProductSettings()
        if (!settings.privacy.microphoneEnabled) {
          return json(res, 403, { ok: false, error: 'Microphone is disabled in Privacy settings' })
        }
        if (cameraPrivacyBlocked(camId)) return json(res, 403, { ok: false, error: 'This camera is privacy-blocked' })
        return serveAudio(driver, req, res)
      }
      // ---------- PTZ auto-follow (Gate 5) ----------
      if (req.method === 'POST' && rest === 'follow') {
        if (cameraPrivacyBlocked(camId)) return json(res, 403, { ok: false, error: 'This camera is privacy-blocked' })
        if (!autoFollow) return json(res, 503, { ok: false, error: 'auto-follow unavailable' })
        const controller = autoFollow.forCamera(driver, () => {
          const ctx = intelligence.runtimes.get(camId)
          return ctx?.person?.tracker ?? null
        })
        const result = controller.start({ trackId: body.trackId, x: body.x, y: body.y })
        return json(res, result.ok ? 200 : (result.code ?? 400), { ok: result.ok, ...result })
      }
      if (req.method === 'GET' && rest === 'follow') {
        const controller = autoFollow?.get(camId)
        return json(res, 200, { ok: true, follow: controller ? controller.status() : { cameraId: camId, state: 'idle' } })
      }
      if (req.method === 'POST' && rest === 'follow/stop') {
        if (!autoFollow) return json(res, 503, { ok: false, error: 'auto-follow unavailable' })
        const controller = autoFollow.get(camId)
        const result = await controller?.stop({ moveHome: Boolean(body.returnHome) }) ?? { ok: true, was: 'idle' }
        return json(res, 200, { ok: true, ...result })
      }
      if (req.method === 'POST' && rest === 'ptz') {
        if (cameraPrivacyBlocked(camId)) return json(res, 403, { ok: false, error: 'This camera is privacy-blocked' })
        const command = String(body.command ?? '')
        if (!commandNames().includes(command)) return json(res, 400, { ok: false, error: 'unsupported PTZ command' })
        // Remap from screen space to physical camera space using orientation
        const orientation = getCameraSettings(camId) ?? { rotate: 0, mirror: false, flip: false }
        const physical = mapPtzCommand(command, orientation)
        autoFollow?.handleManualCommand(camId)   // manual wins over auto-follow
        const result = await withPtzLock('api', async () => {
          if (physical === 'stop') await driver.ptzStop()
          else {
            await driver.ptzMove(physical)
            signalBus.emit('camera.moved', { cameraId: camId })
          }
          return { ok: true, command, physical }
        })
        recordEvent('ptz', camId, `${command} → ${physical}`)
        return json(res, 200, result)
      }
      if (req.method === 'GET' && rest === 'presets') {
        return json(res, 200, { ok: true, presets: listPresets(camId) })
      }
      if (req.method === 'POST' && rest === 'presets') {
        if (cameraPrivacyBlocked(camId)) return json(res, 403, { ok: false, error: 'This camera is privacy-blocked' })
        const position = await driver.getStatusPosition()
        const preset = createPreset(camId, body, position)
        audit('preset.created', `${camId}: ${preset.name} (from current position, no movement)`)
        return json(res, 201, { ok: true, preset })
      }
      if (req.method === 'PATCH' && parts[4] && !parts[5]) {
        const useCurrent = Boolean(body.updatePosition)
        if (useCurrent && cameraPrivacyBlocked(camId)) return json(res, 403, { ok: false, error: 'This camera is privacy-blocked' })
        const position = useCurrent ? await driver.getStatusPosition() : null
        const preset = updatePreset(parts[4], body, position)
        audit('preset.updated', `${camId}: ${preset.name}`)
        return json(res, 200, { ok: true, preset })
      }
      if (req.method === 'DELETE' && parts[4] && !parts[5]) {
        const preset = deletePreset(parts[4])
        audit('preset.deleted', `${camId}: ${preset.name}`)
        return json(res, 200, { ok: true, preset })
      }
      if (req.method === 'POST' && parts[4] && parts[5] === 'goto') {
        if (cameraPrivacyBlocked(camId)) return json(res, 403, { ok: false, error: 'This camera is privacy-blocked' })
        const preset = getPreset(parts[4])
        if (!preset) return json(res, 404, { ok: false, error: 'preset not found' })
        autoFollow?.handleManualCommand(camId)   // preset goto wins over auto-follow
        const result = await withPtzLock('api', async () => {
          await driver.gotoPosition({ pan: preset.pan, tilt: preset.tilt, zoom: preset.zoom })
          signalBus.emit('camera.moved', { cameraId: camId })
          return { ok: true, preset: preset.name }
        })
        recordEvent('preset.goto', camId, preset.name)
        return json(res, 200, result)
      }
      if (req.method === 'GET' && rest === 'media') {
        return json(res, 200, { ok: true, items: listMedia({ cameraId: camId, zone: url.searchParams.get('zone'), limit: Math.min(500, Number(url.searchParams.get('limit') ?? 100)) }) })
      }
      if (req.method === 'GET' && rest === 'zones') {
        return json(res, 200, { ok: true, zones: mediaZones(camId) })
      }
      if (req.method === 'GET' && rest === 'zone') {
        return json(res, 200, { ok: true, zone: getCameraZone(camId) })
      }
      if (req.method === 'PUT' && rest === 'zone') {
        const zone = setCameraZone(camId, body.zone ?? body)
        audit('camera.zone', `${camId}: ${zone ? `${zone.points.length}-point detection zone` : 'zone cleared'}`)
        await intelligence.reconcile()
        return json(res, 200, { ok: true, zone })
      }
    }

    // ---- media files ----
    if (req.method === 'GET' && parts[0] === 'media') {
      return serveMedia(url.pathname.slice('/media/'.length), res)
    }

    return json(res, 404, { ok: false, error: 'not found' })
  }

  // ---------- auth ----------

  function authenticate(req) {
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null
    if (bearer) {
      const a = Buffer.from(bearer)
      const b = Buffer.from(config.server.apiToken)
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { kind: 'token', id: null }
      return null
    }
    const cookie = parseCookieHeader(req.headers.cookie)?.[COOKIE]
    if (cookie && sessionValid(cookie)) return { kind: 'session', id: cookie }
    return null
  }

  async function handleLogin(req, res) {
    const ip = req.socket.remoteAddress ?? 'unknown'
    const body = await readJson(req)
    const given = String(body.token ?? '')
    const a = Buffer.from(given)
    const b = Buffer.from(config.server.apiToken)
    const valid = given && a.length === b.length && crypto.timingSafeEqual(a, b)
    if (!valid) {
      // only FAILED attempts count toward the limiter — a caller holding the
      // correct token is already authenticated; failures are brute force
      const state = loginAttempts.get(ip) ?? { count: 0, resetAt: 0 }
      if (Date.now() > state.resetAt) {
        state.count = 0
        state.resetAt = Date.now() + LOGIN_WINDOW_MS
      }
      state.count += 1
      loginAttempts.set(ip, state)
      if (state.count > LOGIN_LIMIT) {
        audit('login.rate_limited', ip)
        return json(res, 429, { ok: false, error: 'too many attempts, try later' })
      }
      audit('login.failed', ip)
      return json(res, 401, { ok: false, error: 'invalid token' })
    }
    const sessionId = createSession(String(body.label ?? 'panel').slice(0, 40))
    audit('login.ok', ip)
    res.setHeader('Set-Cookie', `${COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`)
    return json(res, 200, { ok: true })
  }

  // ---------- streaming ----------

  /**
   * Modern live path: shared fMP4 session (copy, no re-encode) teed to
   * viewers — late viewers join instantly at the next fragment boundary.
   * Orientation is applied by the client (CSS transform). Cleanup is
   * deterministic on disconnect.
   */
  async function serveFmp4Stream(driver, req, res, { quality = 'sub', onOpen = () => {}, onClose = () => {} } = {}) {
    let live
    try {
      live = await driver.fmp4Stream({ quality })
    } catch (error) {
      return json(res, error.code ?? 502, { ok: false, error: `live stream unavailable: ${maskSecrets(error.message)}` })
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-HUGO-Transport': live.transport,
    })
    let closed = false
    const stopAll = () => {
      if (closed) return
      closed = true
      onClose()
      live.stop()
      try { res.end() } catch { /* closed */ }
    }
    live.stream.on('data', chunk => {
      if (closed) return
      try { res.write(chunk) } catch { stopAll() }
    })
    live.stream.on('end', stopAll)
    live.stream.on('error', stopAll)
    req.on('close', stopAll)
    req.socket.once('close', stopAll)
    res.on('close', stopAll)
    onOpen()
  }

  async function serveLiveStream(driver, req, res, { quality = 'sub', onOpen = () => {}, onClose = () => {} } = {}) {
    let live
    try {
      live = await driver.liveStream({ quality })
    } catch (error) {
      return json(res, error.code ?? 502, { ok: false, error: `live stream unavailable: ${maskSecrets(error.message)}` })
    }
    res.writeHead(200, {
      'Content-Type': live.contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'X-HUGO-Transport': live.transport ?? 'mjpeg',
    })
    let closed = false
    const stopAll = () => {
      if (closed) return
      closed = true
      onClose()
      live.stop()
      try { res.end() } catch { /* closed */ }
    }
    live.stream.on('data', chunk => {
      if (closed) return
      try { res.write(chunk) } catch { stopAll() }
    })
    live.stream.on('end', stopAll)
    live.stream.on('error', stopAll)
    req.on('close', stopAll)
    req.socket.once('close', stopAll)
    res.on('close', stopAll)
    onOpen()
  }

  async function serveAudio(driver, req, res) {
    let audio
    try {
      audio = await driver.audioStream()
    } catch (error) {
      return json(res, 502, { ok: false, error: `audio unavailable: ${maskSecrets(error.message)}` })
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' })
    let closed = false
    const stopAll = () => {
      if (closed) return
      closed = true
      audio.stop()
      try { res.end() } catch { /* closed */ }
    }
    audio.stream.on('data', chunk => {
      if (closed) return
      try { res.write(chunk) } catch { stopAll() }
    })
    audio.stream.on('end', stopAll)
    audio.stream.on('error', stopAll)
    req.on('close', stopAll)
    req.socket.once('close', stopAll)
    res.on('close', stopAll)
  }

  function serveStatic(pathname, res) {
    let rel = pathname === '/' ? '/index.html' : pathname
    let file = path.join(UI_DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''))
    if (!file.startsWith(UI_DIST)) file = path.join(UI_DIST, 'index.html')
    let data = null
    try {
      data = fs.readFileSync(file)
    } catch {
      // SPA fallback
      try { data = fs.readFileSync(path.join(UI_DIST, 'index.html')) } catch { data = null }
    }
    if (!data) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end('<!doctype html><html><head><title>HUGO Eye</title></head><body style="font-family:sans-serif;background:#0a0f1c;color:#e8ecf8;display:grid;place-items:center;height:100vh;margin:0"><div><h1>HUGO Eye</h1><p>UI build not found. Run <code>npm run build</code> in <code>ui/</code>.</p></div></body></html>')
    }
    const ext = path.extname(file)
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    })
    res.end(data)
  }

  function serveMedia(relative, res) {
    let filePath
    try {
      filePath = resolveMediaPath(relative)
    } catch {
      return json(res, 400, { ok: false, error: 'invalid media path' })
    }
    let stat
    try {
      stat = fs.statSync(filePath)
    } catch {
      return json(res, 404, { ok: false, error: 'media not found' })
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=60' })
    fs.createReadStream(filePath).pipe(res)
  }

  // periodic quota enforcement
  setInterval(() => {
    enforceQuotaAndRetention().catch(error => log.warn(`quota pass failed: ${error.message}`))
  }, 10 * 60 * 1000).unref()

  return server
}

function readJson(req) {
  return new Promise(resolve => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      // 8 MB: face-enrollment uploads are base64 images; this is a LAN appliance
      if (size > 8 * 1024 * 1024) {
        resolve({})
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}
