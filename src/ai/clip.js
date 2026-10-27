import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { log } from '../log.js'

/**
 * CLIPEmbedder — local image-text embeddings for semantic search (Gate 4).
 *
 * Model: CLIP ViT-B/32 (quantized ONNX, Apache-2.0) with both encoders in a
 * single session (inputs: input_ids, pixel_values, attention_mask; outputs:
 * text_embeds, image_embeds). Images and text map into one 512-dim space —
 * a text query ranks real event thumbnails without any generic text-embedding
 * approximation.
 *
 * Runs on onnxruntime-node (optional dependency, CPU). All inference stays
 * on this machine.
 */

const MODEL_REL = path.join('models', 'clip-vit-base-patch32-q.onnx')
const VOCAB_REL = path.join('models', 'clip-vocab.json')
const MERGES_REL = path.join('models', 'clip-merges.txt')
const CONTEXT = 77
const IMAGE_SIZE = 224
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073]
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711]
const SOT_ID = 49406
const EOT_ID = 49407
const BLANK_TEXT_IDS = (() => { const a = new BigInt64Array(CONTEXT); a[0] = BigInt(SOT_ID); a[1] = BigInt(EOT_ID); return a })()
const BLANK_TEXT_ATTN = (() => { const a = new BigInt64Array(CONTEXT); a[0] = 1n; a[1] = 1n; return a })()

/** CLIP's byte-level BPE mapping (identical to GPT-2). */
function bytesToUnicode() {
  const bs = [...Array.from({ length: 256 }, (_, i) => i)]
  let cs = [...bs]
  // printable ranges kept as-is; the rest remapped to 256+n
  const kept = []
  for (const b of bs) {
    if ((b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255)) kept.push(b)
  }
  const shifted = bs.filter(b => !kept.includes(b))
  cs = [...kept, ...shifted.map(b => b + 256)]
  const map = new Map()
  for (let i = 0; i < 256; i++) map.set(bs[i], cs[i])
  return map
}

const BYTE_ENCODER = bytesToUnicode()

export function clipTokens(text) {
  return [...Buffer.from(text, 'utf8')].map(b => BYTE_ENCODER.get(b))
}

export class ClipTokenizer {
  constructor(vocab, merges) {
    this.encoder = new Map(Object.entries(vocab).map(([k, v]) => [k, v]))
    this.decoder = new Map([...this.encoder].map(([k, v]) => [v, k]))
    this.ranks = new Map(merges.map((line, i) => [line, i]))
    this.cache = new Map()
    this.sot = this.encoder.get('<|startoftext|>')
    this.eot = this.encoder.get('<|endoftext|>')
  }

  static async load() {
    const vocab = JSON.parse(fs.readFileSync(path.join(config.storage.dataDir, VOCAB_REL), 'utf8'))
    const merges = fs.readFileSync(path.join(config.storage.dataDir, MERGES_REL), 'utf8')
      .split('\n').slice(1)   // drop "#version" header
      .filter(l => l.trim().length > 0)
    return new ClipTokenizer(vocab, merges)
  }

  _bpe(token) {
    if (this.cache.has(token)) return this.cache.get(token)
    let word = token.split('')
    // the end-of-word marker joins the last character (GPT-2 convention)
    word = [...word.slice(0, -1), word[word.length - 1] + '</w>']
    for (;;) {
      let best = null
      let bestRank = Infinity
      for (let i = 0; i < word.length - 1; i++) {
        const rank = this.ranks.get(`${word[i]} ${word[i + 1]}`)
        if (rank !== undefined && rank < bestRank) { best = i; bestRank = rank }
      }
      if (best === null) break
      word = [...word.slice(0, best), word[best] + word[best + 1], ...word.slice(best + 2)]
    }
    const ids = word.map(t => this.encoder.get(t)).filter(v => v !== undefined)
    this.cache.set(token, ids)
    return ids
  }

  /**
   * Encode to a fixed [1, 77] int32 tensor payload (token ids + attention).
   * Preprocessing mirrors OpenAI's CLIP: lowercase, squeeze whitespace,
   * regex split (contractions/letters/digits/punct), byte-level BPE.
   */
  encode(text, { context = CONTEXT } = {}) {
    const cleaned = String(text).toLowerCase().replace(/\s+/g, ' ').trim()
    const pattern = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/gu
    const ids = [this.sot]
    for (const token of cleaned.match(pattern) ?? []) {
      for (const id of this._bpe(token)) ids.push(id)
      if (ids.length >= context - 1) break
    }
    const trimmed = ids.slice(0, context - 1)
    trimmed.push(this.eot)
    const input = new BigInt64Array(context)
    const attention = new BigInt64Array(context)
    trimmed.forEach((v, i) => { input[i] = BigInt(v); attention[i] = 1n })
    return { input, attention }
  }
}

