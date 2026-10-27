import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { loadSession } from './sessions.mjs'
import { FaceEmbedder } from './faceEmbed.js'

/**
 * YuNet face detection (opencv_zoo, Apache-2.0) — port of the reference
 * decode in OpenCV's modules/objdetect/src/face_detect.cpp.
 *
 * I/O contract (verified against the reference):
 *  - input: 1×3×padH×padW, BGR planes, values 0..255, padded to a multiple of 32
 *  - outputs per stride (8/16/32): cls [r×c], obj [r×c], bbox [r×c×4],
 *    kps [r×c×10] (NHWC-style flat indexing — matches the C++ reference)
 *  - score = sqrt(clamp(cls) · clamp(obj)); box/landmark decode relative to
 *    the cell (r, c) in padded pixels; NMS afterwards.
 */

const STRIDES = [8, 16, 32]
const OUTPUT_NAMES = [
  'cls_8', 'cls_16', 'cls_32',
  'obj_8', 'obj_16', 'obj_32',
  'bbox_8', 'bbox_16', 'bbox_32',
  'kps_8', 'kps_16', 'kps_32',
]

export class FaceDetector {
  constructor({ scoreThreshold = 0.6, nmsThreshold = 0.35 } = {}) {
    this.scoreThreshold = scoreThreshold
    this.nmsThreshold = nmsThreshold
    this.session = null
    this.ort = null
    this.inputName = null
  }

  static modelPath() {
    return path.join(config.storage.dataDir, 'models', 'face_detection_yunet_2023mar.onnx')
  }

  static available() {
    return fs.existsSync(this.modelPath())
  }

  async ensure() {
    if (this.session) return
    if (!FaceDetector.available()) throw new Error('YuNet model not installed (npm run ai:setup)')
    const loaded = await loadSession(FaceDetector.modelPath())
    this.ort = loaded.ort
    this.session = loaded.session
    this.inputName = this.session.inputNames[0]
  }

  /**
   * Detect faces in one RGB frame of ANY size. The ONNX export has a fixed
   * 640×640 input, so the frame is stretched to the model size and all
   * results are mapped back with the independent x/y scale factors.
   * @returns [{box:{x,y,w,h} (pixels, original frame), score, landmarks:[{x,y}×5]}]
   */
  async detect(rgb, width, height, { scoreThreshold = this.scoreThreshold } = {}) {
    await this.ensure()
    const S = 640
    const scaleX = width / S
    const scaleY = height / S
    // nearest-neighbor stretch to the model input (detection-robust)
    const bgr = new Uint8Array(S * S * 3)
    for (let y = 0; y < S; y++) {
      const sy = Math.min(height - 1, Math.floor(y * scaleY)) * width * 3
      for (let x = 0; x < S; x++) {
        const s = sy + Math.min(width - 1, Math.floor(x * scaleX)) * 3
        const d = (y * S + x) * 3
        bgr[d] = rgb[s + 2]
        bgr[d + 1] = rgb[s + 1]
        bgr[d + 2] = rgb[s]
      }
    }
    const data = new Float32Array(3 * S * S)
    const plane = S * S
    for (let i = 0, j = 0; i < plane; i++, j += 3) {
      data[i] = bgr[j]
      data[plane + i] = bgr[j + 1]
      data[2 * plane + i] = bgr[j + 2]
    }
    const input = new this.ort.Tensor('float32', data, [1, 3, S, S])
    const feeds = { [this.inputName]: input }
    for (const name of this.session.inputNames) if (name !== this.inputName) feeds[name] = input
    const results = await this.session.run(feeds)

    const padW = S
    const padH = S
    const faces = []
    for (let si = 0; si < STRIDES.length; si++) {
      const stride = STRIDES[si]
      const cols = Math.floor(padW / stride)
      const rows = Math.floor(padH / stride)
      const cls = results[OUTPUT_NAMES[si]]?.data
      const obj = results[OUTPUT_NAMES[3 + si]]?.data
      const bbox = results[OUTPUT_NAMES[6 + si]]?.data
      const kps = results[OUTPUT_NAMES[9 + si]]?.data
      if (!cls || !obj || !bbox || !kps) continue
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c
          const score = Math.sqrt(clamp(cls[idx]) * clamp(obj[idx]))
          if (score < scoreThreshold) continue
          const cx = (c + bbox[idx * 4 + 0]) * stride
          const cy = (r + bbox[idx * 4 + 1]) * stride
          const w = Math.exp(bbox[idx * 4 + 2]) * stride
          const h = Math.exp(bbox[idx * 4 + 3]) * stride
          const landmarks = []
          for (let n = 0; n < 5; n++) {
            landmarks.push({
              x: (kps[idx * 10 + 2 * n] + c) * stride,
              y: (kps[idx * 10 + 2 * n + 1] + r) * stride,
            })
          }
          faces.push({
            box: { x: (cx - w / 2) * scaleX, y: (cy - h / 2) * scaleY, w: w * scaleX, h: h * scaleY },
            score,
            landmarks: landmarks.map(l => ({ x: l.x * scaleX, y: l.y * scaleY })),
          })
        }
      }
    }
    return nmsBoxes(faces, this.nmsThreshold)
  }
}

function clamp(v) { return Math.min(1, Math.max(0, v)) }

export function nmsBoxes(faces, nmsThreshold) {
  faces.sort((a, b) => b.score - a.score)
  const kept = []
  for (const f of faces) {
    if (kept.every(k => boxIou(k.box, f.box) < nmsThreshold)) kept.push(f)
  }
  return kept
}

function boxIou(a, b) {
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.w, b.x + b.w)
  const y1 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  return inter / (a.w * a.h + b.w * b.h - inter)
}

/** Cheap availability check (model files present) without loading runtime. */
export function aiFacesAvailable() {
  return FaceDetector.available() && FaceEmbedder.available()
}

