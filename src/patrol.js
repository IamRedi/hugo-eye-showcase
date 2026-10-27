import path from 'node:path'
import { config } from './config.js'
import { db, recordEvent } from './db.js'
import { log } from './log.js'
import { withPtzLock } from './ptzlock.js'
import { duePresets, markPresetCapture, safeZone } from './presets.js'
import { writeJpegAtomic } from './camera/ffmpeg.js'
import { signalBus } from './eventbus.js'

/**
 * Patrol: walks due presets, moves the camera to each saved position,
 * waits for the image to settle, snapshots the configured zone.
 * All movement goes through the global PTZ lock; a run is a no-op if
 * another patrol is already active.
 */

let running = false

export function patrolStatus() {
  return {
    running,
    enabledInConfig: config.patrol.enabled,
    settleMs: config.patrol.settleMs,
    tickMs: config.patrol.tickMs,
  }
}

export async function runPatrol(drivers, { force = false, limit = config.patrol.limit } = {}) {
  if (running) return { ok: true, skipped: true, reason: 'patrol already running', results: [] }
  running = true
  try {
    return await _run(drivers, force, limit)
  } finally {
    running = false
  }
}

async function _run(drivers, force, limit) {
  const settleMs = config.patrol.settleMs
  const results = []

  for (const driver of drivers) {
    const all = db.prepare(`SELECT * FROM presets WHERE camera_id = ? AND timelapse_enabled = 1
        ORDER BY last_captured_at ASC, created_at ASC LIMIT ?`).all(driver.id, limit)
    const presets = force
      ? all
      : duePresets(driver.id).filter(p => all.some(a => a.id === p.id))
    log.info(`patrol: camera ${driver.id} checked=${all.length} due=${presets.length} force=${force}`)

    for (const preset of presets) {
      const zone = safeZone(preset.capture_zone)
      try {
        // Move under the global PTZ lock; release before capture so a user
        // command can queue immediately behind this move.
        await withPtzLock('patrol', async () => {
          await driver.gotoPosition({ pan: preset.pan, tilt: preset.tilt, zoom: preset.zoom })
          signalBus.emit('camera.moved', { cameraId: driver.id })
        })
        await sleep(settleMs)
        const { jpeg } = await driver.snapshot({ zone })
        const finalPath = path.join(config.storage.mediaDir, zone, `${fileStamp()}.jpg`)
        writeJpegAtomic(finalPath, jpeg)
        db.prepare(`INSERT INTO media (camera_id, zone, path, captured_at, size_bytes, source)
            VALUES (?, ?, ?, ?, ?, 'patrol')
            ON CONFLICT(path) DO UPDATE SET size_bytes = excluded.size_bytes`)
          .run(driver.id, zone, finalPath, new Date().toISOString(), jpeg.length)
        markPresetCapture(preset.id, { ok: true, path: finalPath })
        recordEvent('patrol.capture', driver.id, `${preset.name} -> ${zone}`)
        results.push({ presetId: preset.id, name: preset.name, zone, ok: true, file: finalPath })
        log.info(`patrol: ${preset.name} -> ${finalPath}`)
      } catch (error) {
        markPresetCapture(preset.id, { ok: false, error: error.message })
        recordEvent('patrol.error', driver.id, `${preset.name}: ${error.message}`)
        results.push({ presetId: preset.id, name: preset.name, zone, ok: false, error: error.message })
        log.error(`patrol: ${preset.name} failed: ${error.message}`)
      }
    }
  }
  return { ok: true, force: Boolean(force), results }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function fileStamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}
