import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { config } from './config.js'
import { db, newId } from './db.js'
import { log } from './log.js'
import { getProductSettings, cameraPrivacyBlocked } from './settings.js'
import { getHub } from './camera/hub.js'
import { startPipeRecording } from './camera/ffmpeg.js'
import { audit } from './security.js'
import { publishEvent } from './eventbus.js'

/**
 * Recording subsystem. Privacy-gated (recordingEnabled + per-camera switch),
 * segmented 60 s MP4s (crash-safe finalize), quota + retention enforcement,
 * disk-full protection, optional pre-event buffer (GOP-seeded by the hub).
 */

const active = new Map() // cameraId -> {handle, transcoder, groupId, dir, startedAt, trigger}

export function recordingState(cameraId) {
  const rec = active.get(cameraId)
  return {
    recording: Boolean(rec),
    groupId: rec?.groupId ?? null,
    startedAt: rec?.startedAt ?? null,
    trigger: rec?.trigger ?? null,
  }
}

export function activeRecordings() {
  return [...active.keys()]
}

export async function startRecording(driver, { trigger = 'manual' } = {}) {
  const settings = getProductSettings()
  if (!settings.privacy.recordingEnabled) {
    return { ok: false, code: 403, error: 'Recording is disabled in Privacy settings' }
  }
  if (cameraPrivacyBlocked(driver.id)) {
    return { ok: false, code: 403, error: 'This camera is privacy-blocked' }
  }
  const { getCameraSettings } = await import('./settings.js')
  if (getCameraSettings(driver.id)?.recordingEnabled === false) {
    return { ok: false, code: 403, error: 'Recording is disabled for this camera' }
  }
  if (active.has(driver.id)) {
    return { ok: false, code: 409, error: 'Camera is already recording' }
  }
  const free = freeDiskBytes()
  if (free < settings.storage.minFreeGb * 1024 ** 3) {
    publishEvent('storage.low_disk', driver.id, `${Math.round(free / 1024 ** 3)} GB free — recording refused`)
    return { ok: false, code: 507, error: `Insufficient disk space (${Math.round(free / 1024 ** 3)} GB free)` }
  }

  const groupId = newId()
  const startedAt = new Date()
  const dir = path.join(config.storage.mediaDir, 'recordings', driver.id, startedAt.toISOString().replace(/[:T]/g, '-').slice(0, 19))
  fs.mkdirSync(dir, { recursive: true })
  const withAudio = settings.privacy.microphoneEnabled
  // pre-event GOP seeding applies to every automated trigger (motion, person, object)
  const preBufferGops = trigger !== 'manual' ? Math.max(0, Math.round(settings.motion.preBufferGops ?? 0)) : 0

  const hub = getHub(driver.cam, driver.cam.subPath)
  let stoppedForError = false
  let handle
  try {
    handle = await hub.subscribe({
      kind: 'record',
      audio: withAudio,
      preBufferGops,
      onOverflow: () => { stopRecording(driver.id, { reason: 'backpressure_overflow' }).catch(() => {}) },
    })
  } catch (error) {
    return { ok: false, code: 502, error: `camera stream unavailable: ${error.message}` }
  }
  if (withAudio && !handle.hasAudio) {
    log.info(`recording ${groupId}: camera exposes no audio track — recording video only`)
  }
  const useAudio = withAudio && handle.hasAudio

  const transcoder = startPipeRecording({
    streamFps: Math.max(5, Math.round(hub.fps ?? 15)),
    outPattern: path.join(dir, 'seg-%Y-%m-%d_%H-%M-%S.ts'),
    segmentSeconds: 60,
    filters: driver.orientationFilters(),
    withAudio: useAudio,
    onError: error => {
      if (stoppedForError) return
      stoppedForError = true
      log.warn(`recording ${groupId}: ${error.message}`)
      stopRecording(driver.id, { reason: 'transcoder_error' }).catch(() => {})
    },
  })
  handle.attach({ video: transcoder.videoInput, audio: useAudio ? transcoder.audioInput : null })

  // Health probe: the transcoder must survive its first 3 s (stdin wiring).
  const healthy = await new Promise(resolve => {
    let settled = false
    transcoder.on('close', () => { if (!settled) { settled = true; resolve(false) } })
    setTimeout(() => { if (!settled) { settled = true; resolve(true) } }, 3000)
  })
  if (!healthy || stoppedForError) {
    transcoder.stop()
    handle.detach()
    return { ok: false, code: 502, error: 'recording transcoder failed to start' }
  }

  active.set(driver.id, { cameraId: driver.id, handle, transcoder, groupId, dir, startedAt, trigger, withAudio: useAudio })
  audit('recording.start', `${driver.id} group=${groupId} trigger=${trigger} audio=${useAudio}${preBufferGops ? ` prebuffer=${preBufferGops}gop` : ''}`)
  publishEvent('recording.started', driver.id, `trigger=${trigger}`, { correlationId: groupId })
  log.info(`recording started: ${driver.id} group=${groupId} (audio=${useAudio}${preBufferGops ? ', pre-event GOPs' : ''})`)
  return { ok: true, groupId, startedAt: startedAt.toISOString(), audio: useAudio }
}

