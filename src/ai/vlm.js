import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { log } from '../log.js'

/**
 * Vision-Language Model (VLM) provider interface — EYE-023 Gate 3.
 *
 * Purpose: explain visually observed events and answer questions about the
 * camera, locally. Architecture: fast detection → tracked event → selected
 * frames → optional visual reasoning → structured description. The VLM never
 * runs per-frame and never blocks live video, recording or PTZ: callers go
 * through VlmQueue (concurrency 1, latest-wins, bounded).
 *
 * Provider contract (swap for a stronger local model without touching the
 * camera core):
 *   id: string                            e.g. 'ollama-qwen2.5vl'
 *   model: string                         model identifier at the runtime
 *   available(): Promise<boolean>         runtime reachable + model present
 *   describe(jpegBuffer, { question? }):  → { ok, text, model, at, ms }
 *     one image in, grounded description out. Implementations must instruct
 *     the model to report only what is visible and to say so when unsure.
 *   status(): { id, model, state, lastError, ... }
 *
 * Honesty invariants:
 *   - visual observations (detections/tracks) and model interpretations are
 *     stored separately; descriptions name their model
 *   - uncertainty is passed through: if the model cannot tell, the answer
 *     must say so — never invent actions or identities
 *   - a VLM failure degrades description quality only, never media flow
 */

export const DESCRIBE_SYSTEM_PROMPT = [
  'You describe what a security camera sees. Ground every statement in the image.',
  'Report people, animals and objects, positions, actions and scene context.',
  'If something is unclear or you cannot tell what a person is doing, say so explicitly.',
  'Never invent identities: describe people by appearance (clothing, position), not names.',
  'Be concise and factual (2-4 sentences).',
].join(' ')

/**
 * Downscale a JPEG so its long edge is ≤ maxPx (no upscaling). Uses ffmpeg
 * (already a product dependency). Returns the original buffer when it is
 * already small enough or ffmpeg fails (best-effort optimization).
 */
export async function downscaleJpeg(jpegBuffer, maxPx) {
  if (maxPx <= 0) return jpegBuffer
  const probe = await new Promise(resolve => {
    const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', 'pipe:0'],
      { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', c => { out += c.toString() })
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const [w, h] = out.trim().split('x').map(Number)
      resolve(w > 0 && h > 0 ? { w, h } : null)
    })
    child.stdin.end(jpegBuffer)
  })
  if (!probe || Math.max(probe.w, probe.h) <= maxPx) return jpegBuffer
  const scale = `scale='min(${maxPx},iw)':-2:flags=area`
  return new Promise(resolve => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0', '-vf', scale, '-frames:v', '1', '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks = []
    child.stdout.on('data', c => chunks.push(c))
    child.on('error', () => resolve(jpegBuffer))
    child.on('close', code => {
      const out = Buffer.concat(chunks)
      resolve(code === 0 && out.length > 1024 ? out : jpegBuffer)
    })
    child.stdin.end(jpegBuffer)
  })
}

/** Default questions the product asks (on-demand scene Q&A). */
export const SUGGESTED_QUESTIONS = [
  'What is happening in the room?',
  'Describe the last detected event.',
  'What changed in the last few minutes?',
  'Is someone sitting on the sofa?',
  'Summarize the activity you can see.',
]

/**
 * True when a model answer is a refusal-to-guess rather than content.
 * Used to label uncertain answers honestly instead of storing confident
 * nonsense. Honest NEGATIVES ("no person visible") are definitive answers,
 * not uncertainty — they do not belong here.
 */
export function answerIndicatesUncertainty(text) {
  const t = String(text).toLowerCase()
  return [
    'cannot determine', 'not possible to determine', 'cannot tell',
    'unable to determine', 'i cannot see', "i don't see", 'i do not see',
    'difficult to tell', 'hard to tell', 'unclear', 'not visible in the image',
    'cannot identify', 'no way to tell',
  ].some(p => t.includes(p))
}

/**
 * OllamaProvider — local vision-language inference over the Ollama HTTP API
 * (default http://127.0.0.1:11434). Images are base64 JPEGs; inference runs
 * entirely on this machine.
 */
export class OllamaProvider {
  constructor({ baseUrl = null, model = null, timeoutMs = 180_000, keepAlive = null } = {}) {
    this.baseUrl = baseUrl ?? process.env.HUGO_EYE_OLLAMA_URL ?? 'http://127.0.0.1:11434'
    this.model = model ?? process.env.HUGO_EYE_VLM_MODEL ?? 'qwen2.5vl:3b'
    // residency while idle. qwen2.5vl:3b measures ~10.8 GB RAM while loaded
    // on this appliance (CPU inference, size_vram 0) — '10m' balances Q&A
    // latency against memory pressure; tune with HUGO_EYE_VLM_KEEP_ALIVE.
    this.keepAlive = keepAlive ?? process.env.HUGO_EYE_VLM_KEEP_ALIVE ?? '10m'
    // Vision-token cost scales with pixel area. Measured on this appliance
    // (CPU): 768px ≈ 20 s per new image, 1024px ≈ 45 s (repeated images are
    // ~1 s via the runtime's embedding cache). 768 retains scene understanding.
    this.maxImagePx = Number(process.env.HUGO_EYE_VLM_IMAGE_PX ?? 768)
    this.timeoutMs = timeoutMs
    this.id = `ollama-${this.model}`
    this.state = 'idle'
    this.lastError = null
    this.lastMs = null
    this.calls = 0
  }

