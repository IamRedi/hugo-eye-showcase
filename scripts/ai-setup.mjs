#!/usr/bin/env node
/**
 * HUGO Eye AI setup — downloads the local detection model (YOLOv8n ONNX,
 * 640×640, COCO-80) into the data directory with checksum verification.
 *
 * Usage: npm run ai:setup
 *   HUGO_EYE_MODEL_URL overrides the download source.
 * The model runs fully local via onnxruntime-node (npm i installs it as an
 * optional dependency); no video, frames or embeddings ever leave the machine.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.HUGO_EYE_DATA_DIR ||= path.join(process.env.HOME ?? '', 'hugo-eye-data')
const { config } = await import(path.join(REPO, 'src', 'config.js'))

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// Model manifest — pinned versions, verified checksums, recorded licenses.
const MODELS = [
  {
    file: 'yolov8n.onnx',
    sha256: 'adda0231eeb47d888199927f6caf7b46dacaf91bad5bfeea63fde3ebd5d7846f',
    sources: [
      process.env.HUGO_EYE_MODEL_URL,
      'https://github.com/yoobright/yolo-onnx/raw/master/yolov8n.onnx',
    ].filter(Boolean),
    license: 'AGPL-3.0 (Ultralytics YOLOv8n export)',
    sizeMB: 12.3,
  },
  {
    file: 'face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    sources: ['https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx'],
    license: 'Apache-2.0 (opencv_zoo, Intel)',
    sizeMB: 0.23,
  },
  {
    file: 'clip-vit-base-patch32-q.onnx',
    sha256: '0898a3facfdb27f0a041e57649b4989cfd094e4a0040d6ae75ed69917dfc7328',
    sources: ['https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/model_quantized.onnx'],
    license: 'Apache-2.0 / MIT (OpenAI CLIP, Xenova ONNX export; int8 quantized)',
    sizeMB: 146.6,
    optional: 'semantic search (Gate 4)',
  },
  {
    file: 'clip-vocab.json',
    sha256: '5047b556ce86ccaf6aa22b3ffccfc52d391ea4accdab9c2f2407da5b742d4363',
    sources: ['https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/vocab.json'],
    license: 'Apache-2.0 / MIT (CLIP tokenizer)',
    sizeMB: 0.85,
    optional: 'semantic search (Gate 4)',
  },
  {
    file: 'clip-merges.txt',
    sha256: '9fd691f7c8039210e0fced15865466c65820d09b63988b0174bfe25de299051a',
    sources: ['https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/merges.txt'],
    license: 'Apache-2.0 / MIT (CLIP tokenizer)',
    sizeMB: 0.52,
    optional: 'semantic search (Gate 4)',
  },
  {
    file: 'face_recognition_sface_2021dec.onnx',
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
    sources: ['https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx'],
    license: 'Apache-2.0 (opencv_zoo SFace)',
    sizeMB: 36.9,
  },
]

fs.mkdirSync(path.join(config.storage.dataDir, 'models'), { recursive: true })
let failures = 0
for (const model of MODELS) {
  const target = path.join(config.storage.dataDir, 'models', model.file)
  if (fs.existsSync(target) && sha256(target) === model.sha256) {
    console.log(`verified: ${model.file} (${model.license})`)
    continue
  }
  if (fs.existsSync(target)) {
    console.log(`existing ${model.file} has a wrong hash — re-downloading`)
    fs.unlinkSync(target)
  }
  let ok = false
  for (const url of model.sources) {
    console.log(`downloading ${model.file} from ${url} …`)
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const hash = crypto.createHash('sha256').update(buf).digest('hex')
      if (hash !== model.sha256) {
        throw new Error(`checksum mismatch: got ${hash.slice(0, 12)}… expected ${model.sha256.slice(0, 12)}…`)
      }
      fs.writeFileSync(target, buf, { mode: 0o644 })
      console.log(`verified + written: ${target} (${model.license})`)
      ok = true
      break
    } catch (error) {
      console.warn(`source failed: ${error.message}`)
    }
  }
  if (!ok) {
    failures += 1
    console.error(`could not install ${model.file} — set its env URL override or place it manually at ${target}`)
  }
}
if (failures > 0) {
  console.error(`${failures} model(s) missing — affected providers will report not_installed (honest state)`)
  process.exit(1)
}
console.log('all models verified')
