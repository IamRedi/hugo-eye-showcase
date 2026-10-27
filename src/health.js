import { db } from './db.js'
import { log } from './log.js'
import { publishEvent } from './eventbus.js'

/**
 * Periodic camera health monitoring. Passive only: TCP probes + ONVIF
 * GetStatus (never moves the camera). Results are persisted for the panel
 * and for the camera_health DeviceAdapter capability.
 *
 * The health table grows one row per camera per interval — it is pruned to
 * HEALTH_RETENTION_DAYS (bounded, at most once per hour).
 */

const HEALTH_RETENTION_DAYS = 7
const PRUNE_EVERY_MS = 60 * 60 * 1000

export class HealthMonitor {
  constructor(drivers, { intervalMs = 30000 } = {}) {
    this.drivers = drivers
    this.intervalMs = intervalMs
    this.latest = new Map() // cameraId -> health snapshot
    this.timer = null
    this.checking = false
    this.lastPruneAt = 0
  }

  start() {
    this.check()
    this.timer = setInterval(() => this.check(), this.intervalMs)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  snapshot(cameraId) {
    return this.latest.get(cameraId) ?? null
  }

  _prune() {
    const now = Date.now()
    if (now - this.lastPruneAt < PRUNE_EVERY_MS) return
    this.lastPruneAt = now
    try {
      const cutoff = new Date(now - HEALTH_RETENTION_DAYS * 86400 * 1000).toISOString()
      const info = db.prepare('DELETE FROM health WHERE at < ?').run(cutoff)
      if (info.changes > 0) log.info(`health history: pruned ${info.changes} rows older than ${HEALTH_RETENTION_DAYS}d`)
    } catch (error) {
      log.warn(`health prune failed: ${error.message}`)
    }
  }

  async check() {
    if (this.checking) return
    this.checking = true
    try {
      for (const driver of this.drivers) {
        try {
          const health = await driver.health()
          const prev = this.latest.get(driver.id)
          this.latest.set(driver.id, health)
          db.prepare(`INSERT INTO health (camera_id, at, ok, rtsp_ok, onvif_ok, detail)
              VALUES (?, ?, ?, ?, ?, ?)`)
            .run(driver.id, health.checkedAt, health.ok ? 1 : 0, health.rtspOk ? 1 : 0, health.onvifOk ? 1 : 0, health.detail.slice(0, 500))
          if (prev && prev.ok !== health.ok) {
            publishEvent('health.changed', driver.id, `${prev.ok ? 'healthy' : 'degraded'} -> ${health.ok ? 'healthy' : 'degraded'} (${health.detail || 'recovered'})`)
            log.warn(`camera ${driver.id} health changed: ${health.ok ? 'OK' : 'degraded'} ${health.detail}`)
          }
        } catch (error) {
          log.error(`camera ${driver.id} health check failed: ${error.message}`)
        }
      }
      this._prune()
    } finally {
      this.checking = false
    }
  }
}
