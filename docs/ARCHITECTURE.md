# HUGO Eye — System Architecture (V2.1)

> Historischer Stand 2.1 (Anfang Oktober 2026). Spätere Ausbaustufen beschreiben [EYE022_DESIGN.md](EYE022_DESIGN.md) und [EYE023_REPORT.md](EYE023_REPORT.md); den aktuellen Stand fasst [PROJEKTSTAND.md](PROJEKTSTAND.md) zusammen. Die HUGO-Schnittstelle meldet heute 13 Fähigkeiten, und die Gesichtserkennung ist inzwischen umgesetzt.

Status: implemented and verified on hardware (see `docs/BENCHMARKS-latest.txt`
and the release report). Product: premium local-first indoor smart-camera
platform. Baselines: `baseline-0.1.0` (garden foundation), `baseline-2.0.0`
(pre-hardening V2 checkpoint).

## 1. Product boundaries

- HUGO Eye is an independent appliance: camera transport, control, media,
  intelligence, reliability. Runs on Ubuntu; no cloud dependency; media and
  inference never leave the machine.
- HUGO Core (future, optional) integrates through the governed `DeviceAdapter`
  boundary (`src/adapter/deviceAdapter.js`) — 11 declared capabilities incl.
  `subscribe_events`; Core never receives credentials or filesystem access.
- RediON archives remain read-only legacy assets; the active product database
  and media library are fully separated.

## 2. Technology decisions & justification

| Layer | Choice | Why |
|---|---|---|
| Service runtime | Node 22 ESM, zero *required* npm runtime deps | systemd-native, minimal supply chain; `onnxruntime-node` is an **optional** dependency for AI (graceful `not_installed` state) |
| Camera transport | Own RTSP 1.0 client (digest auth in-process, TCP-interleaved RTP) | Security requirement: no credentials in argv/env/logs; verified against C520WS incl. FU-A edge cases |
| Media distribution | **RelayHub** — one authenticated RTSP session per stream path, in-process **pipe fan-out** to consumers | The camera serves one session per path; pipes eliminate the UDP port-pair race class (proven EADDRINUSE failures in the V2 journal), give natural backpressure, and need no SDP temp files |
| Live video | **MSE/fMP4** (H.264 copied, near-zero CPU) with automatic **MJPEG** fallback | Measured: MSE path joins in ≤0.7 s warm; MJPEG stays as the universal fallback (share links, old browsers) |
| Recordings | stdin-H.264 → segmented MPEG-TS (60 s) → remuxed finalized MP4 | Crash-safe by design; deterministic stop via pipe EOF; real segment timestamps from strftime filenames |
| Intelligence | In-process motion (gray frame-diff) + **person/object detection (YOLOv8n via onnxruntime-node CPU)** | Measured 112 ms/inf single-thread ≈ 20 % of one core at 2 fps; honest provider states (`not_installed/inactive/starting/active/error`); face recognition deliberately not implemented |
| Frontend | React 19 + TypeScript + Vite + Tailwind 4, static build served by the service | Single appliance artifact; MSE player with codec detection from the init segment |
| Database | SQLite via `node:sqlite` (schema v2) | Zero-dep, WAL, adequate |

## 3. Service architecture

```
hugo-eye.service (systemd --user, linger)
 └─ node src/index.js
     ├─ config (.env 600) — connection + privacy/storage defaults
     ├─ db (SQLite: presets, camera_settings, recordings, sessions,
     │      audit, events(+confidence/thumb), media, health, kv)
     ├─ RelayHub (per camera+path)  — session state machine:
     │     idle → connecting → streaming ⇄ recovering → idle
     │   media probe classifies the camera path-lock; bounded backoff;
     │   8 s silence watchdog; GOP-aligned pipe fan-out with per-consumer
     │   backpressure (drop-to-keyframe for live, bounded buffer + overflow
     │   signal for recording); bounded pre-event GOP ring
     ├─ SharedTranscoderPool — one ffmpeg per camera/quality/kind, teed to
     │   viewers (MJPEG + fMP4); late viewers join at the next frame boundary
     ├─ consumers: live viewers, snapshots (own short RTSP session on main),
     │   recordings (+gated PCMA→AAC audio), motion analyzer, AI RGB source,
     │   audio listen (PCMA→WAV)
     ├─ intelligence (motion provider, person/object provider, SSE bus,
     │   bounded automations)
     ├─ security (sessions, stream grants, same-origin, audit, rate limits,
     │   security headers, per-client stream caps)
     └─ API v2.1 + static UI (ui/dist) + Compact Panel route
```

