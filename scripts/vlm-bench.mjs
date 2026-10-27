#!/usr/bin/env node
/**
 * VLM benchmark — measures cold-start, warm latency, memory impact and answer
 * quality on REAL camera evidence images. Run after `ollama pull <model>`.
 *
 * Usage: node scripts/vlm-bench.mjs [image1.jpg image2.jpg ...]
 *   (defaults: newest files in <dataDir>/media/camera + a recording frame)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = process.env.HUGO_EYE_DATA_DIR ?? path.join(os.homedir(), 'hugo-eye-data')

const { OllamaProvider } = await import(path.join(REPO, 'src', 'ai', 'vlm.js'))

let images = process.argv.slice(2).filter(a => !a.startsWith('--'))
if (images.length === 0) {
  const candidates = []
  for (const dir of [path.join(dataDir, 'media', 'camera'), path.join(dataDir, 'media', 'events', 'tapo-main')]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jpg')) continue
        const full = path.join(dir, f)
        candidates.push({ full, mtime: fs.statSync(full).mtimeMs })
      }
    } catch { /* missing dir */ }
  }
  images = candidates.sort((a, b) => b.mtime - a.mtime).slice(0, 3).map(c => c.full)
}
if (images.length === 0) {
  console.error('vlm-bench: no evidence images found — pass paths explicitly')
  process.exit(1)
}

const rssBefore = process.memoryUsage().rss
const provider = new OllamaProvider()
console.log(`provider: ${provider.id} @ ${provider.baseUrl}`)

if (!(await provider.available())) {
  console.error(`model ${provider.model} is not present at the runtime — pull it first`)
  process.exit(1)
}

const QUESTIONS = [
  null,
  'Is there a person visible? If yes, what are they doing and where? If no, say so.',
  'List the five most notable objects you can see, with their positions.',
]

let first = true
for (const image of images) {
  const jpeg = fs.readFileSync(image)
  for (const q of QUESTIONS) {
    const t0 = Date.now()
    const r = await provider.describe(jpeg, { question: q })
    const ms = Date.now() - t0
    const label = `${path.basename(image)} · ${q ? q.slice(0, 40) : 'default describe'}`
    if (!r.ok) {
      console.log(`\n✗ ${label}\n  ERROR: ${r.error} (${ms}ms)`)
      continue
    }
    console.log(`\n● ${label}`)
    console.log(`  ${first ? 'COLD ' : 'warm'}: total ${ms}ms (provider ${r.ms}ms, prompt-eval ${r.promptEvalMs ?? '?'}ms, eval ${r.evalMs ?? '?'}ms)${r.uncertain ? ' · flagged uncertain' : ''}`)
    console.log(`  answer: ${r.text.replaceAll('\n', ' ').slice(0, 400)}`)
    first = false
  }
}

const rssAfter = process.memoryUsage().rss
console.log(`\nbench process RSS: ${(rssBefore / 1e6).toFixed(0)}MB → ${(rssAfter / 1e6).toFixed(0)}MB (images are ~100-200KB each; model memory lives in the ollama runtime process)`)
