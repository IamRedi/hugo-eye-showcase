#!/usr/bin/env node
/**
 * HUGO Eye demo camera — a local RTSP source for trying the panel without
 * camera hardware. ffmpeg renders a synthetic test picture (or a video file
 * you pass in), encodes it as H.264 and this script serves it over RTSP with
 * digest-free interleaved RTP, the same transport the Tapo driver uses.
 *
 *   node scripts/demo-camera.mjs [--port 8554] [--input clip.mp4]
 *
 * Then start HUGO Eye with CAM1_HOST=127.0.0.1 and CAM1_RTSP_PORT=8554
 * (see README, "Ausprobieren ohne Kamera"). ONVIF/PTZ are not emulated, so
 * PTZ and ONVIF health stay "unavailable" — that is the honest state.
 */
import net from 'node:net'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(opt('--port', 8554))
const INPUT = opt('--input', null)
const FPS = 15

const ffArgs = ['-hide_banner', '-loglevel', 'error', '-re']
if (INPUT) ffArgs.push('-stream_loop', '-1', '-i', INPUT)
else ffArgs.push('-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${FPS}`)
ffArgs.push('-an', '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
  '-profile:v', 'main', '-g', String(FPS * 2), '-x264-params', 'aud=1:repeat-headers=1',
  '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', 'pipe:1')

let sps = null
let pps = null
const players = new Set()       // sockets in PLAY state
const waitingForIdr = new WeakSet()
let ts = 90_000
let seq = 0

function rtp(channel, pt, payload, timestamp, marker) {
  const pkt = Buffer.alloc(16 + payload.length)
  pkt[0] = 0x24; pkt[1] = channel; pkt.writeUInt16BE(12 + payload.length, 2)
  pkt[4] = 0x80; pkt[5] = marker ? (pt | 0x80) : pt
  pkt.writeUInt16BE(seq = (seq + 1) & 0xffff, 6)
  pkt.writeUInt32BE(timestamp >>> 0, 8)
  pkt.writeUInt32BE(0x48554745, 12) // SSRC "HUGE"
  payload.copy(pkt, 16)
  return pkt
}

// RFC 6184: single NAL unit packets, FU-A for anything above ~1200 bytes
function packetize(nal, timestamp, lastInAu) {
  const MAX = 1200
  if (nal.length <= MAX) return [rtp(0, 96, nal, timestamp, lastInAu)]
  const out = []
  const header = nal[0]
  const body = nal.subarray(1)
  for (let off = 0; off < body.length; off += MAX) {
    const chunk = body.subarray(off, off + MAX)
    const start = off === 0
    const end = off + MAX >= body.length
    const fu = Buffer.alloc(2 + chunk.length)
    fu[0] = (header & 0xe0) | 28
    fu[1] = (start ? 0x80 : 0) | (end ? 0x40 : 0) | (header & 0x1f)
    chunk.copy(fu, 2)
    out.push(rtp(0, 96, fu, timestamp, end && lastInAu))
  }
  return out
}

let au = []
function flushAccessUnit() {
  if (!au.length) return
  const isIdr = au.some(n => (n[0] & 0x1f) === 5)
  const packets = []
  au.forEach((nal, i) => packets.push(...packetize(nal, ts, i === au.length - 1)))
  const frame = Buffer.concat(packets)
  for (const s of players) {
    if (s.destroyed) { players.delete(s); continue }
    if (waitingForIdr.has(s)) { if (!isIdr) continue; waitingForIdr.delete(s) }
    s.write(frame)
  }
  ts += 90_000 / FPS
  au = []
}

function onNal(nal) {
  const type = nal[0] & 0x1f
  if (type === 9) { flushAccessUnit(); return }   // access unit delimiter
  if (type === 7) sps = nal
  if (type === 8) pps = nal
  au.push(nal)
}

// Annex-B splitter
let pending = Buffer.alloc(0)
const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'inherit'] })
let stopping = false
ff.on('exit', code => { if (stopping) return; console.error(`ffmpeg exited (${code})`); process.exit(1) })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; ff.kill(); process.exit(0) })
ff.stdout.on('data', chunk => {
  pending = Buffer.concat([pending, chunk])
  let start = -1
  let i = 0
  const nals = []
  while (i + 3 <= pending.length) {
    if (pending[i] === 0 && pending[i + 1] === 0 && pending[i + 2] === 1) {
      if (start >= 0) {
        let end = i
        if (end > start && pending[end - 1] === 0) end -= 1
        nals.push(pending.subarray(start, end))
      }
      start = i + 3
      i += 3
    } else i += 1
  }
  if (start >= 0) {
    for (const n of nals) onNal(Buffer.from(n))
    pending = pending.subarray(start - 3)
  }
})

// silent PCMA audio, 20 ms packets, so the audio path has a track to read
let ats = 0
setInterval(() => {
  const pkt = rtp(2, 8, Buffer.alloc(160, 0xd5), ats += 160, true)
  for (const s of players) if (!s.destroyed && !waitingForIdr.has(s)) s.write(pkt)
}, 20).unref()

const server = net.createServer(socket => {
  socket.on('error', () => {})
  socket.on('close', () => players.delete(socket))
  let buf = Buffer.alloc(0)
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf[0] === 0x24) {            // interleaved RTCP from the client
        if (buf.length < 4) return
        const len = buf.readUInt16BE(2)
        if (buf.length < 4 + len) return
        buf = buf.subarray(4 + len)
        continue
      }
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) return
      const head = buf.subarray(0, end).toString('latin1')
      buf = buf.subarray(end + 4)
      onRequest(socket, head)
    }
  })
})

function onRequest(socket, head) {
  const lines = head.split('\r\n')
  const [method] = lines[0].split(' ')
  const headers = {}
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':')
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
  }
  const cseq = headers.cseq ?? '1'
  const ok = extra => socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n${extra}\r\n`)
  switch (method) {
    case 'OPTIONS':
      return ok('Public: OPTIONS, DESCRIBE, SETUP, TEARDOWN, PLAY, GET_PARAMETER\r\n')
    case 'DESCRIBE': {
      const sprop = sps && pps ? `;sprop-parameter-sets=${sps.toString('base64')},${pps.toString('base64')}` : ''
      const sdp = [
        'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=HUGO Eye demo camera', 'c=IN IP4 127.0.0.1', 't=0 0',
        'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000', `a=fmtp:96 packetization-mode=1${sprop}`, 'a=control:trackID=0',
        'm=audio 0 RTP/AVP 8', 'a=rtpmap:8 PCMA/8000', 'a=control:trackID=1', '',
      ].join('\r\n')
      ok(`Content-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(sdp)}\r\n`)
      return socket.write(sdp)
    }
    case 'SETUP': {
      const track = /trackID=1/.test(lines[0]) ? '2-3' : '0-1'
      return ok(`Session: demo${socket.remotePort};timeout=60\r\nTransport: RTP/AVP/TCP;unicast;interleaved=${track}\r\n`)
    }
    case 'PLAY':
      ok(`Session: demo${socket.remotePort}\r\nRTP-Info: url=trackID=0\r\n`)
      waitingForIdr.add(socket)
      players.add(socket)
      return
    case 'TEARDOWN':
      players.delete(socket)
      ok('')
      return socket.end()
    default:
      return ok('')
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`HUGO Eye demo camera: rtsp://127.0.0.1:${PORT}/stream1 (${INPUT ?? 'synthetic test picture'}, ${FPS} fps)`)
})
