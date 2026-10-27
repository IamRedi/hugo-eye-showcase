import net from 'node:net'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { maskSecrets } from '../config.js'
import { log } from '../log.js'

/**
 * Minimal RTSP 1.0 client for H.264 cameras.
 *
 * Security properties (the reason this exists instead of shelling out to
 * `ffmpeg rtsp://user:pass@...`):
 *   - Credentials are sent ONLY inside RTSP Authorization headers (Digest or Basic).
 *   - They never appear in process arguments, environment, or child process cmdlines.
 *   - URLs used everywhere contain no userinfo.
 *
 * Transport: RTP/AVP/TCP interleaved (single socket, like ffmpeg -rtsp_transport tcp).
 * Output: H.264 Annex-B NAL units via 'annexb' events. SPS/PPS come from the SDP
 * sprop-parameter-sets and/or the stream itself.
 */

const CRLF = '\r\n'

export class RtspError extends Error {}

export class RtspClient extends EventEmitter {
  constructor({ host, port = 554, path = '/stream1', username, password, keepaliveMs = 25000, idleTimeoutMs = 15000 }) {
    super()
    this.host = host
    this.port = port
    this.path = path.startsWith('/') ? path : `/${path}`
    this.username = username
    this.password = password
    this.keepaliveMs = keepaliveMs
    this.idleTimeoutMs = idleTimeoutMs

    this.baseUri = `rtsp://${host}:${port}${this.path}`
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.cseq = 0
    this.pending = new Map() // cseq -> {method, resolve, reject, timer}
    this.session = null
    this.keepaliveTimer = null
    this.idleTimer = null
    this.nc = 0
    this.challenge = null // parsed WWW-Authenticate
    this.authWorked = false
    this.closed = false
    this.playing = false

    this.sdp = null
    this.videoTrack = null // {payloadType, controlUri, spropSps, spropPps}
    this.audioTrack = null // {payloadType, controlUri}
    this.videoChannel = null
    this.audioChannel = null

    // H.264 depacketizer state
    this.fuBuf = null
    this.fuType = null
    this.sawSps = false
    this.sawPps = false
    this.sawIdr = false
  }

  // ---------- public API ----------

  async open() {
    await this._connect()
    await this._request('OPTIONS', this.baseUri)
    const describe = await this._authorized('DESCRIBE', this.baseUri, { Accept: 'application/sdp' })
    this.sdp = describe.bodyText
    this._parseSdp()
    return { sdp: this.sdp, track: this.videoTrack, audioTrack: this.audioTrack }
  }

  async play({ audio = false } = {}) {
    if (!this.sdp) await this.open()
    let videoChannel = null
    let audioChannel = null
    if (this.videoTrack) {
      const transport = 'RTP/AVP/TCP;interleaved=0-1'
      const setup = await this._authorized('SETUP', this.videoTrack.controlUri, { Transport: transport })
      this.session = setup.headers.session?.split(';')[0] ?? null
      if (!this.session) throw new RtspError('RTSP SETUP returned no session')
      videoChannel = 0
    }
    if (audio && this.audioTrack) {
      audioChannel = videoChannel === 0 ? 2 : 0
      const aTransport = `RTP/AVP/TCP;interleaved=${audioChannel}-${audioChannel + 1}`
      const aSetup = await this._authorized('SETUP', this.audioTrack.controlUri, { Transport: aTransport })
      this.session = aSetup.headers.session?.split(';')[0] ?? this.session
    }
    this.videoChannel = videoChannel
    this.audioChannel = audioChannel
    await this._authorized('PLAY', this.baseUri, { Range: 'npt=0.000-' })
    this.playing = true
    this._armIdleTimer()
    this._startKeepalive()
    return { sdp: this.sdp, track: this.videoTrack, audioTrack: this.audioTrack }
  }

  async teardown() {
    if (this.closed) return
    this.closed = true
    this._stopKeepalive()
    this._disarmIdleTimer()
    try {
      if (this.socket && this.session) {
        await Promise.race([
          this._authorized('TEARDOWN', this.baseUri).catch(() => {}),
          new Promise(r => setTimeout(r, 1500)),
        ])
      }
    } finally {
      this.socket?.destroy()
      this.socket = null
    }
  }