  async available() {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return false
      const tags = await res.json()
      return (tags.models ?? []).some(m => m.name === this.model || m.name.startsWith(`${this.model}:`))
    } catch {
      return false
    }
  }

  /**
   * Describe one JPEG image. question defaults to a scene description.
   * Images are downscaled to ~maxImagePx on the long edge before inference:
   * vision-token cost grows with pixel area, and full-res snapshots make
   * CPU-side image encoding take minutes instead of seconds. Returns
   * { ok, text, model, at, ms, uncertain } or { ok: false, error }.
   */
  async describe(jpegBuffer, { question = null, system = DESCRIBE_SYSTEM_PROMPT } = {}) {
    if (!jpegBuffer?.length) return { ok: false, error: 'no image provided' }
    const started = Date.now()
    this.state = 'busy'
    try {
      const image = await downscaleJpeg(jpegBuffer, this.maxImagePx)
      const body = {
        model: this.model,
        stream: false,
        keep_alive: this.keepAlive,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: question ?? 'Describe what is currently visible: people (position, action), animals, notable objects and the overall scene. If you cannot determine something, say so.',
            images: [image.toString('base64')],
          },
        ],
        options: { temperature: 0.2, num_predict: 220 },
      }
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) throw new Error(`ollama responded ${res.status}`)
      const data = await res.json()
      const text = String(data.message?.content ?? '').trim()
      this.calls += 1
      this.lastMs = Date.now() - started
      this.state = 'ready'
      this.lastError = null
      return {
        ok: true,
        text,
        model: this.model,
        at: new Date().toISOString(),
        ms: this.lastMs,
        evalMs: data.eval_duration ? Math.round(data.eval_duration / 1e6) : null,
        promptEvalMs: data.prompt_eval_duration ? Math.round(data.prompt_eval_duration / 1e6) : null,
        uncertain: answerIndicatesUncertainty(text),
      }
    } catch (error) {
      this.state = 'error'
      this.lastError = error.message
      log.warn(`vlm describe failed (${this.model}): ${error.message}`)
      return { ok: false, error: error.message }
    }
  }

  /**
   * Load the model without processing an image (cheap: no image encoding).
   * Called when aiVision is enabled so the first real query or event
   * description does not pay the 60-90 s cold load.
   */
  async warmup() {
    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, keep_alive: this.keepAlive, prompt: '' }),
        signal: AbortSignal.timeout(180_000),
      })
      if (!res.ok) throw new Error(`ollama responded ${res.status}`)
      await res.json()
      this.state = 'ready'
      return true
    } catch (error) {
      this.lastError = error.message
      return false
    }
  }

  status() {
    return {
      id: this.id,
      model: this.model,
      baseUrl: this.baseUrl,
      state: this.state,
      lastError: this.lastError,
      lastMs: this.lastMs,
      calls: this.calls,
    }
  }
}

/**
 * VlmQueue — bounded async executor for VLM jobs. Concurrency 1 (the local
 * runtime is the bottleneck), latest-wins per camera (a queued scene analysis
 * is superseded by a newer one), hard timeout, and a per-camera cooldown so
 * event-triggered descriptions cannot saturate the machine.
 */
export class VlmQueue {
  constructor(provider, { cooldownMs = 60_000, maxQueued = 4 } = {}) {
    this.provider = provider
    this.cooldownMs = cooldownMs
    this.maxQueued = maxQueued
    this.queue = []
    this.running = false
    this.lastRunAt = new Map()   // cameraId → ts
    this.stats = { submitted: 0, completed: 0, failed: 0, skippedCooldown: 0, skippedBusy: 0 }
  }

  /**
   * Submit a describe job. Returns immediately; result is delivered to
   * onDone({ ok, text, ... }). When the queue is full the OLDEST queued job
   * is dropped (fresh evidence beats stale).
   */
  submit({ cameraId = null, jpeg, question = null, onDone = null, force = false } = {}) {
    const now = Date.now()
    if (!force) {
      const last = this.lastRunAt.get(cameraId) ?? 0
      if (now - last < this.cooldownMs) {
        this.stats.skippedCooldown += 1
        onDone?.({ ok: false, error: 'cooldown', skipped: true })
        return
      }
    }
    this.lastRunAt.set(cameraId, now)
    this.stats.submitted += 1
    this.queue = this.queue.filter(j => j.cameraId !== cameraId || j.force)
    if (this.queue.length >= this.maxQueued) this.queue.shift()
    this.queue.push({ cameraId, jpeg, question, onDone, force, at: now })
    this._drain()
  }

  /**
   * Promise variant of submit() — for on-demand API calls. `force` bypasses
   * the cooldown but NOT the queue: every inference is serialized so aborted
   * HTTP callers can never pile up parallel server-side encodes.
   */
  submitP(job) {
    return new Promise(resolve => {
      this.submit({ ...job, onDone: resolve })
    })
  }

  async _drain() {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const job = this.queue.shift()
        if (!job) break
        const result = await this.provider.describe(job.jpeg, { question: job.question })
        if (result.ok) this.stats.completed += 1
        else this.stats.failed += 1
        try { job.onDone?.(result) } catch (error) {
          log.warn(`vlm job handler failed: ${error.message}`)
        }
      }
    } finally {
      this.running = false
    }
  }

  status() {
    return {
      provider: this.provider.status(),
      queued: this.queue.length,
      running: this.running,
      cooldownMs: this.cooldownMs,
      ...this.stats,
    }
  }
}
