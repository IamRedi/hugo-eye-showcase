import { db } from '../db.js'
import { log } from '../log.js'
import { getProductSettings } from '../settings.js'
import { eventBus, publishEvent } from '../eventbus.js'

/**
 * VisitSessionizer (Gate 7) — one continuous person visit is one meaningful
 * session, not a hundred unrelated alerts.
 *
 * A visit opens on a person presence event (arrival) and stays open while
 * presence evidence keeps arriving (person/face/zone events for the camera).
 * When the camera reports no person for VISIT_GAP_MS, the visit closes and a
 * `visit.summary` event is published: correlated member events, duration,
 * known persons, peak count — with every member row linked via
 * correlation_id so the timeline can show the whole visit as one object.
 *
 * Honesty: summaries are computed from real event evidence only; a visit
 * that ended without departure evidence is labeled so.
 */

const VISIT_GAP_MS = 90_000
const OPENING_TYPES = new Set(['person', 'person_known', 'person_unknown', 'recognition_uncertain'])
const KEEPALIVE_TYPES = new Set(['person', 'person_known', 'person_unknown', 'recognition_uncertain', 'object', 'follow.stopped'])

export class VisitSessionizer {
  constructor() {
    this.open = new Map()   // cameraId → visit
    this.handler = event => this.observe(event)
    eventBus.on('event', this.handler)
  }

  stop() {
    eventBus.off('event', this.handler)
    for (const [, visit] of this.open) this._close(visit, 'stopped')
  }

  observe(event) {
    try {
      if (event.type === 'motion') return   // motion alone never keeps a visit alive
      const cameraId = event.cameraId
      if (!cameraId) return
      const now = Date.parse(event.at) || Date.now()
      let visit = this.open.get(cameraId)
      if (visit && now - visit.lastEvidenceAt > VISIT_GAP_MS) {
        this._close(visit, 'gap')
        visit = null
      }
      if (!visit && OPENING_TYPES.has(event.type)) {
        visit = {
          id: `visit-${event.id}-${cameraId}`,
          cameraId,
          openedAt: event.at,
          lastEvidenceAt: now,
          memberIds: [],
          persons: new Set(),
          peakCount: 0,
          zones: new Set(),
          firstThumb: event.thumb ?? null,
        }
        this.open.set(cameraId, visit)
        log.info(`visit: opened ${visit.id} (${cameraId})`)
      }
      if (!visit || !KEEPALIVE_TYPES.has(event.type)) return
      visit.lastEvidenceAt = now
      visit.memberIds.push(event.id)
      if (event.personId) visit.persons.add(event.personId)
      if (event.zone) visit.zones.add(event.zone)
      visit.peakCount = Math.max(visit.peakCount, this._personCount(event))
      // live-link members as they arrive (so partial visits are queryable too)
      db.prepare('UPDATE events SET correlation_id = ? WHERE id = ?').run(visit.id, event.id)
    } catch (error) {
      log.warn(`visit sessionizer: ${error.message}`)
    }
  }

  _personCount(event) {
    // person count evidence: the detail line of presence events may name a
    // count; face events count 1. Conservative: 1 unless the provider said more.
    const m = /count[= ](\d+)/i.exec(event.detail ?? '')
    return m ? Number(m[1]) : (event.type === 'object' ? 0 : 1)
  }

  _close(visit, reason) {
    this.open.delete(visit.cameraId)
    try {
      const closedAt = new Date(visit.lastEvidenceAt).toISOString()
      const durationS = Math.round((visit.lastEvidenceAt - Date.parse(visit.openedAt)) / 1000)
      const personNames = visit.persons.size
        ? db.prepare(`SELECT id, name FROM people WHERE id IN (${[...visit.persons].map(() => '?').join(',')})`).all(...visit.persons).map(p => p.name)
        : []
      const detail = [
        `visit ${durationS}s`,
        personNames.length ? `with ${personNames.join(', ')}` : (visit.peakCount > 0 ? `${visit.peakCount} unknown person(s)` : 'no person evidence retained'),
        `${visit.memberIds.length} linked event(s)`,
        reason === 'gap' ? 'ended when the scene went quiet' : `ended by ${reason}`,
      ].join(' · ')
      // link the opening event (it predates the member list)
      db.prepare('UPDATE events SET correlation_id = ? WHERE correlation_id IS NULL AND id IN (%s)'
        .replace('%s', visit.memberIds.map(() => '?').join(',') || 'NULL'))
        .run(visit.id, ...visit.memberIds)
      const summary = publishEvent('visit.summary', visit.cameraId, detail, {
        correlationId: visit.id,
        zone: [...visit.zones][0] ?? null,
        thumbPath: visit.firstThumb,
      })
      db.prepare('UPDATE events SET correlation_id = ? WHERE id = ?').run(visit.id, summary.id)
      log.info(`visit: closed ${visit.id} (${detail})`)
    } catch (error) {
      log.warn(`visit close failed (${visit.id}): ${error.message}`)
    }
  }

  status() {
    return {
      openVisits: [...this.open.values()].map(v => ({
        cameraId: v.cameraId,
        id: v.id,
        openedAt: v.openedAt,
        events: v.memberIds.length,
        persons: v.persons.size,
      })),
    }
  }
}
