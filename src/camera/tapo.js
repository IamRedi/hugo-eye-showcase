import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createOnvifClient, vectorForCommand } from './onvif.js'
import { RtspClient, collectKeyframe } from './rtsp.js'
import { getHub } from './hub.js'
import {
  decodeAnnexbToJpeg, startPipeMjpegTranscoder, startPipeFmp4Transcoder, startPipeAudioWav, bufferedOutput,
} from './ffmpeg.js'
import { SharedTranscoderPool } from './teepool.js'
import { videoFilters } from '../orientation.js'
import { config, redactedRtspUrl } from '../config.js'
import { log } from '../log.js'

/**
 * TapoDriver — ONVIF Profile S + RTSP H.264. Works for the TP-Link Tapo C520WS
 * and, by construction, any camera exposing ONVIF PTZ + RTSP H.264 over TCP.
 * Implements the CameraDriver contract (see src/camera/driver.js).
 *
 * `orientation` ({rotate, mirror, flip}) is applied to every pixel path
 * (live, snapshots, recordings, thumbnails). PTZ commands are remapped by the
 * caller (src/orientation.js mapPtzCommand) before reaching this driver.
 */
export class TapoDriver {
  constructor(camConfig, getOrientation = () => ({ rotate: 0, mirror: false, flip: false })) {
    this.id = camConfig.id
    this.kind = 'tapo'
    this.cam = camConfig
    this.getOrientation = getOrientation
    this.onvif = createOnvifClient(camConfig)
    // Shared viewer sessions: one transcoder teed to all viewers — late
    // viewers join instantly instead of paying another camera keyframe wait.
    this.livePool = new SharedTranscoderPool(
      this,
      ({ streamFps }) => startPipeMjpegTranscoder({
        streamFps, outFps: 8, scaleWidth: 960,
        filters: this.orientationFilters(),
        onError: error => log.warn(`camera ${this.id}: live stream: ${error.message}`),
      }),
      'mjpeg',
      Buffer.from('--ffmpeg'),
    )
    this.fmp4Pool = new SharedTranscoderPool(
      this,
      ({ streamFps }) => startPipeFmp4Transcoder({
        streamFps,
        onError: error => log.warn(`camera ${this.id}: fmp4 stream: ${error.message}`),
      }),
      'fmp4',
      Buffer.from('moof'),
      4,
    )
    this.capabilities = {
      rtsp: true,
      onvif: false,
      ptz: false,
      onvifProfiles: [],
      videoResolution: null,
      audioListen: false,
    }
  }

  label() {
    return `${this.cam.name} (${this.cam.model} @ ${this.cam.host})`
  }

  /** One-time capability detection; safe to call repeatedly (does not move the camera). */
  async detectCapabilities() {
    try {
      const info = await this.onvif.discover()
      this.capabilities.onvif = true
      this.capabilities.ptz = true
      this.capabilities.onvifProfiles = info.profiles
      this.capabilities.videoResolution = info.videoResolution
      log.info(`camera ${this.id}: ONVIF OK, ${info.profiles.length} profile(s), PTZ available`)
    } catch (error) {
      this.capabilities.onvif = false
      this.capabilities.ptz = false
      log.warn(`camera ${this.id}: ONVIF detection failed: ${error.message}`)
    }
    // device/firmware info (best-effort, displayed in the Cameras page)
    try {
      this.capabilities.deviceInfo = await this.onvif.getDeviceInformation()
    } catch { this.capabilities.deviceInfo = null }
    // NOTE (probed 2026-10-09, fw 1.2.7): this camera's PTZ
    // GetServiceCapabilities reports every flag as false although the
    // operations themselves work — capability FLAGS are untrustworthy on
    // this firmware; operations are verified by use instead.
    return this.capabilities
  }

