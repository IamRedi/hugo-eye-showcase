#!/usr/bin/env node
/**
 * One-command local demo: starts the demo RTSP camera and HUGO Eye against
 * it, with a throw-away data directory and a fixed demo token. Nothing
 * outside the temporary directory is touched; Ctrl+C stops both.
 *
 *   npm run demo            → http://127.0.0.1:8764/  (token: demo-token-demo-token-demo-token)
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hugo-eye-demo-'))
const TOKEN = 'demo-token-demo-token-demo-token'

const camera = spawn(process.execPath, ['scripts/demo-camera.mjs', '--port', '8554', ...process.argv.slice(2)],
  { cwd: REPO, stdio: 'inherit' })

const env = {
  ...process.env,
  HUGO_EYE_HOST: '127.0.0.1',
  HUGO_EYE_PORT: '8764',
  HUGO_EYE_API_TOKEN: TOKEN,
  HUGO_EYE_DATA_DIR: dataDir,
  CAM1_ID: 'demo',
  CAM1_DRIVER: 'tapo',
  CAM1_NAME: 'Demo camera',
  CAM1_MODEL: 'Demo RTSP source',
  CAM1_HOST: '127.0.0.1',
  CAM1_RTSP_PORT: '8554',
  CAM1_ONVIF_PORT: '8555',
  CAM1_RTSP_MAIN_PATH: '/stream1',
  CAM1_RTSP_SUB_PATH: '/stream2',
  CAM1_USERNAME: 'demo',
  CAM1_PASSWORD: 'demo',
  CAM1_ROTATE: '0',
  PATROL_ENABLED: 'false',
}

let app
setTimeout(() => {
  app = spawn(process.execPath, ['src/index.js'], { cwd: REPO, env, stdio: 'inherit' })
  app.on('exit', code => shutdown(stopping ? 0 : (code ?? 0)))
  console.log(`\nHUGO Eye demo: http://127.0.0.1:8764/  — token: ${TOKEN}\n`)
}, 1500)

let stopping = false
function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  camera.kill()
  app?.kill()
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
