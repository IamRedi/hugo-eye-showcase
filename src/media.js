import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { db } from './db.js'
import { log } from './log.js'

/**
 * Media index: JPEG files under HUGO_EYE_MEDIA_DIR/<zone>/YYYY-MM-DD_HH-MM-SS.jpg.
 * The directory is the source of truth; the DB table is a derived index for
 * fast listing. Paths are always resolved inside the media root (traversal guard).
 */

const IMAGE_RE = /\.(jpe?g)$/i
const NAME_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.jpe?g$/i

export function mediaRoot() {
  return path.resolve(config.storage.mediaDir)
}

/** Resolves a zone-relative path and refuses anything escaping the media root. */
export function resolveMediaPath(relativePath) {
  const clean = decodeURIComponent(relativePath).replaceAll('\\', '/')
  const parts = clean.split('/').filter(Boolean)
  if (!IMAGE_RE.test(clean) || parts.length === 0 || parts.some(p => p === '.' || p === '..')) {
    throw new Error('invalid media path')
  }
  const root = mediaRoot()
  const resolved = path.resolve(root, ...parts)
  if (!resolved.startsWith(root + path.sep)) throw new Error('invalid media path')
  return resolved
}

/** Walks the media dir and upserts new files into the index. Cheap enough to run on demand. */
export function indexMedia(cameraId) {
  const root = mediaRoot()
  let added = 0
  let walked = 0
  walk(root, 0, rel => {
    walked += 1
    const abs = path.join(root, rel)
    const known = db.prepare('SELECT id FROM media WHERE path = ?').get(abs)
    if (known) return
    const zone = rel.includes(path.sep) ? rel.split(path.sep)[0] : 'root'
    let capturedAt = fs.statSync(abs).mtime.toISOString()
    const nameMatch = path.basename(rel).match(NAME_RE)
    if (nameMatch) {
      const [, y, mo, d, h, mi, s] = nameMatch
      capturedAt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).toISOString()
    }
    db.prepare(`INSERT INTO media (camera_id, zone, path, captured_at, size_bytes, source)
        VALUES (?, ?, ?, ?, ?, 'snapshot')
        ON CONFLICT(path) DO NOTHING`)
      .run(cameraId, zone, abs, capturedAt, fs.statSync(abs).size)
    added += 1
  })
  if (added > 0) log.info(`media index: +${added} new files (${walked} scanned)`)
  return { added, scanned: walked }
}

function walk(dir, depth, cb) {
  if (depth > 4) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, depth + 1, cb)
    else if (entry.isFile() && IMAGE_RE.test(entry.name)) cb(path.relative(mediaRoot(), abs))
  }
}

export function listMedia({ cameraId, zone = null, limit = 100 } = {}) {
  indexMedia(cameraId)
  const rows = zone
    ? db.prepare(`SELECT path, zone, captured_at, size_bytes FROM media
        WHERE camera_id = ? AND zone = ? ORDER BY captured_at DESC LIMIT ?`).all(cameraId, zone, limit)
    : db.prepare(`SELECT path, zone, captured_at, size_bytes FROM media
        WHERE camera_id = ? ORDER BY captured_at DESC LIMIT ?`).all(cameraId, limit)
  return rows.map(r => ({
    zone: r.zone,
    capturedAt: r.captured_at,
    sizeBytes: r.size_bytes,
    url: `/media/${path.relative(mediaRoot(), r.path).split(path.sep).map(encodeURIComponent).join('/')}`,
  }))
}

export function mediaZones(cameraId) {
  indexMedia(cameraId)
  return db.prepare(`SELECT zone, count(*) AS count, max(captured_at) AS latest
      FROM media WHERE camera_id = ? GROUP BY zone ORDER BY zone`).all(cameraId)
}
