import { db, slugify as dbSlugify, uniqueSlug, newId } from './db.js'

/**
 * Camera presets: saved PTZ positions with optional timelapse schedules.
 * Schedule model (ported from the proven RediON logic):
 *   - interval mode: capture every `timelapse_every_min` minutes, offset-anchored
 *     to `timelapse_at` (HH:MM) or, failing that, spaced across the group.
 *   - daily mode: `timelapse_every_min` = NULL + `timelapse_at` HH:MM = once per day.
 */

function toRecord(row) {
  if (!row) return null
  return {
    id: row.id,
    cameraId: row.camera_id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? '',
    pan: row.pan,
    tilt: row.tilt,
    zoom: row.zoom,
    timelapseEveryMin: row.timelapse_every_min,
    timelapseAt: row.timelapse_at,
    timelapseEnabled: Boolean(row.timelapse_enabled),
    captureZone: row.capture_zone,
    lastCapturedAt: row.last_captured_at,
    lastCapturePath: row.last_capture_path,
    lastCaptureStatus: row.last_capture_status,
    lastCaptureError: row.last_capture_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listPresets(cameraId) {
  return db.prepare('SELECT * FROM presets WHERE camera_id = ? ORDER BY created_at DESC').all(cameraId).map(toRecord)
}

export function getPreset(id) {
  return toRecord(db.prepare('SELECT * FROM presets WHERE id = ?').get(id))
}

function stringOrDefault(v, fallback) {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

function stringOrNull(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function boolOrDefault(v, fallback) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
  return fallback
}

export function createPreset(cameraId, body, position) {
  const name = stringOrDefault(body.name, '')
  if (!name) throw new Error('preset name required')
  const zone = safeZone(stringOrDefault(body.captureZone, dbSlugify(name)))
  const now = new Date().toISOString()
  const id = newId()
  db.prepare(`INSERT INTO presets
      (id, camera_id, name, slug, description, pan, tilt, zoom,
       timelapse_every_min, timelapse_at, timelapse_enabled, capture_zone,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, cameraId, name, uniqueSlug(name), stringOrNull(body.description) ?? '',
      position.pan, position.tilt, position.zoom,
      numberOrNull(body.timelapseEveryMin), stringOrNull(body.timelapseAt),
      boolOrDefault(body.timelapseEnabled, false) ? 1 : 0, zone, now, now,
    )
  return getPreset(id)
}

export function updatePreset(id, body, position = null) {
  const existing = db.prepare('SELECT * FROM presets WHERE id = ?').get(id)
  if (!existing) throw new Error('preset not found')
  const name = stringOrDefault(body.name, existing.name)
  if (!name) throw new Error('preset name required')
  const now = new Date().toISOString()
  db.prepare(`UPDATE presets SET
      name = ?, slug = ?, description = ?, capture_zone = ?,
      timelapse_every_min = ?, timelapse_at = ?, timelapse_enabled = ?,
      pan = ?, tilt = ?, zoom = ?, updated_at = ?
      WHERE id = ?`)
    .run(
      name,
      name === existing.name ? existing.slug : uniqueSlug(name, id),
      body.description === undefined ? (existing.description ?? '') : (stringOrNull(body.description) ?? ''),
      stringOrDefault(body.captureZone, existing.capture_zone),
      body.timelapseEveryMin === undefined ? existing.timelapse_every_min : numberOrNull(body.timelapseEveryMin),
      body.timelapseAt === undefined ? existing.timelapse_at : stringOrNull(body.timelapseAt),
      boolOrDefault(body.timelapseEnabled, Boolean(existing.timelapse_enabled)) ? 1 : 0,
      position ? position.pan : existing.pan,
      position ? position.tilt : existing.tilt,
      position ? position.zoom : existing.zoom,
      now, id,
    )
  return getPreset(id)
}

export function deletePreset(id) {
  const existing = db.prepare('SELECT * FROM presets WHERE id = ?').get(id)
  if (!existing) throw new Error('preset not found')
  db.prepare('DELETE FROM presets WHERE id = ?').run(id)
  return toRecord(existing)
}

export function markPresetCapture(id, { ok, path = null, error = null } = {}) {
  const now = new Date().toISOString()
  if (ok) {
    db.prepare(`UPDATE presets SET last_captured_at = ?, last_capture_path = ?,
        last_capture_status = 'ok', last_capture_error = NULL, updated_at = ? WHERE id = ?`)
      .run(now, path, now, id)
  } else {
    db.prepare(`UPDATE presets SET last_capture_status = 'error', last_capture_error = ?, updated_at = ? WHERE id = ?`)
      .run(String(error ?? '').slice(0, 500), now, id)
  }
}

export function safeZone(value, fallback = 'overview') {
  if (typeof value !== 'string') return fallback
  const zone = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9-]{0,60}$/.test(zone) ? zone : fallback
}

// ---------- schedule math (ported from RediON garden-tapo-patrol, unit-tested) ----------

function minuteOfDay(d) {
  return d.getHours() * 60 + d.getMinutes()
}

export function intervalSlotStart(now, every, offset) {
  const currentMinute = minuteOfDay(now)
  const normalizedOffset = ((offset % every) + every) % every
  const slotMinute = currentMinute - ((currentMinute - normalizedOffset + every) % every)
  const slot = new Date(now)
  slot.setSeconds(0, 0)
  if (slotMinute >= 0) {
    slot.setHours(Math.floor(slotMinute / 60), slotMinute % 60, 0, 0)
  } else {
    slot.setDate(slot.getDate() - 1)
    const previousDayMinute = 1440 + slotMinute
    slot.setHours(Math.floor(previousDayMinute / 60), previousDayMinute % 60, 0, 0)
  }
  return slot
}

function hasDailyTimePassed(value, now) {
  if (!value || !/^\d{1,2}:\d{2}$/.test(value)) return false
  const [h, m] = value.split(':').map(Number)
  const due = new Date(now)
  due.setHours(h, m, 0, 0)
  return now >= due
}

function capturedAfterDailyTime(lastCapturedAt, value, now) {
  if (!lastCapturedAt || !value || !/^\d{1,2}:\d{2}$/.test(value)) return false
  const [h, m] = value.split(':').map(Number)
  const due = new Date(now)
  due.setHours(h, m, 0, 0)
  return new Date(lastCapturedAt) >= due
}

function minuteOffsetFromTime(value, every) {
  if (!value || !/^\d{1,2}:\d{2}$/.test(value)) return null
  const [h, m] = value.split(':').map(Number)
  const mv = h * 60 + m
  if (!Number.isFinite(mv)) return null
  return ((mv % every) + every) % every
}

function intervalGroupFor(preset, presets) {
  const every = Math.max(1, preset.timelapseEveryMin ?? 60)
  return presets.filter(p =>
    p.cameraId === preset.cameraId && Math.max(1, p.timelapseEveryMin ?? 60) === every)
}

function intervalOffsetFor(preset, group) {
  const every = Math.max(1, preset.timelapseEveryMin ?? 60)
  const anchored = minuteOffsetFromTime(preset.timelapseAt, every)
  if (anchored !== null) return anchored
  const ordered = [...group].sort((a, b) => {
    const byCreated = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    return byCreated || a.id.localeCompare(b.id)
  })
  const index = Math.max(0, ordered.findIndex(p => p.id === preset.id))
  const spacing = Math.max(1, Math.floor(every / Math.max(1, ordered.length)))
  return (index * spacing) % every
}

export function isPresetDue(preset, now, presets) {
  if (preset.timelapseEveryMin === null && preset.timelapseAt) {
    // Pure daily mode: fire once per day, at/after the anchor time only.
    // (RediON fell through to interval math here, which could fire hourly
    // before the anchor — fixed in HUGO Eye.)
    return hasDailyTimePassed(preset.timelapseAt, now)
      && !capturedAfterDailyTime(preset.lastCapturedAt, preset.timelapseAt, now)
  }
  const every = Math.max(1, preset.timelapseEveryMin ?? 60)
  const group = intervalGroupFor(preset, presets)
  const offset = intervalOffsetFor(preset, group)
  const slotStart = intervalSlotStart(now, every, offset)
  const baseline = preset.lastCapturedAt ?? preset.createdAt
  return slotStart > new Date(baseline)
}

export function duePresets(cameraId, now = new Date()) {
  const enabled = listPresets(cameraId).filter(p => p.timelapseEnabled)
  return enabled.filter(p => isPresetDue(p, now, enabled))
}