/**
 * Stops a recording deterministically: ends the hub pipe (clean ffmpeg EOF),
 * waits for the transcoder to finalize the last segment, remuxes everything
 * to MP4 and registers the segments.
 */
export async function stopRecording(cameraId, { reason = 'manual' } = {}) {
  const rec = active.get(cameraId)
  if (!rec) return { ok: false, code: 404, error: 'Camera is not recording' }
  active.delete(cameraId)
  rec.handle.detach()               // ends stdin pipes → ffmpeg flushes and exits
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 8000)
    rec.transcoder.once('close', () => { clearTimeout(timer); resolve() })
  })
  const endedAt = new Date()
  await remuxSegments(rec.dir)
  registerSegments(rec, endedAt, reason)
  // integrity + thumbnails: verify each registered segment; a segment that
  // fails ffprobe is marked corrupt (honest status) and cleaned by retention
  try {
    const segs = db.prepare('SELECT id, path FROM recordings WHERE group_id = ?').all(rec.groupId)
    for (const seg of segs) {
      const health = await probeSegment(seg.path)
      if (!health.ok) {
        db.prepare(`UPDATE recordings SET status = 'corrupt' WHERE id = ?`).run(seg.id)
        log.warn(`recordings: segment failed integrity check: ${seg.path}`)
      }
    }
    generateGroupThumbnails(rec.groupId)
  } catch (error) {
    log.warn(`recordings: post-stop verification failed: ${error.message}`)
  }
  audit('recording.stop', `${cameraId} group=${rec.groupId} reason=${reason}`)
  publishEvent('recording.stopped', cameraId, `group=${rec.groupId} reason=${reason}`, { correlationId: rec.groupId })
  log.info(`recording stopped: ${cameraId} group=${rec.groupId} (${reason})`)
  enforceQuotaAndRetention()
  return { ok: true, groupId: rec.groupId }
}

/** Remuxes every .ts segment in the dir to a finalized .mp4 (idempotent). */
export async function remuxSegments(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts')).sort()
  for (const file of files) {
    const tsPath = path.join(dir, file)
    const mp4Path = tsPath.replace(/\.ts$/, '.mp4')
    if (fs.existsSync(mp4Path)) { try { fs.unlinkSync(tsPath) } catch { /* */ } continue }
    await new Promise(resolve => {
      const child = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', tsPath, '-c', 'copy', '-movflags', '+faststart', mp4Path,
      ], { stdio: ['ignore', 'ignore', 'ignore'] })
      child.on('close', resolve)
      child.on('error', resolve)
      setTimeout(resolve, 30000)
    })
    try { fs.unlinkSync(tsPath) } catch { /* */ }
  }
}

const SEG_NAME_RE = /^seg-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.mp4$/

export function registerSegments(rec, endedAt, reason) {
  let files = []
  try { files = fs.readdirSync(rec.dir).filter(f => f.endsWith('.mp4')).sort() } catch { return }
  // Real segment start times come from the strftime filenames; duration is
  // the gap to the next segment (last one: until stop).
  const starts = files.map(file => {
    const m = file.match(SEG_NAME_RE)
    return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).getTime() : null
  })
  files.forEach((file, index) => {
    const full = path.join(rec.dir, file)
    let size = 0
    try { size = fs.statSync(full).size } catch { return }
    // NOTE: no trailing-partial deletion here — stopRecording ends the pipes
    // cleanly, so even a short final segment is complete, finalized footage.
    // Crash artifacts take the orphan-sweep path, which validates by remux.
    const segStart = starts[index] ?? rec.startedAt.getTime()
    const nextStart = starts[index + 1]
    const segEnd = nextStart ?? endedAt.getTime()
    const durationS = Math.max(0, Math.round((segEnd - segStart) / 100) / 10)
    db.prepare(`INSERT INTO recordings (id, group_id, camera_id, path, started_at, ended_at, duration_s, size_bytes, trigger, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
        ON CONFLICT(path) DO NOTHING`)
      .run(newId(), rec.groupId, rec.cameraId, full,
        new Date(segStart).toISOString(), new Date(segEnd).toISOString(), durationS, size,
        index === 0 ? rec.trigger : 'segment')
  })
}

