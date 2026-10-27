import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import { log } from '../log.js'

/**
 * ffmpeg helpers. H.264 Annex-B arrives on ffmpeg's STDIN — the command line
 * contains no camera credentials and no camera URL at all. Live consumers use
 * the RTP/SDP relay (also credential-free).
 */

export function decodeAnnexbToJpeg(annexbChunks, { timeoutMs = 15000, filters = null } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'h264',
      '-fflags', '+genpts',
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-q:v', '3',
      '-f', 'image2',
      '-c:v', 'mjpeg',
      'pipe:1',
    ]
    if (filters) args.splice(args.indexOf('-frames:v'), 0, '-vf', filters)
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000) })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`ffmpeg spawn failed: ${error.message}`))
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const jpeg = Buffer.concat(chunks)
      if (code === 0 && jpeg.length > 0 && jpeg[0] === 0xff && jpeg[1] === 0xd8) {
        resolve(jpeg)
      } else {
        reject(new Error(`ffmpeg exited with ${code}; output ${jpeg.length}B; stderr: ${stderr.slice(0, 400) || '(empty)'}`))
      }
    })

    for (const chunk of annexbChunks) child.stdin.write(chunk)
    child.stdin.end()
  })
}

/**
 * Live MJPEG transcoder. Input: GOP-aligned H.264 Annex-B on a stdin pipe
 * from the relay hub (no ports, no SDP files, no credentials anywhere).
 * Output flows in real time; presentation filters (rotation/mirror/flip)
 * are applied here.
 */
export function startPipeMjpegTranscoder({ streamFps = 15, outFps = 8, scaleWidth = 960, filters = null, onError = () => {} }) {
  const vf = [`fps=${outFps}`, filters, `scale=${scaleWidth}:-2`].filter(Boolean).join(',')
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'h264', '-fflags', '+genpts+nobuffer', '-framerate', String(streamFps),
    '-analyzeduration', '200000', '-probesize', '100k', '-flags', 'low_delay',
    '-i', 'pipe:0',
    '-an',
    '-vf', vf,
    '-q:v', '6',
    '-f', 'mpjpeg',
    'pipe:1',
  ]
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  wireConsumer(child, 'mjpeg transcoder', onError)
  return child
}

/**
 * Modern playback path: H.264 → fragmented MP4 over a pipe for MSE playback.
 * Video is copied (no re-encode, near-zero CPU); orientation is applied by
 * the player via CSS transform (rotating a bitstream would force a re-encode).
 */
export function startPipeFmp4Transcoder({ streamFps = 15, onError = () => {} }) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'h264', '-fflags', '+genpts+nobuffer', '-framerate', String(streamFps),
    '-analyzeduration', '200000', '-probesize', '100k', '-flags', 'low_delay',
    '-i', 'pipe:0',
    '-an',
    '-c:v', 'copy',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ]
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  wireConsumer(child, 'fmp4 transcoder', onError)
  return child
}

/**
 * Recording transcoder: stdin H.264 (+ stdin PCMA when gated in) → 60 s
 * segmented MPEG-TS; remuxed to MP4 at rollover/stop by the recordings
 * manager. Video is re-encoded so the presentation rotation is baked in —
 * recordings stay correct when downloaded out of context.
 * Audio enters on fd 3 (`-f alaw -ar 8000`).
 */
export function startPipeRecording({ streamFps = 15, outPattern, segmentSeconds = 60, filters = null, withAudio = false, onError = () => {} }) {
  const vf = [filters, 'scale=1280:-2'].filter(Boolean).join(',')
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'h264', '-fflags', '+genpts+nobuffer', '-framerate', String(streamFps),
    '-analyzeduration', '200000', '-probesize', '100k', '-flags', 'low_delay',
    '-i', 'pipe:0',
  ]
  const stdio = ['pipe', 'ignore', 'pipe']
  if (withAudio) {
    args.push('-f', 'alaw', '-ar', '8000', '-ac', '1', '-i', 'pipe:3')
    stdio.push('pipe')
  }
  args.push('-map', '0:v:0')
  if (withAudio) args.push('-map', '1:a:0?')
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-vf', vf,
  )
  if (withAudio) args.push('-c:a', 'aac', '-b:a', '32k')
  args.push(
    '-f', 'segment',
    '-segment_time', String(segmentSeconds),
    '-reset_timestamps', '1',
    '-segment_format', 'mpegts',
    '-strftime', '1',
    outPattern,
  )
  const child = spawn('ffmpeg', args, { stdio })
  child.videoInput = child.stdin
  child.audioInput = withAudio ? child.stdio[3] : null
  wireConsumer(child, 'recording', onError)
  return child
}

