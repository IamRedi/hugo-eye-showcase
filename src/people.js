import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { db, newId } from './db.js'
import { config } from './config.js'
import { log } from './log.js'
import { getProductSettings } from './settings.js'
import { FaceEmbedder, cosineSimilarity, DEFAULT_MATCH_THRESHOLD, UNCERTAIN_MARGIN, MIN_FACE_PX } from './ai/faceEmbed.js'

/** Quality gates for enrollment images (heuristic, calibrated for 112px+ crops). */
const MIN_BRIGHTNESS = 40
const MAX_BRIGHTNESS = 235
const MIN_SHARPNESS = 35   // Laplacian variance; below = visibly blurry

/**
 * Brightness + sharpness of a face region (RGB buffer). Sharpness is the
 * variance of the Laplacian on the gray crop — the standard blur metric.
 */
export function analyzeImageQuality(rgb, width, height, box = null) {
  const x0 = box ? Math.max(0, Math.floor(box.x)) : 0
  const y0 = box ? Math.max(0, Math.floor(box.y)) : 0
  const x1 = box ? Math.min(width, Math.ceil(box.x + box.w)) : width
  const y1 = box ? Math.min(height, Math.ceil(box.y + box.h)) : height
  const w = x1 - x0
  const h = y1 - y0
  if (w < 8 || h < 8) return { ok: false, error: 'face region too small to assess quality' }
  const gray = new Float32Array(w * h)
  let sum = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = ((y0 + y) * width + (x0 + x)) * 3
      const g = (rgb[j] * 77 + rgb[j + 1] * 150 + rgb[j + 2] * 29) >> 8
      gray[y * w + x] = g
      sum += g
    }
  }
  const brightness = sum / (w * h)
  if (brightness < MIN_BRIGHTNESS) return { ok: false, brightness: Math.round(brightness), error: 'image too dark — add light or use a better exposure' }
  if (brightness > MAX_BRIGHTNESS) return { ok: false, brightness: Math.round(brightness), error: 'image overexposed — reduce light or avoid direct illumination' }
  // Laplacian variance (interior pixels only)
  let lSum = 0
  let lSum2 = 0
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const c = gray[y * w + x]
      const lap = 4 * c - gray[y * w + x - 1] - gray[y * w + x + 1] - gray[(y - 1) * w + x] - gray[(y + 1) * w + x]
      lSum += lap
      lSum2 += lap * lap
      n += 1
    }
  }
  const mean = lSum / n
  const sharpness = lSum2 / n - mean * mean
  const result = { ok: true, brightness: Math.round(brightness), sharpness: Math.round(sharpness) }
  if (sharpness < MIN_SHARPNESS) return { ...result, ok: false, error: 'image too blurry — hold still and use a sharp reference photo' }
  return result
}

/**
 * People registry — local, owner-controlled familiar-face profiles.
 *
 * Privacy invariants:
 *  - Enrollment is ALWAYS owner-driven (uploaded images or camera snapshots);
 *    unknown persons are never auto-labeled.
 *  - Embeddings are stored only for enrolled reference images.
 *  - Deleting a profile deletes its reference images and embeddings.
 *  - Recognition runs only when privacy.familiarFaceEnabled is true AND the
 *    profile is enabled — and everything stays on this machine.
 */

export class PeopleRegistry {
  constructor() {
    this.embedder = new FaceEmbedder()
  }