/** Extract a mid-clip JPEG thumbnail for a recording (best-effort). */
export async function extractRecordingThumbnail(recordingId) {
  const row = db.prepare('SELECT id, path, duration_s FROM recordings WHERE id = ?').get(recordingId)
  if (!row || !fs.existsSync(row.path)) return null
  const probe = await probeSegment(row.path)
  const at = Math.max(0.5, Math.min((probe.duration ?? row.duration_s ?? 4) * 0.35, 30))
  const thumbPath = row.path.replace(/\.mp4$/, '.jpg')
  const ok = await new Promise(resolve => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(at), '-i', row.path, '-frames:v', '1', '-q:v', '5', thumbPath],
      { stdio: ['ignore', 'ignore', 'ignore'] })
    child.on('close', code => resolve(code === 0))
    child.on('error', () => resolve(false))
    setTimeout(() => resolve(false), 15_000)
  })
  if (!ok || !fs.existsSync(thumbPath) || fs.statSync(thumbPath).size < 1024) {
    try { fs.unlinkSync(thumbPath) } catch { /* */ }
    return null
  }
  db.prepare('UPDATE recordings SET thumb_path = ? WHERE id = ?').run(thumbPath, recordingId)
  return thumbPath
}

/** ffprobe health check: duration readable and non-zero. */
export function probeSegment(filePath) {
  return new Promise(resolve => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
      { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', c => { out += c.toString() })
    child.on('error', () => resolve({ ok: false, duration: null }))
    child.on('close', code => {
      const duration = Number(out.trim())
      resolve({ ok: code === 0 && Number.isFinite(duration) && duration > 0.2, duration: Number.isFinite(duration) ? duration : null })
    })
    setTimeout(() => resolve({ ok: false, duration: null }), 15_000)
  })
}

/** Thumbnails for the first segments of a finished group (fire-and-forget). */
export function generateGroupThumbnails(groupId) {
  const rows = db.prepare(`SELECT id, trigger FROM recordings WHERE group_id = ? ORDER BY started_at ASC LIMIT 1`).all(groupId)
  for (const row of rows) {
    extractRecordingThumbnail(row.id).catch(() => {})
  }
}

export async function stopAllRecordings(reason = 'shutdown') {
  for (const [cameraId] of active) {
    try { await stopRecording(cameraId, { reason }) } catch { /* best effort */ }
  }
}

// ---------- recording modes (Gate 7) ----------

/**
 * Reconcile the configured recording mode with reality.
 * mode 'continuous': every eligible camera records around the clock
 *   (segments roll; retention/quota bound storage). Survives camera
 *   recovery — the hub resyncs and the recorder keeps flowing.
 * mode 'events' (default): only manual + event-triggered recordings.
 * mode 'off': stop everything not manually started? — no: 'off' stops all.
 */
export async function reconcileRecordingModes(drivers, cameraPrivacyBlocked) {
  const settings = getProductSettings()
  const mode = settings.recording?.mode ?? 'events'
  for (const driver of drivers) {
    const recording = active.get(driver.id)
    if (mode === 'continuous' && settings.privacy.recordingEnabled && !cameraPrivacyBlocked(driver.id)) {
      if (!recording) {
        const result = await startRecording(driver, { trigger: 'continuous' }).catch(error => ({ ok: false, error: error.message }))
        if (!result.ok) log.warn(`continuous recording (${driver.id}) not started: ${result.error}`)
      }
    } else if (recording && recording.trigger === 'continuous') {
      await stopRecording(driver.id, { reason: `mode_${mode}` }).catch(() => {})
    }
  }
}

// event-triggered recordings with rolling post-event extension:
const eventStops = new Map()   // cameraId → timeout

/**
 * Automation path: start (or keep) an event recording, auto-stopping after
 * `postEventSec` of quiet — every new qualifying event extends the window,
 * bounded by maxSec so a busy scene cannot record forever.
 */
export async function startEventRecording(driver, { trigger, postEventSec = 10, maxSec = 300, preBufferGops = 0 } = {}) {
  const existing = active.get(driver.id)
  if (!existing) {
    const result = await startRecording(driver, { trigger, preBufferGops })
    if (!result.ok) return result
  }
  clearTimeout(eventStops.get(driver.id))
  const startedAt = active.get(driver.id)?.startedAt?.getTime() ?? Date.now()
  const remainingCap = maxSec * 1000 - (Date.now() - startedAt)
  const wait = Math.min(postEventSec * 1000, Math.max(0, remainingCap))
  eventStops.set(driver.id, setTimeout(() => {
    eventStops.delete(driver.id)
    const rec = active.get(driver.id)
    if (rec && rec.trigger === trigger) {
      stopRecording(driver.id, { reason: 'event_quiet' }).catch(() => {})
    }
  }, wait))
  return { ok: true, groupId: active.get(driver.id)?.groupId, extended: Boolean(existing) }
}