/** Minimal session cache shared with the other AI providers. */
let sessionPromise = null
let tokenizerPromise = null

export function clipAvailable() {
  let runtime = false
  try {
    createRequire(import.meta.url).resolve('onnxruntime-node')
    runtime = true
  } catch { /* not installed */ }
  return {
    runtime,
    model: fs.existsSync(path.join(config.storage.dataDir, MODEL_REL)),
    vocab: fs.existsSync(path.join(config.storage.dataDir, VOCAB_REL)),
    merges: fs.existsSync(path.join(config.storage.dataDir, MERGES_REL)),
  }
}

import { createRequire } from 'node:module'

export class CLIPEmbedder {
  constructor() {
    this.session = null
    this.tokenizer = null
  }

  async ensure() {
    if (this.session && this.tokenizer) return
    const avail = clipAvailable()
    if (!avail.runtime || !avail.model || !avail.vocab || !avail.merges) {
      throw new Error(`CLIP not installed (runtime=${avail.runtime}, model=${avail.model}) — run npm run ai:setup`)
    }
    sessionPromise ??= (async () => {
      const ort = createRequire(import.meta.url)('onnxruntime-node')
      this.ort = ort
      return ort.InferenceSession.create(path.join(config.storage.dataDir, MODEL_REL))
    })()
    tokenizerPromise ??= ClipTokenizer.load()
    ;[this.session, this.tokenizer] = await Promise.all([sessionPromise, tokenizerPromise])
  }

  /** Embed one text string → L2-normalized Float32Array(512). */
  async embedText(text) {
    await this.ensure()
    const { input, attention } = this.tokenizer.encode(text)
    // the ONNX is one graph for both towers — feed a blank image alongside
    // (ViT-B/32 forward is tens of ms on CPU; simplicity beats graph surgery)
    const results = await this.session.run({
      input_ids: new this.ort.Tensor('int64', input, [1, CONTEXT]),
      attention_mask: new this.ort.Tensor('int64', attention, [1, CONTEXT]),
      pixel_values: new this.ort.Tensor('float32', new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE), [1, 3, IMAGE_SIZE, IMAGE_SIZE]),
    })
    return normalize(results.text_embeds.data)
  }

  /**
   * Embed one RGB frame (raw rgb24 buffer, any size — resized/normalized to
   * the CLIP 224×224 input with bicubic-ish area scaling) → L2-normalized
   * Float32Array(512).
   */
  async embedRgb(rgb, width, height) {
    await this.ensure()
    const pixels = resizeRgb(rgb, width, height, IMAGE_SIZE, IMAGE_SIZE)
    const float = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE)
    for (let i = 0; i < IMAGE_SIZE * IMAGE_SIZE; i++) {
      for (let c = 0; c < 3; c++) {
        float[c * IMAGE_SIZE * IMAGE_SIZE + i] = ((pixels[i * 3 + c] / 255) - CLIP_MEAN[c]) / CLIP_STD[c]
      }
    }
    const results = await this.session.run({
      pixel_values: new this.ort.Tensor('float32', float, [1, 3, IMAGE_SIZE, IMAGE_SIZE]),
      input_ids: new this.ort.Tensor('int64', BLANK_TEXT_IDS, [1, CONTEXT]),
      attention_mask: new this.ort.Tensor('int64', BLANK_TEXT_ATTN, [1, CONTEXT]),
    })
    return normalize(results.image_embeds.data)
  }

  status() {
    const avail = clipAvailable()
    return {
      id: 'clip-vit-b32',
      ready: Boolean(this.session),
      runtime: avail.runtime,
      model: avail.model,
      vocab: avail.vocab && avail.merges,
    }
  }
}

export function cosineSimilarity(a, b) {
  let dot = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i]
  return dot
}

function normalize(v) {
  let norm = 0
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
  return out
}

/** Area-average downscale ( sufficient for 224² CLIP input). */
export function resizeRgb(rgb, width, height, outW, outH) {
  const out = new Uint8Array(outW * outH * 3)
  const xRatio = width / outW
  const yRatio = height / outH
  for (let oy = 0; oy < outH; oy++) {
    const sy0 = Math.floor(oy * yRatio)
    const sy1 = Math.min(height, Math.max(sy0 + 1, Math.floor((oy + 1) * yRatio)))
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = Math.floor(ox * xRatio)
      const sx1 = Math.min(width, Math.max(sx0 + 1, Math.floor((ox + 1) * xRatio)))
      let r = 0, g = 0, b = 0, n = 0
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const j = (sy * width + sx) * 3
          r += rgb[j]; g += rgb[j + 1]; b += rgb[j + 2]
          n += 1
        }
      }
      const o = (oy * outW + ox) * 3
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n
    }
  }
  return out
}