  /**
   * Honest capability matrix for this hardware. `verified` = tested on this
   * device through the local transports; `available` = exposed by the protocol
   * and implemented here (may be privacy-gated); `unavailable` = requires the
   * vendor-native Tapo protocol and is NOT accessible via ONVIF/RTSP.
   */
  capabilityMatrix() {
    return {
      cameraId: this.id,
      model: this.cam.model,
      verified: [
        { id: 'live_rtsp', label: 'Live RTSP streams (main + sub)', via: 'RTSP H.264 over TCP' },
        { id: 'snapshot', label: 'Full-resolution snapshots', via: 'RTSP + ffmpeg' },
        { id: 'ptz_continuous', label: 'Pan / tilt (continuous, 8-way + stop)', via: 'ONVIF (verified by operation)' },
        { id: 'ptz_absolute', label: 'Absolute move / stored positions', via: 'ONVIF (verified by operation, 0.0000 return error)' },
        { id: 'ptz_position_feedback', label: 'Position feedback (GetStatus)', via: 'ONVIF' },
        { id: 'health', label: 'Connection, stream, health and firmware info', via: 'TCP + ONVIF' },
        { id: 'orientation', label: 'Digital orientation (rotate/mirror/flip + PTZ remap)', via: 'local pipeline' },
        { id: 'audio_listen', label: 'Microphone audio (PCMA 8 kHz)', via: 'RTSP audio track (SDP-confirmed)', gate: 'microphoneEnabled' },
        { id: 'recording', label: 'Recording (video, +audio when mic enabled)', via: 'RTSP', gate: 'recordingEnabled' },
      ],
      unavailable: [
        { id: 'zoom_motor', label: 'Optical/motorized zoom', reason: 'Probed: ONVIF zoom velocity is a no-op (zoom coordinate unchanged after a 0.6-speed 600 ms command); no zoom motor in this model. Digital zoom remains a client-side feature.' },
        { id: 'two_way_talk', label: 'Two-way talk (speaker)', reason: 'Requires the TP-Link native (Tapo) protocol — no ONVIF/RTSP command exists; bypassing vendor auth is out of policy.' },
        { id: 'siren', label: 'Siren', reason: 'Tapo native protocol only — not exposed via ONVIF/RTSP.' },
        { id: 'spotlight', label: 'Spotlight', reason: 'Tapo native protocol only — not exposed via ONVIF/RTSP (auto behavior only).' },
        { id: 'ir_toggle', label: 'IR / night-mode toggle', reason: 'Not exposed via ONVIF on this model/firmware (auto IR).' },
        { id: 'camera_side_events', label: 'Camera-side motion/person events (ONVIF events)', reason: 'Probed: event service unreachable, no topics — camera-side detection stays in the Tapo app; detection runs locally in HUGO Eye instead.' },
        { id: 'firmware_autotracking', label: 'Firmware-native motion tracking', reason: 'No ONVIF surface; not remotely controllable. PTZ auto-follow is implemented in HUGO Eye (software visual servoing).' },
      ],
      available: [],
      hardwareOnly: [
        { id: 'two_way_talk', label: 'Two-way talk (speaker)', reason: 'Requires the TP-Link native protocol — not exposed via ONVIF/RTSP' },
        { id: 'siren', label: 'Siren', reason: 'Tapo native protocol only' },
        { id: 'light', label: 'Camera light', reason: 'Tapo native protocol only' },
        { id: 'ir_toggle', label: 'IR / night-mode toggle', reason: 'Not exposed via ONVIF on this model (auto IR)' },
      ],
      profiles: this.capabilities.onvifProfiles,
      videoResolution: this.capabilities.videoResolution,
    }
  }

  async tcpProbe(port) {
    return new Promise(resolve => {
      const socket = net.connect({ host: this.cam.host, port, timeout: 4000 })
      const done = ok => {
        socket.destroy()
        resolve(ok)
      }
      socket.on('connect', () => done(true))
      socket.on('timeout', () => done(false))
      socket.on('error', () => done(false))
    })
  }

  /** Passive health: TCP reachability + ONVIF GetStatus (does not move the camera). */
  async health() {
    const rtspOk = await this.tcpProbe(this.cam.rtspPort)
    let onvifOk = false
    let position = null
    let detail = ''
    try {
      position = await this.onvif.getStatus()
      onvifOk = true
    } catch (error) {
      detail = error.message
    }
    return {
      ok: rtspOk && onvifOk,
      rtspOk,
      onvifOk,
      position,
      detail,
      checkedAt: new Date().toISOString(),
    }
  }

  async getStatusPosition() {
    return this.onvif.getStatus()
  }

  orientationFilters() {
    return videoFilters(this.getOrientation(this.id))
  }