/** Re-arm the quiet-stop timer on a rolling event recording (no-op if none). */
export function extendEventRecording(cameraId, { postEventSec = 10, maxSec = 300 } = {}) {
  const rec = active.get(cameraId)
  if (!rec || rec.trigger === 'manual' || rec.trigger === 'continuous') return { ok: false }
  clearTimeout(eventStops.get(cameraId))
  const remainingCap = maxSec * 1000 - (Date.now() - rec.startedAt.getTime())
  if (remainingCap <= 0) {
    eventStops.set(cameraId, setTimeout(() => {
      eventStops.delete(cameraId)
      stopRecording(cameraId, { reason: 'event_cap' }).catch(() => {})
    }, 0))
    return { ok: true, capped: true }
  }
  eventStops.set(cameraId, setTimeout(() => {
    eventStops.delete(cameraId)
    stopRecording(cameraId, { reason: 'event_quiet' }).catch(() => {})
  }, Math.min(postEventSec * 1000, remainingCap)))
  return { ok: true }
}

export function cancelEventRecording(cameraId, { reason = 'cancelled' } = {}) {
  clearTimeout(eventStops.get(cameraId))
  eventStops.delete(cameraId)
  const rec = active.get(cameraId)
  if (rec && rec.trigger !== 'manual' && rec.trigger !== 'continuous') {
    return stopRecording(cameraId, { reason })
  }
  return Promise.resolve({ ok: false, code: 404, error: 'no event recording' })
}

// ---------- quota / retention / disk ----------

export function storageStats() {
  const settings = getProductSettings()
  const rows = db.prepare(`SELECT count(*) AS n, coalesce(sum(size_bytes),0) AS bytes FROM recordings`).get()
  const snapshots = dirSize(config.storage.mediaDir, ['recordings'])
  const usedBytes = Number(rows.bytes) + snapshots
  return {
    recordingSegments: rows.n,
    recordingBytes: Number(rows.bytes),
    snapshotBytes: snapshots,
    totalBytes: usedBytes,
    maxBytes: settings.storage.maxStorageGb * 1024 ** 3,
    retentionDays: settings.storage.retentionDays,
    minFreeGb: settings.storage.minFreeGb,
    freeBytes: freeDiskBytes(),
  }
}

export async function enforceQuotaAndRetention() {
  const settings = getProductSettings()
  let freed = await sweepOrphanRecordings()

  // retention by age — per-camera override (camera_settings.retention_days)
  // wins over the global default; NULL = use global
  const overrides = new Map(db.prepare(`SELECT camera_id, retention_days FROM camera_settings WHERE retention_days IS NOT NULL`).all()
    .map(r => [r.camera_id, r.retention_days]))
  const rows = db.prepare(`SELECT DISTINCT camera_id FROM recordings`).all()
  for (const { camera_id } of rows) {
    const days = overrides.get(camera_id) ?? settings.storage.retentionDays
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString()
    for (const row of db.prepare('SELECT id, path FROM recordings WHERE camera_id = ? AND started_at < ? ORDER BY started_at ASC').all(camera_id, cutoff)) {
      freed += deleteSegment(row.id, row.path)
    }
  }
  // quota by size
  for (;;) {
    const { bytes } = db.prepare(`SELECT coalesce(sum(size_bytes),0) AS bytes FROM recordings`).get()
    if (Number(bytes) <= settings.storage.maxStorageGb * 1024 ** 3) break
    const oldest = db.prepare(`SELECT id, path, size_bytes FROM recordings ORDER BY started_at ASC LIMIT 1`).get()
    if (!oldest) break
    freed += deleteSegment(oldest.id, oldest.path)
  }
  // bounded event history (events + their thumbnails)
  pruneEvents(settings.storage.eventRetentionDays ?? 30)
  if (freed > 0) log.info(`retention/quota freed ${(freed / 1024 ** 2).toFixed(1)} MB`)
  return freed
}

