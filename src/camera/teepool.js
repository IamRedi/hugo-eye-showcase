import { Readable } from 'node:stream'
import { getHub } from './hub.js'
import { firstOutput } from './ffmpeg.js'
import { log } from '../log.js'

/**
 * SharedTranscoderPool — one ffmpeg transcoder per (camera, quality, kind)
 * session, teed to any number of viewers. A late viewer attaches to the
 * already-running output instead of paying a second GOP-aligned transcoder
 * start (measured: warm transcoder start costs up to a full camera keyframe
 * interval on the C520WS, even when the hub already streams).
 *
 * Backpressure is per viewer: each tee target gets a bounded buffer; a slow
 * viewer drops data at the next stream boundary (MJPEG frame header / fMP4
 * fragment) and can never stall the shared transcoder or other viewers.
 *
 * After the last viewer leaves, the session is kept warm for a short grace
 * period (view toggles rejoin instantly), then torn down to free the camera.
 */

const CLIENT_BUFFER_MAX = 3 * 1024 * 1024
const GRACE_MS = 10_000

class TeeClient {
  constructor(boundary, boundaryBack = 0) {
    this.boundary = boundary
    this.boundaryBack = boundaryBack
    this.readable = new Readable({
      read() { /* push-driven; drain signals resume */ },
      highWaterMark: 512 * 1024,
    })
    this.pendingBytes = 0
    this.dropping = false
    this.closed = false
    this.readable.on('error', () => { this.closed = true })
  }

  push(chunk) {
    if (this.closed) return
    if (this.dropping) {
      const idx = chunk.indexOf(this.boundary)
      if (idx === -1) return
      this.dropping = false
      // resume before the boundary marker when the container needs its
      // size prefix (fMP4 boxes: [size]['moof'])
      chunk = chunk.subarray(Math.max(0, idx - this.boundaryBack))
    }
    this.pendingBytes += chunk.length
    if (this.readable.push(chunk) === false && this.pendingBytes > CLIENT_BUFFER_MAX) {
      this.dropping = true
      this.pendingBytes = 0
    }
  }

  release() {
    this.closed = true
    try { this.readable.destroy() } catch { /* gone */ }
  }
}

export class SharedTranscoderPool {
  /**
   * @param driver camera driver (provides cam + orientationFilters)
   * @param factory ({ streamFps }) → ffmpeg child with .stdout and .stop()
   * @param kind label for logs ('mjpeg' | 'fmp4')
   * @param boundary Buffer marking a safe resync point in the output stream
   * @param initCapturer optional async (chunks[]) → init-bytes prefix for late joiners (fMP4)
   */
  constructor(driver, factory, kind, boundary, boundaryBack = 0) {
    this.driver = driver
    this.factory = factory
    this.kind = kind
    this.boundary = boundary
    this.boundaryBack = boundaryBack
    this.sessions = new Map() // key → session
  }

  /**
   * Returns { stream, transport, stop() }. `stop` must be called exactly once
   * when the consumer disconnects.
   */
  async acquire({ quality = 'sub', streamFps = 15, transport, contentType }) {
    const key = `${quality}`
    let session = this.sessions.get(key)
    if (session) {
      // Late joiner: replay the fMP4 init prefix when present, then resume at
      // the next frame/fragment boundary (never mid-frame). Wait for a session
      // still starting FIRST — initBytes are captured by the pump during
      // startup, so reading them too early would miss the init entirely.
      if (session.starting) {
        try { await session.starting } catch { /* founder failed → new session below */ }
      }
      if (!this.sessions.has(key)) {
        this.sessions.delete(key)
        return this.acquire({ quality, streamFps, transport, contentType })
      }
      const client = new TeeClient(this.boundary, this.boundaryBack)
      if (session.initBytes) client.push(session.initBytes)
      client.dropping = true
      session.clients.add(client)
      session.touch()
      return { stream: client.readable, transport, contentType, stop: () => this._release(key, client) }
    }

    session = {
      clients: new Set(), transcoder: null, handle: null, initBytes: null, initAccum: null, graceTimer: null, starting: null,
      touch() { if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null } },
    }
    this.sessions.set(key, session)
    const founder = new TeeClient(this.boundary, this.boundaryBack)
    founder.dropping = this.kind !== 'fmp4'  // founder of fMP4 needs the init bytes
    session.clients.add(founder)
    session.starting = (async () => {
      const hub = getHub(this.driver.cam, quality === 'main' ? this.driver.cam.mainPath : this.driver.cam.subPath)
      const handle = await hub.subscribe({ kind: this.kind === 'fmp4' ? 'fmp4' : 'live' })
      const transcoder = this.factory({ streamFps: Math.max(5, Math.round(hub.fps ?? 15)) })
      handle.attach({ video: transcoder.stdin })
      transcoder.stop = (orig => () => {
        try { handle.detach() } catch { /* already */ }
        orig()
      })(transcoder.stop.bind(transcoder))
      transcoder.stdout.on('error', () => { /* client teardown races */ })
      // pump BEFORE waiting for output: the very first chunk carries the
      // fMP4 init boxes (ftyp+moov) — attaching later would lose them.
      const pump = chunk => {
        if (this.kind === 'fmp4' && session.initBytes === null) this._captureFmp4Init(session, chunk)
        for (const client of [...session.clients]) client.push(chunk)
      }
      transcoder.stdout.on('data', pump)
      try {
        await firstOutput(transcoder.stdout, 20_000)
      } catch (error) {
        transcoder.stdout.off('data', pump)
        throw error
      }
      session.transcoder = transcoder
      session.handle = handle

      transcoder.stdout.on('close', () => {
        // transcoder died (hub loss etc.) — drop the whole session; clients
        // see EOF and the UI reconnects (which rebuilds from the hub).
        for (const client of session.clients) client.release()
        session.clients.clear()
        this.sessions.delete(key)
      })
      log.info(`camera ${this.driver.id}: shared ${this.kind} session (${quality}) started`)
    })()

    try {
      await session.starting
    } catch (error) {
      this.sessions.delete(key)
      founder.release()
      session.transcoder?.stop()
      throw error
    } finally {
      session.starting = null
    }

    return { stream: founder.readable, transport, contentType, stop: () => this._release(key, founder) }
  }

  /** fMP4: the leading boxes (ftyp+moov) must be replayed to every joiner. */
  _captureFmp4Init(session, chunk) {
    session.initAccum ??= []
    session.initAccum.push(chunk)
    const buf = Buffer.concat(session.initAccum)
    const idx = buf.indexOf(Buffer.from('moof'))
    if (idx !== -1 && idx >= 8) {
      session.initBytes = buf.subarray(0, idx - 4)  // boxes before the first fragment
      session.initAccum = null
    }
  }

  _release(key, client) {
    const session = this.sessions.get(key)
    if (!session) { client.release(); return }
    session.clients.delete(client)
    client.release()
    session.touch()
    if (session.clients.size === 0 && !session.graceTimer) {
      session.graceTimer = setTimeout(() => {
        session.graceTimer = null
        if (session.clients.size > 0) return
        const s = this.sessions.get(key)
        if (s !== session) return
        this.sessions.delete(key)
        s.transcoder?.stop()
        log.info(`camera ${this.driver.id}: shared ${this.kind} session (${key}) idle — stopped`)
      }, GRACE_MS)
      session.graceTimer.unref?.()
    }
  }

  stopAll() {
    for (const [, session] of this.sessions) {
      clearTimeout(session.graceTimer)
      for (const client of session.clients) client.release()
      session.clients.clear()
      session.transcoder?.stop()
    }
    this.sessions.clear()
  }
}