  /**
   * Captures one full-resolution snapshot (main stream), rotated per the
   * camera's presentation orientation. Opens a short-lived dedicated RTSP
   * session; while a main-path live view is active the camera may refuse the
   * second session (one session per path), so one retry is attempted before
   * surfacing the failure.
   */
  async snapshot({ zone = 'camera' } = {}) {
    let lastError = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) await new Promise(r => setTimeout(r, 2000))
      const client = new RtspClientShort(this.cam, this.cam.mainPath)
      try {
        await client.play()
        log.info(`camera ${this.id}: RTSP session up (${redactedRtspUrl(this.cam, 'main')}), waiting keyframe`)
        const annexb = await collectKeyframe(client, { timeoutMs: 8000 })
        const jpeg = await decodeAnnexbToJpeg([annexb], { filters: this.orientationFilters() })
        return { zone, jpeg }
      } catch (error) {
        lastError = error
      } finally {
        await client.teardown().catch(() => {})
      }
    }
    throw new Error(`snapshot failed: ${lastError?.message ?? 'unknown'}`)
  }

  /**
   * Live RTSP->MJPEG preview over the sub stream via the local RTP relay.
   * Returns { contentType, stream (Readable), stop(), transport }.
   */
  async liveStream({ quality = 'sub' } = {}) {
    return this.livePool.acquire({ quality, transport: 'rtsp-hub-mjpeg', contentType: 'multipart/x-mixed-replace; boundary=ffmpeg' })
  }

  /** Modern playback path: shared H.264 → fMP4 session, teed to viewers. */
  async fmp4Stream({ quality = 'sub' } = {}) {
    return this.fmp4Pool.acquire({ quality, transport: 'rtsp-hub-fmp4', contentType: 'video/mp4' })
  }

  /** Gated microphone listen: PCMA → WAV stream from the shared hub. */
  async audioStream() {
    const hub = getHub(this.cam, this.cam.subPath)
    const handle = await hub.subscribe({ kind: 'audio', audio: true })
    const wav = startPipeAudioWav({
      onError: error => {
        log.warn(`camera ${this.id}: audio stream: ${error.message}`)
        try { wav.stdout.destroy() } catch { /* ended */ }
        handle.detach()
      },
    })
    handle.attach({ audio: wav.stdin })
    const origStop = wav.stop.bind(wav)
    wav.stop = () => { try { handle.detach() } catch { /* already */ } ; origStop() }
    let out
    try {
      // Buffered pass-through: the WAV header must reach the consumer even
      // though it arrives before the HTTP response attaches its pump.
      out = await bufferedOutput(wav.stdout, 15_000)
    } catch (error) {
      wav.stop()
      throw error
    }
    return {
      contentType: 'audio/wav',
      stream: out,
      transport: 'rtsp-hub-wav',
      stop: () => wav.stop(),
    }
  }

  /** Continuous PTZ move; the camera auto-stops after 1s (PT1S timeout). */
  async ptzMove(command) {
    const vector = vectorForCommand(command)
    if (!vector) throw new Error(`unsupported PTZ command: ${command}`)
    await this.onvif.continuousMove(vector.x, vector.y, vector.zoom ?? 0)
  }

  /** Continuous move with an explicit physical velocity vector (auto-follow). */
  async ptzMoveVector(x, y, zoom = 0) {
    await this.onvif.continuousMove(x, y, zoom)
  }

  async ptzStop() {
    await this.onvif.stop()
  }

  async gotoPosition({ pan, tilt, zoom }) {
    await this.onvif.absoluteMove({ pan, tilt, zoom })
  }
}

// Snapshot-only RTSP client (no relay/SDP needed for a single frame).
class RtspClientShort extends RtspClient {
  constructor(cam, streamPath) {
    super({
      host: cam.host,
      port: cam.rtspPort,
      path: streamPath,
      username: cam.username,
      password: cam.password,
    })
  }
}

export const DRIVERS = {
  tapo: TapoDriver,
}

export function createDriver(camConfig, getOrientation) {
  const Driver = DRIVERS[camConfig.driver]
  if (!Driver) throw new Error(`unknown camera driver: ${camConfig.driver}`)
  return new Driver(camConfig, getOrientation)
}

export function activeDrivers(getOrientation = () => ({ rotate: 0, mirror: false, flip: false })) {
  return config.cameras.map(cam => createDriver(cam, getOrientation))
}
