/**
 * SceneState — structured, continuously updated representation of what a
 * camera currently observes. Built from tracker output + detection streams;
 * freshness is explicit: queries report the age of the last observation and
 * treat stale state as unknown rather than current.
 */

const STALE_AFTER_MS = 10_000

export class SceneState {
  constructor(cameraId) {
    this.cameraId = cameraId
    this.online = false
    this.persons = []          // [{trackId, familiar: null|{personId,name,score}, score, since, direction}]
    this.objects = new Map()   // label -> count
    this.zonesActive = new Set()
    this.lastChangeAt = null
    this.lastChange = null
    this.lastMovementAt = null
    this.updatedAt = 0
    this.fps = null
  }

  /**
   * Apply tracker output for one frame.
   * @param liveTracks [{trackId,label,score,zones,state,sinceAgeMs,direction}]
   * @param familiarById Map trackId → {personId, name, score}
   * @param opts {online, fps, lastMovementAt}
   */
  observe(liveTracks, familiarById = null, { online = true, fps = null, lastMovementAt = null } = {}) {
    this.online = online
    this.fps = fps
    if (lastMovementAt) this.lastMovementAt = lastMovementAt
    const persons = []
    const objects = new Map()
    const zones = new Set()
    for (const t of liveTracks) {
      if (t.label === 'person') {
        const familiar = familiarById?.get(t.trackId) ?? null
        persons.push({
          trackId: t.trackId,
          familiar,
          known: Boolean(familiar),
          score: t.score,
          direction: t.direction ?? 'stationary',
          since: new Date(Date.now() - Math.max(0, t.sinceAgeMs ?? 0)).toISOString(),
        })
      } else {
        objects.set(t.label, (objects.get(t.label) ?? 0) + 1)
      }
      for (const z of t.zones ?? []) zones.add(z)
    }
    const changed =
      JSON.stringify(this.persons?.map(p => [p.trackId, p.known])) !== JSON.stringify(persons.map(p => [p.trackId, p.known])) ||
      [...this.objects.keys()].sort().join() !== [...objects.keys()].sort().join() ||
      [...this.zonesActive].sort().join() !== [...zones].sort().join()
    this.persons = persons
    this.objects = objects
    this.zonesActive = zones
    this.updatedAt = Date.now()
    if (changed) {
      this.lastChangeAt = new Date().toISOString()
      this.lastChange = describeChange(this)
    }
  }

  setOnline(online) {
    if (this.online !== online) {
      this.online = online
      this.lastChangeAt = new Date().toISOString()
      this.lastChange = online ? 'camera online' : 'camera offline'
    }
  }

  /**
   * Snapshot for queries. Staleness is explicit: `fresh: false` when the
   * last observation is older than STALE_AFTER_MS — answers must say so.
   */
  snapshot() {
    const ageMs = this.updatedAt ? Date.now() - this.updatedAt : null
    const fresh = this.online && ageMs !== null && ageMs < STALE_AFTER_MS
    return {
      cameraId: this.cameraId,
      online: this.online,
      fresh,
      observationAgeMs: ageMs,
      persons: fresh ? this.persons : [],
      personCount: fresh ? this.persons.length : null,
      knownPersons: fresh ? this.persons.filter(p => p.known).map(p => ({ name: p.familiar.name, score: p.familiar.score })) : [],
      unknownPersons: fresh ? this.persons.filter(p => !p.known).length : null,
      objects: fresh ? Object.fromEntries(this.objects) : {},
      zonesActive: fresh ? [...this.zonesActive] : [],
      lastMovementAt: this.lastMovementAt,
      lastChange: this.lastChange,
      lastChangeAt: this.lastChangeAt,
      fps: this.fps,
    }
  }
}

function describeChange(scene) {
  const known = scene.persons.filter(p => p.known).map(p => p.familiar.name)
  const unknown = scene.persons.length - known.length
  const parts = []
  if (known.length) parts.push(`${known.join(' and ')} present`)
  if (unknown > 0) parts.push(`${unknown} unknown person${unknown > 1 ? 's' : ''} present`)
  for (const [label, n] of scene.objects) parts.push(`${n} ${label}(s)`)
  if (!parts.length) parts.push('scene empty')
  if (scene.zonesActive.size) parts.push(`zone: ${[...scene.zonesActive].join(', ')}`)
  return parts.join(' · ')
}