  // ---------- connection / protocol ----------

  _connect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RtspError(`RTSP connect timeout to ${this.host}:${this.port}`)), 8000)
      this.socket = net.connect({ host: this.host, port: this.port }, () => {
        clearTimeout(timer)
        resolve()
      })
      this.socket.on('data', chunk => this._onData(chunk))
      this.socket.on('error', error => {
        clearTimeout(timer)
        this._fail(maskSecrets(error.message))
      })
      this.socket.on('close', () => {
        if (!this.closed) this._fail('RTSP connection closed by camera')
      })
    })
  }

  _onData(chunk) {
    this._disarmIdleTimer()
    this.buffer = Buffer.concat([this.buffer, chunk])
    try {
      this._processBuffer()
    } catch (error) {
      this._fail(maskSecrets(error.message))
      return
    }
    this._armIdleTimer()
  }

  _processBuffer() {
    for (;;) {
      if (this.buffer.length === 0) return
      if (this.buffer[0] === 0x24) {
        // interleaved frame: '$' channel len16 payload
        if (this.buffer.length < 4) return
        const channel = this.buffer[1]
        const len = this.buffer.readUInt16BE(2)
        if (this.buffer.length < 4 + len) return
        const payload = this.buffer.subarray(4, 4 + len)
        this.buffer = this.buffer.subarray(4 + len)
        if (channel === this.videoChannel && this.videoChannel !== null) {
          this._onRtp(payload, 'video')
        } else if (channel === this.audioChannel && this.audioChannel !== null) {
          this._onRtp(payload, 'audio')
        }
        // other channels = RTCP: ignore
        continue
      }
      const headerEnd = this.buffer.indexOf(CRLF + CRLF)
      if (headerEnd === -1) {
        // Response headers not complete yet.
        if (this.buffer.length > 64 * 1024) throw new RtspError('RTSP response header too large')
        return
      }
      const headerText = this.buffer.subarray(0, headerEnd).toString('latin1')
      const statusLine = headerText.split(CRLF)[0]
      const headers = {}
      for (const line of headerText.split(CRLF).slice(1)) {
        const idx = line.indexOf(':')
        if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
      }
      const contentLength = Number(headers['content-length'] ?? 0)
      if (this.buffer.length < headerEnd + 4 + contentLength) return
      const bodyBuf = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + contentLength)
      this.buffer = this.buffer.subarray(headerEnd + 4 + contentLength)

      const cseq = Number(headers.cseq ?? -1)
      const pending = this.pending.get(cseq)
      const statusCode = Number(statusLine.split(' ')[1] ?? 0)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(cseq)
        pending.resolve({
          statusCode,
          statusLine,
          headers,
          bodyText: bodyBuf.toString('utf8'),
          bodyBuf,
        })
      } else if (statusCode >= 400) {
        // Unsolicited error (e.g. keepalive on dead session)
        log.warn(`rtsp: unsolicited ${statusLine}`)
      }
    }
  }

  _request(method, uri, extraHeaders = {}) {
    const cseq = ++this.cseq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cseq)
        reject(new RtspError(`RTSP ${method} timed out`))
      }, 8000)
      this.pending.set(cseq, { method, resolve, reject, timer })
      this._sendRequest(method, uri, { CSeq: String(cseq), 'User-Agent': 'HUGO-Eye/0.1', ...extraHeaders })
    })
  }

  _authorized(method, uri, extraHeaders = {}) {
    return this._request(method, uri, { ...extraHeaders, ...(this._authHeader(method, uri) ?? {}) })
      .then(response => {
        if (response.statusCode === 401 && !this.authWorked) {
          const wwwAuth = response.headers['www-authenticate']
          if (!wwwAuth) throw new RtspError('camera returned 401 without WWW-Authenticate')
          this.challenge = this._parseChallenge(wwwAuth)
          // Retry once with credentials derived from the challenge.
          return this._request(method, uri, {
            ...extraHeaders,
            ...(this._authHeader(method, uri, { force: true }) ?? {}),
          }).then(retry => {
            if (retry.statusCode === 401) throw new RtspError('RTSP authentication failed (401 after digest/basic attempt)')
            this.authWorked = true
            return retry
          })
        }
        if (response.statusCode >= 400) throw new RtspError(`RTSP ${method} failed: ${response.statusLine}`)
        return response
      })
  }

  _sendRequest(method, uri, headers) {
    let msg = `${method} ${uri} RTSP/1.0${CRLF}`
    for (const [key, value] of Object.entries(headers)) msg += `${key}: ${value}${CRLF}`
    if (this.session && method !== 'OPTIONS') msg += `Session: ${this.session}${CRLF}`
    msg += CRLF
    this.socket.write(msg, 'latin1')
  }

  // ---------- auth (RFC 2617 digest, or Basic fallback) ----------

  _parseChallenge(headerValue) {
    const scheme = headerValue.split(' ')[0].toLowerCase()
    const params = {}
    const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g
    let m
    while ((m = re.exec(headerValue)) !== null) {
      params[m[1].toLowerCase()] = m[2] ?? m[3]
    }
    return { scheme, params }
  }

  _authHeader(method, uri, { force = false } = {}) {
    if (!this.challenge && !force) return null
    if (!this.challenge) return null
    const { scheme, params } = this.challenge
    if (scheme === 'basic') {
      const token = Buffer.from(`${this.username}:${this.password}`).toString('base64')
      return { Authorization: `Basic ${token}` }
    }
    if (scheme !== 'digest') throw new RtspError(`unsupported RTSP auth scheme: ${scheme}`)
    const realm = params.realm ?? ''
    const nonce = params.nonce ?? ''
    const algorithm = (params.algorithm ?? 'MD5').replace('-', '').toLowerCase() // md5 / shasea? handle md5-sess as md5 fallback
    const hash = algorithm.startsWith('sha')
      ? data => crypto.createHash(algorithm === 'sha256' ? 'sha256' : 'sha1').update(data).digest('hex')
      : data => crypto.createHash('md5').update(data).digest('hex')
    this.nc += 1
    const nc = String(this.nc).padStart(8, '0')
    const cnonce = crypto.randomBytes(8).toString('hex')
    const qop = params.qop?.split(',')[0].trim() ?? null // 'auth'
    const ha1 = hash(`${this.username}:${realm}:${this.password}`)
    const ha2 = hash(`${method}:${uri}`)
    let response
    if (qop) {
      response = hash(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    } else {
      response = hash(`${ha1}:${nonce}:${ha2}`)
    }
    let value = `Digest username="${this.username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`
    if (params.opaque) value += `, opaque="${params.opaque}"`
    if (qop) value += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`
    if (params.algorithm) value += `, algorithm=${params.algorithm}`
    return { Authorization: value }
  }

  // ---------- SDP ----------

  _parseSdp() {
    const lines = this.sdp.split(/\r?\n/)
    let inVideo = false
    let inAudio = false
    let payloadType = null
    let control = null
    let spropSps = null
    let spropPps = null
    let sessionControl = null
    let audioPt = null
    let audioControl = null
    let audioCodec = null
    let hadAudio = false
    for (const line of lines) {
      if (line.startsWith('m=video')) {
        inVideo = true
        inAudio = false
        payloadType = Number(line.trim().split(/\s+/)[3])
        continue
      }
      if (line.startsWith('m=audio')) {
        inAudio = true
        inVideo = false
        hadAudio = true
        audioPt = Number(line.trim().split(/\s+/)[3])
        continue
      }
      if (line.startsWith('m=')) {
        inVideo = false
        inAudio = false
      }
      if (!inVideo && !inAudio) {
        if (line.startsWith('a=control:')) sessionControl = line.slice(10).trim()
        continue
      }
      if (inVideo) {
        if (line.startsWith('a=control:')) control = line.slice(10).trim()
        if (line.startsWith('a=rtpmap:')) {
          const pt = Number(line.slice(9).split(' ')[0])
          const codec = line.slice(9).split(' ')[1] ?? ''
          if (payloadType === null || pt === payloadType) {
            if (!codec.toUpperCase().startsWith('H264')) {
              throw new RtspError(`video track is ${codec}, only H.264 is supported`)
            }
            payloadType = pt
          }
        }
        const fmtp = line.match(/a=fmtp:(\d+)\s+(.*)/)
        if (fmtp) {
          const sprop = fmtp[2].match(/sprop-parameter-sets=([^,\s;]+),([^,\s;]+)/)
          if (sprop) {
            spropSps = sprop[1]
            spropPps = sprop[2]
            if (payloadType === null) payloadType = Number(fmtp[1])
          }
        }
        continue
      }
      // audio section
      if (line.startsWith('a=control:')) audioControl = line.slice(10).trim()
      if (line.startsWith('a=rtpmap:')) {
        const pt = Number(line.slice(9).split(' ')[0])
        const codec = (line.slice(9).split(' ')[1] ?? '').toUpperCase()
        if (pt === audioPt) audioCodec = codec.split('/')[0]
      }
    }
    if (payloadType === null) throw new RtspError('no video track found in SDP')
    let controlUri
    if (control && /^rtsp:\/\//i.test(control)) controlUri = control
    else if (control && control !== '*') controlUri = `${this.baseUri}/${control.replace(/^\//, '')}`
    else controlUri = this.baseUri
    this.videoTrack = { payloadType, controlUri, spropSps, spropPps }
    if (hadAudio) {
      let audioUri
      if (audioControl && /^rtsp:\/\//i.test(audioControl)) audioUri = audioControl
      else if (audioControl && audioControl !== '*') audioUri = `${this.baseUri}/${audioControl.replace(/^\//, '')}`
      else audioUri = this.baseUri
      this.audioTrack = audioCodec === 'PCMA' ? { payloadType: audioPt, controlUri: audioUri, codec: 'PCMA' } : null
    }
  }

  // ---------- RTP / H.264 ----------

  _onRtp(packet, kind = 'video') {
    if (packet.length < 12) return
    const b0 = packet[0]
    const version = b0 >> 6
    if (version !== 2) return
    const expectedPt = kind === 'video' ? this.videoTrack?.payloadType : this.audioTrack?.payloadType
    const payloadType = packet[1] & 0x7f
    if (expectedPt !== undefined && expectedPt !== null && payloadType !== expectedPt) return
    const timestamp = packet.readUInt32BE(4)
    if (kind === 'audio') {
      this.emit('rtp', packet, { kind })
      const payload = this._rtpPayload(packet)
      if (payload && payload.length > 0) this.emit('audio', payload)
      return
    }
    const payload = this._rtpPayload(packet)
    if (!payload || payload.length === 0) return
    this.emit('rtp', packet, { kind })
    this._h264Payload(payload, packet[1] >> 7, timestamp)
  }

  /** RTP header parse → payload (handles CSRC, extension, padding). */
  _rtpPayload(packet) {
    const b0 = packet[0]
    const padding = (b0 >> 5) & 1
    const extension = (b0 >> 4) & 1
    const csrcCount = b0 & 0x0f
    let offset = 12 + csrcCount * 4
    if (extension) {
      if (packet.length < offset + 4) return null
      const extLen = packet.readUInt16BE(offset + 2)
      offset += 4 + extLen * 4
    }
    if (offset > packet.length) return null
    let payload = packet.subarray(offset)
    if (padding) {
      const padLen = packet[packet.length - 1]
      if (padLen === 0 || payload.length < padLen) return null
      payload = payload.subarray(0, payload.length - padLen)
    }
    return payload
  }

  _emitNal(nal, auEnd, ts) {
    const type = nal[0] & 0x1f
    const annexb = Buffer.concat([Buffer.from([0, 0, 0, 1]), nal])
    if (type === 7) this.sawSps = true
    if (type === 8) this.sawPps = true
    if (type === 5) this.sawIdr = true
    this.emit('annexb', annexb, { type, idr: type === 5, auEnd, ts })
  }

  _h264Payload(payload, auEnd, ts) {
    const nalType = payload[0] & 0x1f
    if (nalType >= 1 && nalType <= 23) {
      this.fuBuf = null
      this._emitNal(payload, auEnd, ts)
    } else if (nalType === 24) {
      // STAP-A: all NALs share this packet's AU boundary marker
      this.fuBuf = null
      let offset = 1
      while (offset + 2 <= payload.length) {
        const size = payload.readUInt16BE(offset)
        offset += 2
        if (size === 0 || offset + size > payload.length) break
        this._emitNal(payload.subarray(offset, offset + size), auEnd, ts)
        offset += size
      }
    } else if (nalType === 28) {
      // FU-A
      const fuHeader = payload[1]
      const start = (fuHeader & 0x80) !== 0
      const end = (fuHeader & 0x40) !== 0
      if (start) {
        const reconstructed = Buffer.from([(payload[0] & 0xe0) | (fuHeader & 0x1f)])
        this.fuBuf = [reconstructed, payload.subarray(2)]
        this.fuType = fuHeader & 0x1f
      } else if (this.fuBuf) {
        // FU-A continuation: [indicator][header][data] — skip BOTH header bytes.
        this.fuBuf.push(payload.subarray(2))
      }
      if (end && this.fuBuf) {
        const nal = Buffer.concat(this.fuBuf)
        this.fuBuf = null
        this._emitNal(nal, auEnd, ts)
      }
    } else {
      // MTAP 16/24 or FU-B: not expected on TCP interleaved; ignore.
      this.fuBuf = null
    }
  }

  // ---------- keepalive / watchdog ----------

  _startKeepalive() {
    this._stopKeepalive()
    this.keepaliveTimer = setInterval(() => {
      if (this.closed || !this.socket) return
      this._request('GET_PARAMETER', this.baseUri).catch(() => {})
    }, this.keepaliveMs)
    this.keepaliveTimer.unref()
  }

  _stopKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = null
  }

  _armIdleTimer() {
    this._disarmIdleTimer()
    this.idleTimer = setTimeout(() => {
      if (!this.closed) this._fail(`no RTSP data for ${this.idleTimeoutMs}ms`)
    }, this.idleTimeoutMs)
    this.idleTimer.unref()
  }

  _disarmIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  _fail(message) {
    if (this.closed) return
    this.closed = true
    this._stopKeepalive()
    this._disarmIdleTimer()
    this.socket?.destroy()
    this.socket = null
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new RtspError(message))
    }
    this.pending.clear()
    // Only emit when someone listens — an unhandled 'error' would crash the process.
    if (this.listenerCount('error') > 0) this.emit('error', new RtspError(message))
    this.emit('closed')
  }
}