/**
 * Audio listen: PCMA 8 kHz from the hub → WAV (PCM16) on stdout, streamed.
 */
export function startPipeAudioWav({ audioInput = null, onError = () => {} }) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'alaw', '-ar', '8000', '-ac', '1',
    '-i', 'pipe:0',
    '-vn',
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    'pipe:1',
  ]
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  child.audioInput = child.stdin
  wireConsumer(child, 'audio stream', onError)
  if (audioInput) audioInput.on('error', () => {})   // hub releases; drains handled there
  return child
}

/**
 * Motion/AI frame source: stdin H.264 → tiny gray frames at low fps on
 * stdout. Node computes frame diffs / inference (real detection, no black box).
 */
export function startPipeGraySource({ streamFps = 15, width = 160, height = 90, fps = 2, filters = null, onError = () => {} }) {
  const vf = [filters, `fps=${fps}`, `scale=${width}:${height}`].filter(Boolean).join(',')
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'h264', '-fflags', '+genpts+nobuffer', '-framerate', String(streamFps),
    '-analyzeduration', '200000', '-probesize', '100k', '-flags', 'low_delay',
    '-i', 'pipe:0',
    '-an',
    '-vf', vf,
    '-pix_fmt', 'gray',
    '-f', 'rawvideo',
    'pipe:1',
  ]
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  child.videoInput = child.stdin
  wireConsumer(child, 'gray frame source', onError)
  return child
}

/** Shared ffmpeg consumer wiring: stderr capture, exit reporting, stop(). */
function wireConsumer(child, label, onError) {
  let stderr = ''
  let stopped = false
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000) })
  child.on('error', error => { if (!stopped) onError(new Error(`ffmpeg spawn failed: ${error.message}`)) })
  child.on('close', (code, signal) => {
    // a killed consumer (SIGKILL ⇒ code=null, signal set) is just as much a
    // failure as a non-zero exit — it must surface so the owner can restart
    if (!stopped && (code !== null ? code !== 0 : signal !== null)) {
      onError(new Error(`${label} terminated (code=${code}, signal=${signal}): ${stderr.slice(0, 400)}`))
    }
  })
  child.stop = () => {
    stopped = true
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* exited */ } }, 4000)
    try { child.kill('SIGTERM') } catch { /* exited */ }
  }
  return child
}

/**
 * Wraps an ffmpeg stdout in a buffering PassThrough and resolves once data is
 * available. Nothing is consumed: late consumers (WAV headers must reach the
 * browser) receive every byte from the beginning. Rejects on close/timeout.
 */
export function bufferedOutput(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    const out = new PassThrough({ highWaterMark: 1024 * 1024 })
    stream.pipe(out)
    const done = (fn, value) => {
      stream.off('readable', onReadable)
      stream.off('close', onClose)
      clearTimeout(timer)
      fn(value)
    }
    const onReadable = () => done(resolve, out)
    const onClose = () => done(reject, new Error('stream ended before producing output'))
    const timer = setTimeout(() => done(reject, new Error(`no stream output within ${timeoutMs}ms (camera keyframe wait)`)), timeoutMs)
    stream.on('readable', onReadable)
    stream.once('close', onClose)
  })
}

/**
 * Resolves with the first chunk of an output stream; rejects on close/timeout.
 * NOTE: the chunk is consumed — use bufferedOutput() when late consumers need
 * the full stream from byte zero (headers, init segments).
 */
