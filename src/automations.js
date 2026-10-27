import path from 'node:path'
import { db, newId, recordEvent } from './db.js'
import { log } from './log.js'
import { audit } from './security.js'
import { eventBus } from './eventbus.js'

/**
 * Automation rules engine (Gate 5) — data-driven rules evaluated against the
 * unified event stream. No scripting language: rules are structured
 * condition/action objects, editable and testable through the API.
 *
 * condition (all optional, AND-combined):
 *   eventType        'person'|'person_known'|'person_unknown'|'object'|'motion'|
 *                    'entered_zone'|'exited_zone'|'stream.lost'|'stream.recovered'|
 *                    'recording.started'|'recording.stopped'|...
 *   cameraId         restrict to one camera
 *   label            object/person class ('person', 'chair', ...)
 *   zone             zone name
 *   familiarity      'known' | 'unknown' | 'any'
 *   minConfidence    0..1 floor
 *   timeWindow       { from: 'HH:MM', to: 'HH:MM' } (local time, wraps midnight)
 *
 * action:
 *   { type: 'snapshot', zone? }            capture a full-res snapshot
 *   { type: 'record', seconds }            bounded recording (privacy-gated)
 *   { type: 'notify', message? }           panel notification (SSE)
 *   { type: 'scene_flag', key, value? }    update HUGO-visible scene state
 *
 * Every rule: cooldown, enable/disable, dry-run test, audit trail, and an
 * honest lastError — a failing rule never fakes success.
 */

export function listRules() {
  return db.prepare('SELECT * FROM automation_rules ORDER BY created_at').all()
    .map(rowFromDb)
}

export function getRule(id) {
  const row = db.prepare('SELECT * FROM automation_rules WHERE id = ?').get(id)
  return row ? rowFromDb(row) : null
}

