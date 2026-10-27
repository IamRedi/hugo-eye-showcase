import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { db } from './db.js'
import { config } from './config.js'
import { log } from './log.js'
import { getProductSettings } from './settings.js'
import { eventBus } from './eventbus.js'
import { CLIPEmbedder, clipAvailable, cosineSimilarity } from './ai/clip.js'

/**
 * Semantic event search (Gate 4) — a searchable visual history.
 *
 * Every evidence-bearing event thumbnail is embedded with CLIP (image-text
 * space), so a natural-language query ("someone entered carrying something")
 * ranks REAL evidence images. No fabricated matches: results are existing
 * events, each with its thumbnail, score, provenance and — when a recording
 * covers the event time — the recording group for direct playback.
 *
 * Index discipline:
 *  - only events with an available evidence image are indexed
 *  - indexing is asynchronous (bounded queue, newest first); it never blocks
 *    detection, media or the API
 *  - re-index is idempotent (event_id is the key); delete cascades via FK
 *  - searches report the model that produced the embeddings (provenance)
 */

const SEARCHABLE_TYPES = new Set(['person', 'person_known', 'person_unknown', 'recognition_uncertain', 'object', 'snapshot', 'patrol.capture'])
const EMBED_MODEL = 'clip-vit-base-patch32'

export class SearchIndexer {
  constructor() {
    this.embedder = new CLIPEmbedder()
    this.queue = []            // eventIds, newest first
    this.queued = new Set()
    this.running = false
    this.stats = { indexed: 0, failed: 0, skipped: 0, lastError: null, lastIndexedAt: null }
    this.handler = event => this.consider(event)
    eventBus.on('event', this.handler)
  }

  availability() {
    return { ...clipAvailable(), enabled: getProductSettings().aiEnabled }
  }

  stop() {
    eventBus.off('event', this.handler)
    this.queue = []
    this.queued.clear()
  }

  /** Queue one event for indexing when it carries usable evidence. */
  consider(event) {
    if (!SEARCHABLE_TYPES.has(event.type)) return
    if (!clipAvailable().runtime || !clipAvailable().model) return
    const row = db.prepare('SELECT thumb_path, at FROM events WHERE id = ?').get(event.id)
    if (!row?.thumb_path || !fs.existsSync(row.thumb_path)) return
    this.enqueue(event.id)
  }

  enqueue(eventId) {
    if (this.queued.has(eventId)) return
    this.queued.add(eventId)
    this.queue.unshift(eventId)          // newest first
    if (this.queue.length > 64) this.queued.delete(this.queue.pop())   // bounded
    this._drain()
  }

  async _drain() {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const eventId = this.queue.pop()
        if (eventId === undefined) break
        this.queued.delete(eventId)
        try {
          const ok = await this.indexEvent(eventId)
          if (ok) this.stats.indexed += 1
          else this.stats.skipped += 1
        } catch (error) {
          this.stats.failed += 1
          this.stats.lastError = error.message
          log.warn(`search index: event ${eventId} failed: ${error.message}`)
        }
      }
    } finally {
      this.running = false
    }
  }

  /** Embed one event's evidence image; idempotent. Returns true when indexed. */
  async indexEvent(eventId) {
    const row = db.prepare('SELECT id, thumb_path, at FROM events WHERE id = ?').get(eventId)
    if (!row) return false
    if (!row.thumb_path || !fs.existsSync(row.thumb_path)) return false
    const existing = db.prepare('SELECT event_id FROM event_embeddings WHERE event_id = ?').get(eventId)
    if (existing) return false
    const rgb = await decodeJpegToRgb(row.thumb_path)
    if (!rgb) return false
    const embedding = await this.embedder.embedRgb(rgb.rgb, rgb.width, rgb.height)
    db.prepare(`INSERT INTO event_embeddings (event_id, at, model, dim, embedding) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET at = excluded.at, model = excluded.model, dim = excluded.dim, embedding = excluded.embedding`)
      .run(eventId, row.at, EMBED_MODEL, embedding.length,
        Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength))
    this.stats.lastIndexedAt = new Date().toISOString()
    return true
  }

  /**
   * Backfill: index existing evidence-bearing events (oldest last so the
   * freshest become searchable first). Returns { indexed, considered }.
   */
  async backfill({ limit = 500 } = {}) {
    const rows = db.prepare(`SELECT id, thumb_path FROM events
        WHERE thumb_path IS NOT NULL AND type IN (${[...SEARCHABLE_TYPES].map(() => '?').join(',')})
        ORDER BY id DESC LIMIT ?`).all(...SEARCHABLE_TYPES, limit)
    let indexed = 0
    for (const row of rows) {
      try {
        if (await this.indexEvent(row.id)) indexed += 1
      } catch (error) {
        this.stats.failed += 1
        this.stats.lastError = error.message
      }
    }
    log.info(`search: backfill indexed ${indexed}/${rows.length} events`)
    return { indexed, considered: rows.length }
  }

  status() {
    const { n } = db.prepare('SELECT COUNT(*) n FROM event_embeddings').get()
    const { n: eventsWithThumb } = db.prepare(`SELECT COUNT(*) n FROM events WHERE thumb_path IS NOT NULL`).get()
    return {
      availability: this.availability(),
      embedder: this.embedder.status(),
      model: EMBED_MODEL,
      indexed: n,
      indexable: eventsWithThumb,
      queue: this.queue.length,
      stats: this.stats,
    }
  }
}