## 4. Key flows

- **Live**: UI fetches `/api/cameras/:id/stream.fmp4` (cookie) → MSE;
  fallback `/stream.mjpeg?grant=…` for incompatible clients (grant, 90 s).
  Video is copied, never re-encoded on this path; orientation is applied by
  the client (CSS transform) and mirrored in the PTZ mapping
  (`src/orientation.js`), so screen directions match what the user sees.
- **Record**: privacy gate `recordingEnabled` + per-camera switch + disk
  guard → hub record subscriber (no drops; 8 MB/pipe buffer; overflow stops
  the recording cleanly) → segmented TS → remuxed MP4s registered with real
  timestamps. Optional pre-event buffer (`motion.preBufferGops`) seeds
  complete past GOPs at the next keyframe — seam-free.
- **Motion**: rotated gray 160×90 @2 fps → mean-absolute-diff → threshold,
  dedup window → event + thumbnail + SSE; optional zone (future: same polygon
  machinery as AI).
- **Person/object**: 640×640 RGB @`ai.inferenceFps` → YOLOv8n (CPU) → NMS →
  class filter + polygon zone (box center) → dedup → typed event with cropped
  thumbnail → optional automation recording.
- **Audio listen**: gated by `microphoneEnabled`; PCMA 8 kHz → WAV. Two-way
  talk remains unavailable locally (Tapo native protocol only).

## 5. Capability matrix — TP-Link Tapo C520WS (honest)

| Capability | Status | Via |
|---|---|---|
| Live RTSP (main/sub), H.264 | **verified** | RTSP |
| Live MSE/fMP4 playback | **verified** (Chromium; Firefox same engine path — Firefox/iOS pending real-device check) | RTSP+hub+ffmpeg copy |
| Snapshot (full-res) | **verified** | RTSP+ffmpeg |
| PTZ continuous pan/tilt/zoom, stop | **verified** | ONVIF |
| Absolute move / stored positions | **verified** | ONVIF + DB |
| Health/connection | **verified** | TCP+ONVIF |
| Audio listen (mic → WAV) | **available** (gated) | RTSP PCMA |
| Recording (video, +audio when mic enabled) | **available** (gated) | RTSP+hub |
| Motion detection | **available** (gated, local) | in-process |
| Person/object detection | **available** (gated, local; model + runtime installed via `npm run ai:setup`) | onnxruntime-node CPU |
| Two-way talk / siren / light / IR toggle | **unavailable locally** — Tapo native protocol, not exposed via ONVIF/RTSP | — |
| Face recognition | **not implemented** — requires privacy design + owner enrollment | — |

## 6. Security model

- AuthN: master token (scripts) or DB-backed session cookie (12 h, revocable,
  listed in Settings → Access). Constant-time comparisons everywhere.
- Streams: short-lived HMAC grants (90 s); every stream route accepts session
  or grant; per-client concurrent stream cap (4) and per-camera subscriber
  cap (12); rate limits on grants, snapshots, media.
- CSRF/same-origin for cookie-authenticated mutations; JSON content-type
  enforced; security headers on every response (CSP, nosniff, DENY framing).
- Privacy gates: recording, microphone, AI, person detection — all disabled
  by default, enforced server-side (403 + explicit UI state).
- Secrets: `.env` 600; credentials exist only inside RTSP/ONVIF auth headers
  and are masked in every log path (unit-tested). No child process ever
  receives a credential (all media flows through in-process pipes).
- Audit: logins, gate changes, recordings, deletions, config edits.

## 7. Known limits & honest deviations

- The camera blackholes a stream path for a vendor-defined window after a
  session that died without TEARDOWN (process crash). The hub's media probe
  + bounded backoff recovers as fast as the camera allows; during that window
  the UI shows `relay recovering` instead of hanging.
- Live first-frame latency is keyframe-bound (measured GOP ≈ 2.5 s, fps 12.5):
  cold MJPEG join ≈ 2.7–2.9 s; warm joins ≈ 0.1 s (MJPEG) / ≤0.7 s (fMP4).
- ORT thread spinning: 1 intra-op thread is the measured optimum (see
  `src/ai/sessions.mjs`); the node binding ignores the spin-disable config.
- 24-hour soak: started with this release; see `docs/BENCHMARKS-latest.txt`
  for the live status — a planned soak is never reported as completed.
- Firefox/iOS playback uses the same standard paths (MSE or MJPEG) but is
  only verified on Chromium so far.
