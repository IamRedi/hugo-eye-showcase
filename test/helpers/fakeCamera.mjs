import net from 'node:net'
import crypto from 'node:crypto'

/**
 * Minimal in-process RTSP camera for tests: digest auth, DESCRIBE+SDP,
 * SETUP (interleaved), PLAY → RTP H.264 (SPS/PPS/IDR/P) + PCMA audio on the
 * interleaved channels, TEARDOWN, GET_PARAMETER keepalive. The test controls
 * media flow, connection drops and a "path lock" mode (accepts sessions but
 * sends no media) to exercise the hub state machine end-to-end.
 */
export class FakeCamera {
  constructor({ requireAuth = true } = {}) {
    this.requireAuth = requireAuth
    this.sessions = new Map()
    this.mediaTimer = null
    this.locked = false            // accept sessions, never send media
    this.refuseConnections = false
    this.teardowns = 0
    this.connections = 0
    this.plays = 0
    this.sockets = new Set()
    this.seq = 100
    this.ts = 90_000               // RTP timestamp base (1 s)
    this.server = net.createServer(socket => this._onConnection(socket))
  }

  listen() {
    return new Promise(resolve => this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port)))
  }

  close() {
    this.stopMedia()
    for (const s of this.sockets) s.destroy()
    return new Promise(resolve => this.server.close(resolve))
  }

  _onConnection(socket) {
    this.connections += 1
    if (this.refuseConnections) { socket.destroy(); return }
    this.sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => this.sockets.delete(socket))
    let buf = Buffer.alloc(0)
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const end = buf.indexOf('\r\n\r\n')
        if (end === -1) return
        const head = buf.subarray(0, end).toString('latin1')
        buf = buf.subarray(end + 4)
        this._onRequest(socket, head)
      }
    })
  }

  _onRequest(socket, head) {
    const lines = head.split('\r\n')
    const [method, uri] = lines[0].split(' ')
    const headers = {}
    for (const line of lines.slice(1)) {
      const idx = line.indexOf(':')
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
    }
    const cseq = headers.cseq ?? '1'

    if (this.requireAuth && !headers.authorization) {
      socket.write(`RTSP/1.0 401 Unauthorized\r\nCSeq: ${cseq}\r\nWWW-Authenticate: Digest realm="FakeCam", nonce="${crypto.randomBytes(8).toString('hex')}"\r\n\r\n`)
      return
    }

    if (method === 'OPTIONS') {
      socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nPublic: OPTIONS, DESCRIBE, SETUP, TEARDOWN, PLAY, GET_PARAMETER\r\n\r\n`)
      return
    }
    if (method === 'DESCRIBE') {
      const sdp = [
        'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=FakeCam', 'c=IN IP4 127.0.0.1', 't=0 0',
        'm=video 0 RTP/AVP 96',
        'a=rtpmap:96 H264/90000',
        'a=fmtp:96 packetization-mode=1;sprop-parameter-sets=Z00AHpWoLQ9ppcGBTdCAwK1QsKk=,aO48gA==',
        'a=control:trackID=0',
        'm=audio 0 RTP/AVP 8',
        'a=rtpmap:8 PCMA/8000',
        'a=control:trackID=1',
      ].join('\r\n')
      socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nContent-Type: application/sdp\r\nContent-Length: ${sdp.length}\r\n\r\n${sdp}`)
      return
    }
    if (method === 'SETUP') {
      const session = `s${this.seq++}`
      this.sessions.set(session, socket)
      socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nSession: ${session};timeout=60\r\nTransport: RTP/AVP/TCP;interleaved=0-1\r\n\r\n`)
      return
    }
    if (method === 'PLAY') {
      this.plays += 1
      socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nSession: ${headers.session?.split(';')[0] ?? 's1'}\r\nRTP-Info: url=trackID=0\r\n\r\n`)
      if (!this.locked) this.startMedia(socket)
      return
    }
    if (method === 'GET_PARAMETER') {
      socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n\r\n`)
      return
    }
    if (method === 'TEARDOWN') {
      this.teardowns += 1
      this.stopMedia()
      socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n\r\n`)
      socket.end()
      return
    }
    socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n\r\n`)
  }

  startMedia(socket = [...this.sockets][0]) {
    this.stopMedia()
    if (this.locked) return
    // SPS(7), PPS(8), IDR(5)/P(1) — tiny synthetic NALs, 25 fps wall cadence
    const mkRtp = (channel, pt, payload, ts, marker = false) => {
      const rtp = Buffer.alloc(12 + payload.length)
      rtp[0] = 0x80
      rtp[1] = marker ? (pt | 0x80) : pt
      rtp.writeUInt32BE(ts, 4)
      payload.copy(rtp, 12)
      const hdr = Buffer.from([0x24, channel])
      const len = Buffer.alloc(2)
      len.writeUInt16BE(rtp.length)
      return Buffer.concat([hdr, len, rtp])
    }
    const nal = type => Buffer.from([type, 0x01, 0x02, 0x03, 0x04])
    let frame = 0
    this.mediaTimer = setInterval(() => {
      if (this.locked || socket.destroyed) { this.stopMedia(); return }
      frame += 1
      const idr = frame % 4 === 1
      this.ts += 6000
      const parts = []
      parts.push(mkRtp(0, 96, nal(7), this.ts))          // SPS
      parts.push(mkRtp(0, 96, nal(8), this.ts))          // PPS
      parts.push(mkRtp(0, 96, Buffer.concat([Buffer.from([idr ? 5 : 1]), Buffer.alloc(9, 0x10)]), this.ts, true)) // AU end
      // audio: 8 bytes of PCMA (0xD5 silence), marker set (one packet per AU)
      parts.push(mkRtp(2, 8, Buffer.alloc(8, 0xd5), this.ts, true))
      try { socket.write(Buffer.concat(parts)) } catch { this.stopMedia() }
    }, 40)
    this.mediaTimer.unref?.()
  }

  stopMedia() {
    if (this.mediaTimer) clearInterval(this.mediaTimer)
    this.mediaTimer = null
  }

  dropConnections() {
    this.stopMedia()
    for (const s of this.sockets) s.destroy()
  }
}
