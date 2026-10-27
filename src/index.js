import fs from 'node:fs'
import child_process from 'node:child_process'
import { config, assertConfigured, lanAddresses } from './config.js'
import { log } from './log.js'
import { openDb } from './db.js'
import { getCameraSettings, cameraPrivacyBlocked } from './settings.js'
import { createDriver } from './camera/tapo.js'
import { seedFromEnv, driverConfigs as registryDrivers } from './cameras.js'
import { ffmpegAvailable } from './camera/ffmpeg.js'
import { HealthMonitor } from './health.js'
import { runPatrol } from './patrol.js'
import { stopAllRecordings, enforceQuotaAndRetention, reconcileRecordingModes } from './recordings.js'
import { VisitSessionizer } from './vision/sessions.js'
import { IntelligenceManager } from './intelligence.js'
import { stopAllHubs, hubBus } from './camera/hub.js'
import { createServer } from './api/server.js'
import { AutomationEngine } from './automations.js'
import { publishEvent, signalBus } from './eventbus.js'
import { SearchIndexer } from './search.js'
import { AutoFollowManager } from './vision/autofollow.js'

/**
 * HUGO Eye 2.0 — premium local-first indoor smart-camera platform.
 * config → database (V2 migration, indoor init) → drivers (orientation-aware)
 * → capability detection → health → intelligence → optional patrol → API+UI.
 */

async function main() {
  log.info(`hugo-eye starting (data dir: ${config.storage.dataDir})`)

  const problems = assertConfigured()
  if (problems.length) {
    for (const p of problems) log.error(`configuration: ${p}`)
    process.exit(1)
  }
  if (!(await ffmpegAvailable())) {
    log.error('ffmpeg not found on PATH — snapshots, live view and recordings will not work')
    process.exit(1)
  }

  fs.mkdirSync(config.storage.mediaDir, { recursive: true })
  openDb()

  const getOrientation = cameraId => {
    const cs = getCameraSettings(cameraId)
    return { rotate: cs?.rotate ?? 0, mirror: cs?.mirror ?? false, flip: cs?.flip ?? false }
  }

  // camera registry (Gate 9): DB is the source of truth; CAM<n>_* env groups
  // seed it once so 2.x setups keep working unchanged
  seedFromEnv(config.cameras)
  const drivers = registryDrivers().map(cam => createDriver(cam, getOrientation))
  for (const driver of drivers) {
    const cs = getCameraSettings(driver.id)
    log.info(`camera registered: ${driver.id} "${cs?.displayName ?? driver.cam.name}" — ${driver.label()} [rotate ${cs?.rotate ?? 0}°]`)
    await driver.detectCapabilities()
  }

  const healthMonitor = new HealthMonitor(drivers, { intervalMs: config.health.intervalMs })
  healthMonitor.start()

  // Relay session lifecycle → typed events (Activity feed + automations).
  hubBus.on('state', ({ cameraId, state, prev }) => {
    if (state === 'recovering') {
      publishEvent('stream.lost', cameraId, `relay ${prev} → recovering`)
    } else if (state === 'streaming' && (prev === 'recovering' || prev === 'connecting')) {
      publishEvent('stream.recovered', cameraId, 'media flowing again')
    }
  })

  const intelligence = new IntelligenceManager()
  intelligence.setDrivers(drivers)
  await intelligence.reconcile()

  const automations = new AutomationEngine({ drivers, intelligence })
  automations.start()
  intelligence.automations = automations

  // semantic search index (Gate 4): embeds event evidence for NL search
  const searchIndexer = new SearchIndexer()

  // PTZ auto-follow (Gate 5): one controller per camera; the person tracker
  // is injected lazily so following works only while detection is active
  const autoFollow = new AutoFollowManager()

  // visit sessionizer (Gate 7): folds person-presence event storms into
  // meaningful visit sessions with correlated timelines
  const sessionizer = new VisitSessionizer()

  // recording modes (Gate 7): continuous/event reconciliation on boot, on
  // settings changes (server PATCH hook) and on every quota pass
  const reconcileRecordings = () => {
    reconcileRecordingModes(drivers, cameraPrivacyBlocked).catch(error => log.warn(`recording modes: ${error.message}`))
  }
  reconcileRecordings()


  let patrolTimer = null
  if (config.patrol.enabled) {
    patrolTimer = setInterval(() => {
      runPatrol(drivers).catch(error => log.error(`patrol tick failed: ${error.message}`))
    }, config.patrol.tickMs)
    patrolTimer.unref()
    log.info(`patrol scheduler enabled (tick ${config.patrol.tickMs}ms)`)
  } else {
    log.info('patrol scheduler disabled (PATROL_ENABLED=false) — no automatic camera movement')
  }

  try { await enforceQuotaAndRetention() } catch (error) { log.warn(`startup quota pass failed: ${error.message}`) }

  const server = createServer({ drivers, healthMonitor, intelligence, searchIndexer, autoFollow, reconcileRecordings, sessionizer })
  await new Promise(resolve => server.listen(config.server.port, config.server.host, resolve))
  if (config.server.host === '0.0.0.0' || config.server.host === '::') {
    const lan = lanAddresses()
    log.info(`HUGO Eye API + UI listening on all interfaces — LAN: ${lan.map(ip => `http://${ip}:${config.server.port}`).join('  ')}`)
    startMdnsAdvertiser()
  } else {
    log.info(`HUGO Eye API + UI on http://${config.server.host}:${config.server.port}`)
  }

  const shutdown = signal => {
    log.info(`received ${signal}, shutting down`)
    if (patrolTimer) clearInterval(patrolTimer)
    healthMonitor.stop()
    automations.stop()
    intelligence.stopAll()
    searchIndexer.stop()
    sessionizer.stop()
    autoFollow.stopAll().catch(() => {})
    for (const driver of drivers) {
      driver.livePool?.stopAll()
      driver.fmp4Pool?.stopAll()
    }
    stopAllHubs()
    stopAllRecordings('shutdown').catch(() => {})
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

/** Optional .local discovery via avahi (only when the daemon is present). */
function startMdnsAdvertiser() {
  try {
    const { spawn } = child_process
    if (!fs.existsSync('/usr/bin/avahi-publish')) return
    const procName = `hugo-eye ${config.server.port}`
    const mdns = spawn('avahi-publish', ['-s', procName, '_http._tcp', String(config.server.port), 'path=/'], { stdio: 'ignore' })
    mdns.on('error', () => log.info('mdns: avahi-publish unavailable — .local discovery skipped'))
    log.info(`mdns: advertising ${procName} via avahi (reachable as http://<hostname>.local:${config.server.port})`)
    process.on('exit', () => { try { mdns.kill() } catch { /* gone */ } })
  } catch { /* optional */ }
}

process.on('unhandledRejection', error => {
  log.error(`unhandled rejection: ${error?.stack ?? error}`)
})

main().catch(error => {
  log.error(`fatal: ${error.stack ?? error}`)
  process.exit(1)
})