/**
 * Waits for a decodable keyframe sequence (SPS+PPS+IDR) and returns Annex-B bytes.
 * Uses in-stream parameter sets; falls back to SDP sprop values.
 */
export function collectKeyframe(client, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let inIdr = false
    const chunks = []
    let sawSps = false
    let sawPps = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new RtspError(`no keyframe within ${timeoutMs}ms`))
    }, timeoutMs)

    function finish() {
      if (settled) return
      settled = true
      cleanup()
      const sps = chunks.sps ?? annexbFromSprop(client.videoTrack?.spropSps)
      const pps = chunks.pps ?? annexbFromSprop(client.videoTrack?.spropPps)
      const out = []
      if (sps) out.push(sps)
      if (pps) out.push(pps)
      out.push(...chunks.idrNals)
      resolve(Buffer.concat(out))
    }

    const idrNals = []
    chunks.idrNals = idrNals

    function onAnnexb(nal, meta) {
      if (settled) return
      if (meta.type === 7) { chunks.sps = nal; sawSps = true; return }
      if (meta.type === 8) { chunks.pps = nal; sawPps = true; return }
      if (meta.idr) {
        inIdr = true
        idrNals.push(nal)
        return
      }
      if (inIdr && meta.type === 1) {
        // First P-slice after the IDR: the keyframe access unit is complete.
        finish()
      }
      // NALs before the IDR (late-joining P slices, AUD, SEI) are ignored —
      // they reference an older keyframe we never received.
    }

    function onError(error) {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    function cleanup() {
      clearTimeout(timeout)
      client.off('annexb', onAnnexb)
      client.off('error', onError)
      client.off('closed', onClosed)
    }

    function onClosed() {
      onError(new RtspError('RTSP stream closed before keyframe'))
    }

    client.on('annexb', onAnnexb)
    client.on('error', onError)
    client.on('closed', onClosed)
    void sawSps
    void sawPps
  })
}

function annexbFromSprop(b64) {
  if (!b64) return null
  try {
    return Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(b64, 'base64')])
  } catch {
    return null
  }
}
