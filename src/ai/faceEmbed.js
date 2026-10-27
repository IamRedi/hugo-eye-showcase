import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { loadSession } from './sessions.mjs'

/**
 * SFace face embeddings (opencv_zoo, Apache-2.0).
 *
 * Pipeline: 5-point landmark alignment (least-squares similarity transform to
 * the standard ArcFace reference) → 112×112 warp (bilinear) → BGR→RGB
 * normalized tensor → 128-D embedding. Matching: cosine similarity with a
 * calibrated threshold (model card: 0.363 genuine/imposter boundary).
 */

const REFERENCE = [   // standard 5-point reference for 112×112 aligned crops
  [38.2946, 51.696],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
]

export const DEFAULT_MATCH_THRESHOLD = 0.363
export const UNCERTAIN_MARGIN = 0.08   // accept ≥ t, uncertain within [t, t+margin]

export class FaceEmbedder {
  constructor() {
    this.session = null
    this.ort = null
    this.inputName = null
    this.lastLatencyMs = 0
  }

  static modelPath() {
    return path.join(config.storage.dataDir, 'models', 'face_recognition_sface_2021dec.onnx')
  }

  static available() {
    return fs.existsSync(this.modelPath())
  }

  async ensure() {
    if (this.session) return
    if (!FaceEmbedder.available()) throw new Error('SFace model not installed (npm run ai:setup)')
    const loaded = await loadSession(FaceEmbedder.modelPath())
    this.ort = loaded.ort
    this.session = loaded.session
    this.inputName = this.session.inputNames[0]
  }

  /** Embed one detected face given its landmarks. Returns Float32Array(128). */
  async embed(rgb, width, height, face) {
    await this.ensure()
    const t0 = Date.now()
    const crop = alignCrop(rgb, width, height, face.landmarks)
    if (!crop) throw new Error('face crop outside frame')
    // Empirically calibrated against the export: raw 0..255 RGB (the ONNX
    // graph normalizes internally). Verified: same face ≈ 1.0, different
    // faces < 0.2 — the ±1 normalization variants collapsed all faces to
    // ~0.95 mutual similarity (undiscriminating).
    const data = new Float32Array(3 * 112 * 112)
    const plane = 112 * 112
    for (let i = 0, j = 0; i < plane; i++, j += 3) {
      data[i] = crop[j + 2]        // R
      data[plane + i] = crop[j + 1] // G
      data[2 * plane + i] = crop[j] // B
    }
    const input = new this.ort.Tensor('float32', data, [1, 3, 112, 112])
    const results = await this.session.run({ [this.inputName]: input })
    this.lastLatencyMs = Date.now() - t0
    const out = results[this.session.outputNames[0]]
    const embedding = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data)
    return embedding
  }
}

/** Cosine similarity of two embeddings. */
export function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

/** Minimum crop size for a usable embedding (quality gate). */
export const MIN_FACE_PX = 48

/**
 * Least-squares similarity transform (rotation+scale+translation, no
 * reflection) mapping `reference` points onto `detected` points, then
 * inverse-sampling the 112×112 aligned crop with bilinear filtering.
 */
export function alignCrop(rgb, width, height, landmarks) {
  if (!landmarks || landmarks.length !== 5) return null
  const m = similarityTransform(REFERENCE, landmarks)
  if (!m) return null
  const crop = Buffer.alloc(112 * 112 * 3)
  const [a, b, tx, ty] = m
  // The transform maps reference-grid points onto detected landmarks, and the
  // crop grid IS the reference grid — so sample with the FORWARD map.
  for (let y = 0; y < 112; y++) {
    for (let x = 0; x < 112; x++) {
      const sx = a * x - b * y + tx
      const sy = b * x + a * y + ty
      if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) continue
      const x0 = Math.floor(sx), y0 = Math.floor(sy)
      const x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1)
      const fx = sx - x0, fy = sy - y0
      const dst = (y * 112 + x) * 3
      for (let ch = 0; ch < 3; ch++) {
        const p00 = rgb[(y0 * width + x0) * 3 + ch]
        const p10 = rgb[(y0 * width + x1) * 3 + ch]
        const p01 = rgb[(y1 * width + x0) * 3 + ch]
        const p11 = rgb[(y1 * width + x1) * 3 + ch]
        crop[dst + ch] = (p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy) | 0
      }
    }
  }
  return crop
}

/**
 * Fit similarity transform mapping `ref` → `det` in least-squares sense:
 *   det.x ≈ a·ref.x − b·ref.y + tx ; det.y ≈ b·ref.x + a·ref.y + ty
 * Returns [a, b, tx, ty] or null when degenerate.
 */
export function similarityTransform(ref, det) {
  const pt = p => Array.isArray(p) ? p : [p.x, p.y]
  let sx = 0, sy = 0, dx = 0, dy = 0
  const n = ref.length
  for (let i = 0; i < n; i++) {
    sx += ref[i][0]; sy += ref[i][1]
    dx += pt(det[i])[0]; dy += pt(det[i])[1]
  }
  sx /= n; sy /= n; dx /= n; dy /= n
  let num = 0, denom = 0
  for (let i = 0; i < n; i++) {
    const rx = ref[i][0] - sx, ry = ref[i][1] - sy
    const dxi = pt(det[i])[0] - dx, dyi = pt(det[i])[1] - dy
    num += (rx * dxi + ry * dyi)
    denom += rx * rx + ry * ry
  }
  if (denom < 1e-8) return null
  const a = num / denom
  let bnum = 0
  for (let i = 0; i < n; i++) {
    const rx = ref[i][0] - sx, ry = ref[i][1] - sy
    bnum += (rx * (pt(det[i])[1] - dy) - ry * (pt(det[i])[0] - dx))
  }
  const b = bnum / denom
  const tx = dx - (a * sx - b * sy)
  const ty = dy - (b * sx + a * sy)
  return [a, b, tx, ty]
}