export function firstOutput(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, value) => {
      if (settled) return
      settled = true
      stream.off('data', onData)
      stream.off('close', onClose)
      clearTimeout(timer)
      fn(value)
    }
    const onData = chunk => {
      // detach BEFORE unshifting: while this listener is attached the stream
      // is flowing and unshift would immediately re-emit into it
      settled = true
      stream.off('data', onData)
      stream.off('close', onClose)
      clearTimeout(timer)
      try { stream.unshift(chunk) } catch { /* headerless probes: fine */ }
      resolve(chunk)
    }
    const onClose = () => done(reject, new Error('stream ended before producing output'))
    const timer = setTimeout(() => done(reject, new Error(`no stream output within ${timeoutMs}ms (camera keyframe wait)`)), timeoutMs)
    stream.on('data', onData)
    stream.once('close', onClose)
  })
}

/**
 * AI frame source: stdin H.264 → RGB24 frames at the model input size on
 * stdout. The consumer frames complete images (fixed byte count per frame).
 */
export function startPipeRgbSource({ streamFps = 15, width = 640, height = 640, fps = 2, filters = null, onError = () => {} }) {
  const vf = [filters, `fps=${fps}`, `scale=${width}:${height}`].filter(Boolean).join(',')
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'h264', '-fflags', '+genpts', '-framerate', String(streamFps),
    '-analyzeduration', '200000', '-probesize', '100k', '-flags', 'low_delay',
    '-i', 'pipe:0',
    '-an',
    '-vf', vf,
    '-pix_fmt', 'rgb24',
    '-f', 'rawvideo',
    'pipe:1',
  ]
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  child.videoInput = child.stdin
  wireConsumer(child, 'ai frame source', onError)
  return child
}

/** Converts one raw RGB24 frame to a JPEG, optionally cropping a detection box. */
export function rgbFrameToJpeg(rgb, width, height, box = null) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', 'pipe:0',
    ]
    if (box) {
      // normalized box → padded pixel crop (clamped, minimum size)
      const pad = 0.08
      const bw = Math.max(0.05, Math.min(1, box.wNorm + pad * 2))
      const bh = Math.max(0.05, Math.min(1, box.hNorm + pad * 2))
      const bx = Math.max(0, Math.min(1 - bw, box.xNorm - pad))
      const by = Math.max(0, Math.min(1 - bh, box.yNorm - pad))
      const cw = Math.max(16, Math.round(bw * width))
      const ch = Math.max(16, Math.round(bh * height))
      const cx = Math.max(0, Math.min(width - cw, Math.round(bx * width)))
      const cy = Math.max(0, Math.min(height - ch, Math.round(by * height)))
      args.push('-vf', `crop=${cw}:${ch}:${cx}:${cy}`)
    }
    args.push('-frames:v', '1', '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1')
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks = []
    child.stdout.on('data', c => chunks.push(c))
    child.on('error', reject)
    child.on('close', code => {
      const jpeg = Buffer.concat(chunks)
      if (code === 0 && jpeg.length > 4) resolve(jpeg)
      else reject(new Error(`rgb->jpeg failed (${code})`))
    })
    child.stdin.write(rgb)
    child.stdin.end()
  })
}

/** Converts one raw gray frame to a JPEG thumbnail. */
export function grayFrameToJpeg(gray, width, height) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${width}x${height}`, '-i', 'pipe:0',
      '-frames:v', '1', '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks = []
    child.stdout.on('data', c => chunks.push(c))
    child.on('error', reject)
    child.on('close', code => {
      const jpeg = Buffer.concat(chunks)
      if (code === 0 && jpeg.length > 4) resolve(jpeg)
      else reject(new Error(`gray->jpeg failed (${code})`))
    })
    child.stdin.write(gray)
    child.stdin.end()
  })
}

export function ffmpegAvailable() {
  return new Promise(resolve => {
    const child = spawn('ffmpeg', ['-version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

/** Atomic JPEG write: temp file + rename, fsync'd. */
export function writeJpegAtomic(filePath, jpeg) {
  fs.mkdirSync(filePath.substring(0, filePath.lastIndexOf('/')), { recursive: true })
  const tmp = `${filePath}.part-${process.pid}`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, jpeg)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, filePath)
  log.info(`media written: ${filePath} (${jpeg.length}B)`)
}