  list() {
    const rows = db.prepare(`
      SELECT p.id, p.name, p.notes, p.enabled, p.created_at, p.updated_at,
             count(f.id) AS referenceCount
      FROM people p LEFT JOIN face_images f ON f.person_id = p.id
      GROUP BY p.id ORDER BY p.name`).all()
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      notes: r.notes,
      enabled: Boolean(r.enabled),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      referenceCount: r.referenceCount,
      references: this.references(r.id),
    }))
  }

  get(id) {
    const row = db.prepare('SELECT * FROM people WHERE id = ?').get(id)
    if (!row) return null
    return {
      id: row.id, name: row.name, notes: row.notes, enabled: Boolean(row.enabled),
      createdAt: row.created_at, updatedAt: row.updated_at,
      references: this.references(id),
    }
  }

  references(personId) {
    return db.prepare(`SELECT id, image_path, quality, source, created_at
        FROM face_images WHERE person_id = ? ORDER BY created_at`).all(personId)
      .map(r => ({
        id: r.id,
        imageUrl: `/api/people/reference-image/${r.id}`,
        quality: r.quality,
        source: r.source,
        createdAt: r.created_at,
      }))
  }

  create({ name, notes = '' }) {
    const now = new Date().toISOString()
    const id = newId()
    db.prepare('INSERT INTO people (id, name, notes, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
      .run(id, String(name).slice(0, 80), String(notes).slice(0, 500), now, now)
    return this.get(id)
  }

  update(id, { name, notes, enabled }) {
    const existing = this.get(id)
    if (!existing) return null
    db.prepare('UPDATE people SET name = ?, notes = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(
        typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : existing.name,
        typeof notes === 'string' ? notes.slice(0, 500) : existing.notes,
        typeof enabled === 'boolean' ? (enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
        new Date().toISOString(), id,
      )
    return this.get(id)
  }

  remove(id) {
    const refs = db.prepare('SELECT id, image_path FROM face_images WHERE person_id = ?').all(id)
    for (const ref of refs) {
      try { fs.unlinkSync(ref.image_path) } catch { /* gone */ }
    }
    const info = db.prepare('DELETE FROM face_images WHERE person_id = ?').run(id)
    db.prepare('DELETE FROM people WHERE id = ?').run(id)
    log.info(`people: removed profile ${id} (${info.changes} profile, ${refs.length} references)`)
    return refs.length
  }

  removeReference(personId, referenceId) {
    const row = db.prepare('SELECT id, image_path FROM face_images WHERE id = ? AND person_id = ?').get(referenceId, personId)
    if (!row) return false
    try { fs.unlinkSync(row.image_path) } catch { /* gone */ }
    db.prepare('DELETE FROM face_images WHERE id = ?').run(referenceId)
    return true
  }

  referenceImagePath(referenceId) {
    const row = db.prepare('SELECT image_path FROM face_images WHERE id = ?').get(referenceId)
    return row?.image_path ?? null
  }

  /**
   * Enroll one face image: detect the face, gate on quality, embed, store.
   * Returns { ok, quality } or { ok: false, error } with an honest reason.
   * Quality gates: face size, brightness (low-light guard), sharpness
   * (blur guard) — a reference that fails them would poison recognition.
   */
  async enroll(personId, jpeg, { source = 'upload' } = {}) {
    const person = this.get(personId)
    if (!person) return { ok: false, error: 'profile not found' }
    const { FaceDetector } = await import('./ai/faceDetect.js')
    const detector = new FaceDetector({ scoreThreshold: 0.5 })
    // decode the JPEG to RGB via ffmpeg (reuse the snapshot decoder path)
    const img = await jpegToRgb(jpeg)
    const faces = await detector.detect(img.rgb, img.width, img.height)
    if (faces.length === 0) return { ok: false, error: 'no face found in the image' }
    if (faces.length > 1) {
      // pick the largest face but tell the owner there was ambiguity
      faces.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
    }
    const face = faces[0]
    if (face.box.w < MIN_FACE_PX || face.box.h < MIN_FACE_PX) {
      return { ok: false, error: `face too small (${Math.round(face.box.w)}px, need ≥ ${MIN_FACE_PX}px) — use a closer photo` }
    }
    const qualityImage = analyzeImageQuality(img.rgb, img.width, img.height, face.box)
    if (!qualityImage.ok) return { ok: false, error: qualityImage.error, quality: qualityImage }
    const embedding = await this.embedder.embed(img.rgb, img.width, img.height, face)
    const refDir = path.join(config.storage.dataDir, 'people', personId)
    fs.mkdirSync(refDir, { recursive: true })
    const refId = newId()
    const imagePath = path.join(refDir, `${refId}.jpg`)
    fs.writeFileSync(imagePath, jpeg)
    const quality = face.score
    db.prepare(`INSERT INTO face_images (id, person_id, image_path, embedding, quality, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(refId, personId, imagePath, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), quality, source, new Date().toISOString())
    const referenceCount = db.prepare('SELECT COUNT(*) n FROM face_images WHERE person_id = ?').get(personId).n
    return {
      ok: true,
      referenceId: refId,
      quality,
      imageQuality: qualityImage,
      ambiguity: faces.length > 1,
      guidance: referenceCount < 3
        ? `${referenceCount} reference(s) enrolled — add at least ${3 - referenceCount} more from different angles for reliable recognition`
        : null,
    }
  }

  /**
   * Calibration support: embed a probe image and report its similarity to
   * every enrolled profile (no state changed). Used to tune matchThreshold
   * and to investigate suspected wrong matches with real numbers.
   */
  async scoreTest(jpeg) {
    const { FaceDetector } = await import('./ai/faceDetect.js')
    const detector = new FaceDetector({ scoreThreshold: 0.5 })
    const img = await jpegToRgb(jpeg)
    const faces = await detector.detect(img.rgb, img.width, img.height)
    if (faces.length === 0) return { ok: false, error: 'no face found in the image' }
    faces.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
    const face = faces[0]
    if (face.box.w < MIN_FACE_PX) return { ok: false, error: `face too small (${Math.round(face.box.w)}px)` }
    const embedding = await this.embedder.embed(img.rgb, img.width, img.height, face)
    const t = getProductSettings()?.face?.matchThreshold
    const scores = this.enrolledEmbeddings()
      .map(ref => ({ personId: ref.personId, name: ref.name, similarity: Number(cosineSimilarity(embedding, ref.embedding).toFixed(4)) }))
      .sort((a, b) => b.similarity - a.similarity)
    return {
      ok: true,
      ambiguity: faces.length > 1,
      imageQuality: analyzeImageQuality(img.rgb, img.width, img.height, face.box),
      threshold: t,
      scores,
    }
  }

  /**
   * Canonical embedding matcher (in-memory, used by the face pipeline).
   * Calibration: score ≥ threshold → match; within UNCERTAIN_MARGIN below
   * the threshold → uncertain; else unknown. Never returns a guessed name.
   */
  matchEmbedding(embedding, { threshold = null } = {}) {
    const enrolled = this.enrolledEmbeddings()
    if (enrolled.length === 0) return { unknown: { score: 0 } }
    const t = threshold ?? DEFAULT_MATCH_THRESHOLD
    let best = null
    for (const ref of enrolled) {
      const score = cosineSimilarity(embedding, ref.embedding)
      if (!best || score > best.score) best = { personId: ref.personId, name: ref.name, score }
    }
    if (best.score >= t) return { match: best }
    if (best.score >= t - UNCERTAIN_MARGIN) return { uncertain: best }
    return { unknown: { score: best.score } }
  }

  /** Raw embeddings for an optimized in-pipeline matcher (cache). */
  enrolledEmbeddings() {
    return db.prepare(`SELECT f.person_id, f.embedding, p.name FROM face_images f
        JOIN people p ON p.id = f.person_id WHERE p.enabled = 1`).all()
      .map(r => ({
        personId: r.person_id,
        name: r.name,
        embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
      }))
  }
}

/** Decode a JPEG to {rgb, width, height} (ffprobe for dims + ffmpeg rawvideo). */
async function jpegToRgb(jpeg) {
  const { spawn } = await import('node:child_process')
  const dims = await new Promise((resolve, reject) => {
    const probe = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', 'pipe:0'],
      { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    probe.stdout.on('data', c => { out += c.toString() })
    probe.on('close', code => {
      const [w, h] = out.trim().split('x').map(Number)
      if (code === 0 && w > 0 && h > 0) resolve({ width: w, height: h })
      else reject(new Error('could not read image dimensions'))
    })
    probe.on('error', reject)
    probe.stdin.write(jpeg)
    probe.stdin.end()
  })
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks = []
    child.stdout.on('data', c => chunks.push(c))
    child.on('close', code => {
      const raw = Buffer.concat(chunks)
      const expected = dims.width * dims.height * 3
      if (code !== 0 || raw.length < expected) return reject(new Error('jpeg decode failed'))
      resolve({ rgb: raw.subarray(0, expected), width: dims.width, height: dims.height })
    })
    child.on('error', reject)
    child.stdin.write(jpeg)
    child.stdin.end()
  })
}
