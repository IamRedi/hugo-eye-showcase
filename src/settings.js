import { db, kvGet, kvSet } from './db.js'
import { normalizeOrientation } from './orientation.js'

/**
 * Product settings. Privacy gates default to OFF — recording, microphone and
 * AI must be explicitly enabled by the owner through the Settings UI.
 */

const PRODUCT_DEFAULTS = {
  privacy: {
    recordingEnabled: false,
    microphoneEnabled: false,
    aiEnabled: false,
    familiarFaceEnabled: false,
  },
  storage: {
    maxStorageGb: 20,
    retentionDays: 14,
    minFreeGb: 8,
    eventRetentionDays: 30,
  },
  motion: {
    enabled: false,
    threshold: 0.045,
    minIntervalSec: 10,
    // Pre-event buffer for motion-triggered recordings, in whole GOPs
    // (0 = disabled; bounded by the hub's GOP ring memory cap).
    preBufferGops: 0,
  },
  ai: {
    // Person/object detection is OFF until the owner explicitly enables it
    // (privacy: inference is local, but people detection itself is opt-in).
    personEnabled: false,
    inferenceFps: 2,
    minConfidence: 0.45,
    minIntervalSec: 30,
    classes: ['person'],
  },
  face: {
    detectionScore: 0.5,
    matchThreshold: 0.363,
    eventIntervalSec: 120,
  },
  aiVision: {
    // Local VLM (visual reasoning). OFF by default — a separate, explicit
    // opt-in beyond aiEnabled because it runs an additional model.
    enabled: false,
    // describe new person/object events automatically (bounded queue)
    describeEvents: true,
    // minimum seconds between automatic descriptions per camera
    cooldownSec: 90,
  },
  autofollow: {
    // PTZ subject following (Gate 5). Requires aiEnabled + personEnabled.
    enabled: false,
    // keep the screen region the subject must stay near (normalized)
    screenX: 0.5,
    screenY: 0.45,
    // return to the position captured at session start when following ends
    returnHome: true,
    lostHoldMs: 4000,
  },
  automations: {
    motionRecord: { enabled: false, seconds: 30, cooldownSec: 90 },
    motionNotify: { enabled: true },
  },
  recording: {
    // 'events' (manual + event-triggered) | 'continuous' | 'off'
    mode: 'events',
    // event recordings keep rolling this long after the last qualifying event
    postEventSec: 10,
    // hard cap for one event-triggered recording
    maxSec: 300,
  },
  experimental: {
    // movement-signature hints in the AI Vision overlay (secondary continuity
    // hint only — never a standalone identity claim; uncalibrated)
    movementSignature: false,
  },
}

export function getProductSettings() {
  const stored = kvGet('product_settings', {}) ?? {}
  return deepMerge(structuredClone(PRODUCT_DEFAULTS), stored)
}

export function setProductSettings(patch) {
  const merged = deepMerge(getProductSettings(), patch ?? {})
  // privacy gates can only be set to true explicitly; storage bounds sane
  merged.storage.maxStorageGb = clamp(merged.storage.maxStorageGb, 1, 8000)
  merged.storage.retentionDays = clamp(merged.storage.retentionDays, 1, 3650)
  merged.storage.minFreeGb = clamp(merged.storage.minFreeGb, 1, 500)
  merged.storage.eventRetentionDays = clamp(merged.storage.eventRetentionDays, 1, 365)
  merged.motion.threshold = clamp(merged.motion.threshold, 0.005, 0.5)
  merged.motion.minIntervalSec = clamp(merged.motion.minIntervalSec, 2, 3600)
  merged.motion.preBufferGops = Math.round(clamp(merged.motion.preBufferGops ?? 0, 0, 4))
  merged.ai.personEnabled = Boolean(merged.ai.personEnabled)
  merged.ai.inferenceFps = Math.round(clamp(merged.ai.inferenceFps ?? 2, 1, 5))
  merged.ai.minConfidence = clamp(merged.ai.minConfidence ?? 0.45, 0.1, 0.95)
  merged.ai.minIntervalSec = clamp(merged.ai.minIntervalSec ?? 30, 5, 3600)
  if (!Array.isArray(merged.ai.classes) || merged.ai.classes.length === 0) merged.ai.classes = ['person']
  merged.ai.classes = merged.ai.classes
    .map(c => String(c).toLowerCase().trim()).filter(Boolean).slice(0, 10)
  merged.privacy.familiarFaceEnabled = Boolean(merged.privacy.familiarFaceEnabled)
  merged.face.detectionScore = clamp(merged.face.detectionScore, 0.2, 0.9)
  merged.face.matchThreshold = clamp(merged.face.matchThreshold, 0.25, 0.6)
  merged.face.eventIntervalSec = Math.round(clamp(merged.face.eventIntervalSec, 30, 3600))
  merged.aiVision.enabled = Boolean(merged.aiVision.enabled)
  merged.aiVision.describeEvents = Boolean(merged.aiVision.describeEvents)
  merged.aiVision.cooldownSec = Math.round(clamp(merged.aiVision.cooldownSec, 15, 3600))
  merged.autofollow.enabled = Boolean(merged.autofollow.enabled)
  merged.autofollow.screenX = clamp(merged.autofollow.screenX, 0.2, 0.8)
  merged.autofollow.screenY = clamp(merged.autofollow.screenY, 0.2, 0.8)
  merged.autofollow.returnHome = Boolean(merged.autofollow.returnHome)
  merged.autofollow.lostHoldMs = Math.round(clamp(merged.autofollow.lostHoldMs, 1000, 30000))
  if (!['events', 'continuous', 'off'].includes(merged.recording.mode)) merged.recording.mode = 'events'
  merged.recording.postEventSec = Math.round(clamp(merged.recording.postEventSec, 0, 120))
  merged.recording.maxSec = Math.round(clamp(merged.recording.maxSec, 15, 3600))
  merged.experimental.movementSignature = Boolean(merged.experimental.movementSignature)
  merged.automations.motionRecord.seconds = clamp(merged.automations.motionRecord.seconds, 5, 300)
  merged.automations.motionRecord.cooldownSec = clamp(merged.automations.motionRecord.cooldownSec, 10, 3600)
  kvSet('product_settings', merged)
  return merged
}