export function createRule({ name, conditions = {}, actions = [], cooldownSec = 60, enabled = true }) {
  const now = new Date().toISOString()
  const rule = {
    id: newId(),
    name: String(name).slice(0, 80),
    conditions: normalizeConditions(conditions),
    actions: normalizeActions(actions),
    cooldownSec: Math.max(5, Math.min(86_400, Math.round(cooldownSec))),
    enabled: Boolean(enabled),
  }
  db.prepare(`INSERT INTO automation_rules (id, name, enabled, conditions, actions, cooldown_sec, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(rule.id, rule.name, rule.enabled ? 1 : 0, JSON.stringify(rule.conditions), JSON.stringify(rule.actions), rule.cooldownSec, now, now)
  audit('automation.rule_created', `${rule.name}`)
  return getRule(rule.id)
}

export function updateRule(id, patch) {
  const existing = getRule(id)
  if (!existing) return null
  const next = {
    name: patch.name !== undefined ? String(patch.name).slice(0, 80) : existing.name,
    conditions: patch.conditions !== undefined ? normalizeConditions(patch.conditions) : existing.conditions,
    actions: patch.actions !== undefined ? normalizeActions(patch.actions) : existing.actions,
    cooldownSec: patch.cooldownSec !== undefined ? Math.max(5, Math.min(86_400, Math.round(patch.cooldownSec))) : existing.cooldownSec,
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : existing.enabled,
  }
  db.prepare(`UPDATE automation_rules SET name = ?, enabled = ?, conditions = ?, actions = ?, cooldown_sec = ?, updated_at = ? WHERE id = ?`)
    .run(next.name, next.enabled ? 1 : 0, JSON.stringify(next.conditions), JSON.stringify(next.actions), next.cooldownSec, new Date().toISOString(), id)
  audit('automation.rule_updated', `${next.name} (enabled=${next.enabled})`)
  return getRule(id)
}

export function deleteRule(id) {
  const existing = getRule(id)
  if (!existing) return false
  db.prepare('DELETE FROM automation_rules WHERE id = ?').run(id)
  audit('automation.rule_deleted', existing.name)
  return true
}

function rowFromDb(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    conditions: safeJson(row.conditions, {}),
    actions: safeJson(row.actions, []),
    cooldownSec: row.cooldown_sec,
    lastFiredAt: row.last_fired_at,
    lastError: row.last_error,
    fireCount: row.fire_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function safeJson(text, fallback) {
  try { return JSON.parse(text) } catch { return fallback }
}

function normalizeConditions(c) {
  const out = {}
  if (c.eventType) out.eventType = String(c.eventType)
  if (c.cameraId) out.cameraId = String(c.cameraId)
  if (c.label) out.label = String(c.label)
  if (c.zone) out.zone = String(c.zone)
  if (c.familiarity && ['known', 'unknown', 'any'].includes(c.familiarity)) out.familiarity = c.familiarity
  if (Number.isFinite(Number(c.minConfidence))) out.minConfidence = Math.min(1, Math.max(0, Number(c.minConfidence)))
  if (c.timeWindow && /^\d{2}:\d{2}$/.test(c.timeWindow.from ?? '') && /^\d{2}:\d{2}$/.test(c.timeWindow.to ?? '')) {
    out.timeWindow = { from: c.timeWindow.from, to: c.timeWindow.to }
  }
  return out
}

const ACTION_TYPES = ['snapshot', 'record', 'notify', 'scene_flag']
function normalizeActions(actions) {
  if (!Array.isArray(actions)) return []
  return actions.slice(0, 5).map(a => {
    const type = String(a?.type ?? '')
    if (!ACTION_TYPES.includes(type)) return { type: 'notify', message: `invalid action type: ${type}` }
    if (type === 'record') return { type, seconds: Math.max(5, Math.min(300, Math.round(Number(a.seconds) || 30))) }
    if (type === 'snapshot') return { type, zone: String(a.zone ?? 'automation').slice(0, 40) }
    if (type === 'scene_flag') return { type, key: String(a.key ?? 'flag').slice(0, 40), value: a.value ?? true }
    return { type, message: String(a.message ?? '').slice(0, 200) }
  })
}

// ---------- evaluation ----------

export function ruleMatches(rule, event) {
  const c = rule.conditions
  const type = event.type
  if (c.eventType && type !== c.eventType && !type.startsWith(c.eventType)) return false
  if (c.cameraId && event.cameraId !== c.cameraId) return false
  if (c.label && event.label !== c.label) return false
  if (c.zone && event.zone !== c.zone) return false
  if (c.minConfidence !== undefined && (event.confidence ?? 0) < c.minConfidence) return false
  if (c.familiarity && c.familiarity !== 'any') {
    if (c.familiarity === 'known' && type !== 'person_known' && !event.person) return false
    if (c.familiarity === 'unknown' && type !== 'person_unknown') return false
  }
  if (c.timeWindow && !inTimeWindow(c.timeWindow)) return false
  return true
}

export function inTimeWindow({ from, to }, now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes()
  const [fh, fm] = from.split(':').map(Number)
  const [th, tm] = to.split(':').map(Number)
  const f = fh * 60 + fm
  const t = th * 60 + tm
  return f <= t ? (minutes >= f && minutes <= t) : (minutes >= f || minutes <= t)
}

export class AutomationEngine {
  constructor({ drivers = null, intelligence = null } = {}) {
    this.drivers = drivers
    this.intelligence = intelligence
    this.recentFires = new Map()   // ruleId → ts (cooldown enforcement)
    this.sceneFlags = new Map()    // key → value (HUGO-visible)
  }

  start() {
    this.handler = event => { this.evaluate(event).catch(() => {}) }
    eventBus.on('event', this.handler)
  }

  stop() {
    if (this.handler) eventBus.off('event', this.handler)
  }

  /** Evaluate all enabled rules against one event; fire actions on match. */
  async evaluate(event, { dryRuleId = null } = {}) {
    const results = []
    for (const rule of listRules()) {
      if (dryRuleId && rule.id !== dryRuleId) continue
      if (!dryRuleId && !rule.enabled) continue
      if (!ruleMatches(rule, event)) continue
      const result = await this.fire(rule, event, { dry: Boolean(dryRuleId) })
      results.push({ ruleId: rule.id, name: rule.name, ...result })
      if (!dryRuleId) break   // first matching rule fires; others wait for their own events
    }
    return results
  }

  async fire(rule, event, { dry = false } = {}) {
    const now = Date.now()
    if (!dry) {
      const last = this.recentFires.get(rule.id) ?? 0
      if (now - last < rule.cooldownSec * 1000) return { fired: false, reason: 'cooldown' }
      this.recentFires.set(rule.id, now)
    }
    const actions = []
    let error = null
    for (const action of rule.actions) {
      try {
        actions.push(await this.executeAction(action, event, { dry }))
      } catch (err) {
        error = `${action.type}: ${err.message}`
        actions.push({ type: action.type, error: error })
      }
    }
    if (!dry) {
      db.prepare('UPDATE automation_rules SET last_fired_at = ?, last_error = ?, fire_count = fire_count + ? WHERE id = ?')
        .run(new Date().toISOString(), error, error ? 0 : 1, rule.id)
      audit('automation.fired', `${rule.name} on ${event.type}${error ? ` error=${error}` : ''}`)
      if (error) log.warn(`automation rule "${rule.name}" failed: ${error}`)
    }
    return { fired: true, dry, actions, error }
  }

  async executeAction(action, event, { dry }) {
    const driver = this.drivers?.find(d => d.id === event.cameraId) ?? this.drivers?.[0]
    switch (action.type) {
      case 'snapshot': {
        if (dry) return { type: 'snapshot', would: true }
        if (!driver) throw new Error('no camera')
        const { safeZone } = await import('./presets.js')
        const { writeJpegAtomic } = await import('./camera/ffmpeg.js')
        const { config } = await import('./config.js')
        const zone = safeZone(action.zone)
        const { jpeg } = await driver.snapshot({ zone })
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
        const finalPath = path.join(config.storage.mediaDir, 'automations', `${stamp}-${slug(event.type)}.jpg`)
        writeJpegAtomic(finalPath, jpeg)
        return { type: 'snapshot', path: finalPath, bytes: jpeg.length }
      }
      case 'record': {
        if (dry) return { type: 'record', would: true, seconds: action.seconds }
        if (!driver) throw new Error('no camera')
        const { startRecording, stopRecording, activeRecordings } = await import('./recordings.js')
        if (activeRecordings().includes(driver.id)) return { type: 'record', skipped: 'already recording' }
        const result = await startRecording(driver, { trigger: `rule:${slug(event.type)}` })
        if (!result.ok) throw new Error(result.error)
        setTimeout(() => {
          stopRecording(driver.id, { reason: 'automation_complete' }).catch(() => {})
        }, action.seconds * 1000)
        return { type: 'record', groupId: result.groupId, seconds: action.seconds }
      }
      case 'notify': {
        const message = action.message || `Automation: ${event.type}${event.person ? ` — ${event.person.name}` : ''}`
        if (!dry) recordEvent('automation.notify', event.cameraId ?? null, message.slice(0, 200))
        const { eventBus } = await import('./eventbus.js')
        eventBus.emit('event', { id: null, type: 'automation.notify', cameraId: event.cameraId, at: new Date().toISOString(), detail: message })
        return { type: 'notify', message }
      }
      case 'scene_flag': {
        if (dry) return { type: 'scene_flag', would: true }
        this.sceneFlags.set(action.key, action.value ?? true)
        recordEvent('automation.scene_flag', event.cameraId ?? null, `${action.key}=${JSON.stringify(action.value ?? true)}`)
        return { type: 'scene_flag', key: action.key, value: action.value ?? true }
      }
      default:
        throw new Error(`unknown action type: ${action.type}`)
    }
  }

  sceneState() {
    return Object.fromEntries(this.sceneFlags)
  }
}

// ---------- helpers ----------

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'event'
}