/** Deletes events (and thumbnail files) older than the retention window. */
export function pruneEvents(days) {
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString()
  const rows = db.prepare(`SELECT id, thumb_path FROM events WHERE at < ?`).all(cutoff)
  let removedThumbs = 0
  for (const row of rows) {
    if (row.thumb_path) {
      try { fs.unlinkSync(row.thumb_path); removedThumbs += 1 } catch { /* gone */ }
    }
  }
  db.prepare(`DELETE FROM events WHERE at < ?`).run(cutoff)
  if (rows.length > 0) log.info(`event retention: pruned ${rows.length} events (${removedThumbs} thumbnails)`)
  return rows.length
}

/**
 * Crash-recovery + cleanup pass:
 *  - .ts orphans (not in registry) older than 10 min are remuxed and
 *    registered — a crash between segment close and registration must not
 *    lose complete footage; genuinely partial files fail the remux and are
 *    removed.
 *  - .mp4 orphans older than 10 min are registered (writer crashed before
 *    the registry insert).
 *  - Files newer than 10 min are left alone (a live writer may own them).
 */
function sweepOrphanRecordings() {
  const root = path.join(config.storage.mediaDir, 'recordings')
  const cutoff = Date.now() - 10 * 60 * 1000
  let recovered = 0
  const known = new Set(db.prepare('SELECT path FROM recordings').all().map(r => r.path))
  const walk = dir => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (known.has(full)) continue
      if (!e.name.endsWith('.mp4') && !e.name.endsWith('.ts')) continue
      let mtime = 0
      try { mtime = fs.statSync(full).mtimeMs } catch { continue }
      if (mtime > cutoff) continue
      recovered += recoverOrphanFile(dir, full)
    }
  }
  try { walk(root) } catch { /* missing */ }
  return recovered
}

async function recoverOrphanFile(dir, full) {
  if (full.endsWith('.ts')) {
    const mp4Path = full.replace(/\.ts$/, '.mp4')
    const ok = await new Promise(resolve => {
      const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-i', full, '-c', 'copy', '-movflags', '+faststart', mp4Path],
        { stdio: ['ignore', 'ignore', 'ignore'] })
      child.on('close', code => resolve(code === 0))
      child.on('error', () => resolve(false))
      setTimeout(() => resolve(false), 30_000)
    })
    try { fs.unlinkSync(full) } catch { /* gone */ }
    if (!ok) return 0
    return registerOrphanMp4(dir, mp4Path)
  }
  return registerOrphanMp4(dir, full)
}

function registerOrphanMp4(dir, mp4Path) {
  let size = 0
  try { size = fs.statSync(mp4Path).size } catch { return 0 }
  if (size < 1024) { try { fs.unlinkSync(mp4Path) } catch { /* gone */ } return 0 }
  const cameraId = path.basename(path.dirname(dir))
  const m = path.basename(mp4Path).match(SEG_NAME_RE)
  const startedAt = m
    ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).toISOString()
    : new Date().toISOString()
  db.prepare(`INSERT INTO recordings (id, group_id, camera_id, path, started_at, ended_at, duration_s, size_bytes, trigger, status)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 'recovered', 'ready')
      ON CONFLICT(path) DO NOTHING`)
    .run(newId(), path.basename(dir), cameraId, mp4Path, startedAt, size)
  log.info(`recordings: recovered crash orphan ${mp4Path} (${(size / 1024 / 1024).toFixed(1)} MB)`)
  return size
}

function deleteSegment(id, filePath) {
  try {
    const size = Number(db.prepare('SELECT size_bytes FROM recordings WHERE id = ?').get(id)?.size_bytes ?? 0)
    fs.unlinkSync(filePath)
    db.prepare('DELETE FROM recordings WHERE id = ?').run(id)
    return size
  } catch {
    db.prepare('DELETE FROM recordings WHERE id = ?').run(id)
    return 0
  }
}

export function freeDiskBytes() {
  try {
    const s = fs.statfsSync(config.storage.mediaDir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

export function deleteRecordingGroup(groupId) {
  const rows = db.prepare('SELECT id, path FROM recordings WHERE group_id = ?').all(groupId)
  for (const row of rows) {
    try { fs.unlinkSync(row.path) } catch { /* already gone */ }
    db.prepare('DELETE FROM recordings WHERE id = ?').run(row.id)
  }
  // clean empty dirs
  if (rows[0]) {
    const dir = path.dirname(rows[0].path)
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir) } catch { /* not empty */ }
  }
  audit('recording.delete_group', `${groupId} (${rows.length} segments)`)
  return rows.length
}

// ---------- helpers ----------

function dirSize(root, exclude = []) {
  let total = 0
  const walk = dir => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (exclude.includes(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) { try { total += fs.statSync(full).size } catch { /* raced */ } }
    }
  }
  walk(root)
  return total
}