export function getCameraSettings(cameraId) {
  const row = db.prepare('SELECT * FROM camera_settings WHERE camera_id = ?').get(cameraId)
  if (!row) return null
  return {
    cameraId: row.camera_id,
    displayName: row.display_name,
    ...normalizeOrientation({ rotate: row.rotate, mirror: row.mirror, flip: row.flip }),
    privacyDisabled: Boolean(row.privacy_disabled),
    retentionDays: row.retention_days ?? null,
    recordingEnabled: row.recording_enabled === null ? true : Boolean(row.recording_enabled),
  }
}

export function setCameraSettings(cameraId, patch = {}) {
  const existing = getCameraSettings(cameraId) ?? {
    displayName: null, rotate: 0, mirror: false, flip: false, privacyDisabled: false,
  }
  const merged = {
    displayName: typeof patch.displayName === 'string' && patch.displayName.trim()
      ? patch.displayName.trim().slice(0, 60)
      : existing.displayName,
    ...normalizeOrientation({
      rotate: patch.rotate ?? existing.rotate,
      mirror: patch.mirror ?? existing.mirror,
      flip: patch.flip ?? existing.flip,
    }),
    privacyDisabled: typeof patch.privacyDisabled === 'boolean' ? patch.privacyDisabled : existing.privacyDisabled,
    retentionDays: patch.retentionDays === null
      ? null
      : (patch.retentionDays !== undefined
          ? Math.round(clamp(patch.retentionDays, 1, 3650))
          : (existing.retentionDays ?? null)),
    recordingEnabled: typeof patch.recordingEnabled === 'boolean' ? patch.recordingEnabled : (existing.recordingEnabled ?? true),
  }
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO camera_settings (camera_id, display_name, rotate, mirror, flip, privacy_disabled, retention_days, recording_enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(camera_id) DO UPDATE SET
        display_name = excluded.display_name, rotate = excluded.rotate,
        mirror = excluded.mirror, flip = excluded.flip,
        privacy_disabled = excluded.privacy_disabled,
        retention_days = excluded.retention_days,
        recording_enabled = excluded.recording_enabled,
        updated_at = excluded.updated_at`)
    .run(cameraId, merged.displayName, merged.rotate, merged.mirror ? 1 : 0, merged.flip ? 1 : 0,
      merged.privacyDisabled ? 1 : 0, merged.retentionDays ?? null, merged.recordingEnabled ? 1 : 0, now, now)
  return getCameraSettings(cameraId)
}

/** Camera is privacy-blocked when the per-camera switch is on. */
export function cameraPrivacyBlocked(cameraId) {
  return Boolean(getCameraSettings(cameraId)?.privacyDisabled)
}

function clamp(v, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function deepMerge(base, patch) {
  for (const key of Object.keys(patch ?? {})) {
    const value = patch[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof base[key] === 'object') {
      deepMerge(base[key], value)
    } else if (value !== undefined) {
      base[key] = value
    }
  }
  return base
}