/**
 * Semantic search over indexed events. Query with natural language; combine
 * with hard filters. Results are real events with provenance and scores.
 */
export async function searchEvents(searchIndexer, { q = null, cameraId = null, type = null, personId = null, from = null, to = null, limit = 60 } = {}) {
  const filters = []
  const params = []
  let where = ''
  if (cameraId) { filters.push('e.camera_id = ?'); params.push(cameraId) }
  if (type) { filters.push('e.type = ?'); params.push(type) }
  if (personId) { filters.push('e.person_id = ?'); params.push(personId) }
  if (from) { filters.push('e.at >= ?'); params.push(from) }
  if (to) { filters.push('e.at <= ?'); params.push(to) }
  if (filters.length) where = `WHERE ${filters.join(' AND ')}`

  const rows = db.prepare(`SELECT e.id, e.at, e.type, e.camera_id, e.detail, e.confidence,
        e.thumb_path, e.person_id, e.zone, e.description, x.embedding
      FROM event_embeddings x JOIN events e ON e.id = x.event_id
      LEFT JOIN people p ON p.id = e.person_id ${where}
      ORDER BY e.at DESC LIMIT 2000`).all(...params)

  // attach person names
  const personNames = new Map(db.prepare('SELECT id, name FROM people').all().map(r => [r.id, r.name]))

  let results
  const queryText = q && String(q).trim()
  if (queryText) {
    const queryVec = await embedQuery(searchIndexer, queryText)
    if (!queryVec) return { ok: false, error: 'search index unavailable (CLIP not installed?)', results: [] }
    results = rows.map(r => ({
      row: r,
      score: cosineSimilarity(queryVec, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)),
    })).sort((a, b) => b.score - a.score)
  } else {
    results = rows.map(r => ({ row: r, score: null }))
  }

  return {
    ok: true,
    query: q ?? null,
    model: EMBED_MODEL,
    scanned: rows.length,
    results: results.slice(0, Math.min(200, limit)).map(({ row: r, score }) => ({
      id: r.id,
      at: r.at,
      type: r.type,
      cameraId: r.camera_id,
      detail: r.detail,
      confidence: r.confidence,
      thumbUrl: r.thumb_path ? `/api/events/${r.id}/thumb` : null,
      personId: r.person_id,
      personName: r.person_id ? (personNames.get(r.person_id) ?? null) : null,
      zone: r.zone,
      description: r.description,
      score: score === null ? null : Number(score.toFixed(4)),
      provenance: 'indexed evidence image',
      recording: recordingCovering(r.camera_id, r.at),
    })),
  }
}

// query embedding cache (identical queries are common while browsing)
let queryCache = { text: null, vec: null, at: 0 }
async function embedQuery(searchIndexer, text) {
  if (queryCache.text === text && Date.now() - queryCache.at < 5 * 60 * 1000) return queryCache.vec
  const vec = await searchIndexer.embedder.embedText(text)
  queryCache = { text, vec, at: Date.now() }
  return vec
}

/** Newest recording segment whose time window covers `at` (or the nearest group). */
function recordingCovering(cameraId, at) {
  const row = db.prepare(`SELECT group_id, MIN(started_at) AS start, MAX(coalesce(ended_at, started_at)) AS end
      FROM recordings WHERE camera_id = ? AND started_at <= ? AND coalesce(ended_at, started_at) >= ?
      GROUP BY group_id LIMIT 1`).get(cameraId, at, at)
  if (row) return { groupId: row.group_id, start: row.start, end: row.end, covering: true }
  // nearest group within ±5 minutes (context playback)
  const near = db.prepare(`SELECT group_id, MIN(started_at) AS start, MAX(coalesce(ended_at, started_at)) AS end
      FROM recordings WHERE camera_id = ? AND started_at <= ? GROUP BY group_id
      ORDER BY start DESC LIMIT 1`).get(cameraId, at)
  if (near && (new Date(at) - new Date(near.end)) < 5 * 60 * 1000) {
    return { groupId: near.group_id, start: near.start, end: near.end, covering: false }
  }
  return null
}

/** Decode a JPEG to raw RGB via ffmpeg (ffprobe for dimensions). */
function decodeJpegToRgb(jpegPath) {
  return new Promise(resolve => {
    const probe = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', jpegPath],
      { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    probe.stdout.on('data', c => { out += c.toString() })
    probe.on('error', () => resolve(null))
    probe.on('close', () => {
      const [w, h] = out.trim().split('x').map(Number)
      if (!(w > 0 && h > 0)) return resolve(null)
      const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
        '-i', jpegPath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
        { stdio: ['ignore', 'pipe', 'ignore'] })
      const chunks = []
      child.stdout.on('data', c => chunks.push(c))
      child.on('error', () => resolve(null))
      child.on('close', () => {
        const raw = Buffer.concat(chunks)
        const expected = w * h * 3
        resolve(raw.length >= expected ? { rgb: raw.subarray(0, expected), width: w, height: h } : null)
      })
    })
  })
}
