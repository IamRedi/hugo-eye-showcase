# HUGO Eye — EYE-023 Final Engineering Report

**Release:** `release-2.2.0` (main @ 372e140, branch eye-023)
**Baseline:** `release-2.1.0` (91fdf45) — preserved; rollback verified
**Date:** 2026-10-09 · **Verifier:** live hardware + 78/78 tests
**Soak:** fresh 24 h soak RUNNING on the deployed release (started
2026-10-09T12:06:59Z, ends ~2026-10-10T12:07Z) — **pending by definition;
not reported as passed**

---

## A. Architecture

The EYE-022 layering was consolidated, not rewritten (program Gate 1):

```
Physical Camera (C520WS, ONVIF+RTSP)
   └─ CameraDriver (src/camera/driver.js contract; tapo.js impl)
       └─ Camera registry (src/cameras.js + DB `cameras` table, schema v4)
           └─ RelayHub (src/camera/hub.js) — ONE authenticated RTSP session
              per camera/path; state machine idle→connecting→streaming⇄
              recovering→idle; GOP-aligned pipe fan-out
               ├─ Live video: MSE/fMP4 + MJPEG fallback (shared transcoders)
               ├─ Audio: PCMA→WAV (listen) / PCMA→AAC (recordings)
               ├─ Recording (src/recordings.js): modes, pre-event GOPs,
               │   rolling post-event window, integrity checks, thumbnails
               └─ VisionRuntime (src/vision/runtime.js) — one shared RGB
                   decode; per-provider latest-wins channels, fps budgets,
                   supervised restart + stall watchdog (new in EYE-023)
                       ├─ Motion provider
                       ├─ Person/object provider (YOLOv8n ONNX)
                       ├─ Face pipeline (YuNet → tracker → SFace → People)
                       ├─ Scene state (staleness-explicit)
                       ├─ Visit sessionizer (new)
                       ├─ Auto-follow controller (new, PTZ)
                       └─ VLM queue (new, Ollama) · Search indexer (new, CLIP)
                           └─ Event engine (publishEvent: DB + bus)
                               ├─ Automation rules (DB-backed, cooldowns)
                               ├─ Search / timeline / Activity UI
                               └─ DeviceAdapter (HUGO Core boundary, intact)
```

New in EYE-023: unified `publishEvent` write path (events reach automations
and SSE reliably — EYE-022 gap), schema v3→v5 migrations (event descriptions,
embeddings, automation runs, camera registry, recording thumbnails,
per-camera retention), `signalBus` for internal non-persisted signals.

## B. Camera control (all probed on Tapo C520WS, fw 1.2.7 Build 260716)

| Capability | Status | Evidence |
|---|---|---|
| Live RTSP main/sub H.264 | **verified** | streams throughout; hub state machine |
| Snapshot full-res | **verified** | production API, 390 ms |
| PTZ continuous pan/tilt + stop | **verified** | live moves; PT1S server-side expiry |
| PTZ absolute move + presets | **verified** | 0.0000 return error (probed) |
| PTZ position feedback (GetStatus) | **verified** | read at every health check |
| Microphone audio (PCMA 8 kHz) | **verified** | SDP shows PCMA/8000; recordings carry AAC |
| Motion/person events from camera | **unavailable** | ONVIF event service unreachable, 0 topics (probed) — HUGO Eye detects locally instead |
| Motorized zoom | **unavailable** | probed: zoom velocity is a no-op (coordinate unchanged); previous "verified" claim corrected |
| Two-way talk (speaker) | **unavailable** | Tapo-native protocol only; no ONVIF/RTSP command; bypassing vendor auth is out of policy |
| Siren / spotlight / IR toggle | **unavailable** | Tapo-native only (same policy) |
| Firmware-native autotracking | **unavailable** | no controllable surface — HUGO Eye implements visual servoing instead |
| PTZ capability FLAGS | **untrustworthy** | GetServiceCapabilities reports all-false while operations work; provenance is "verified by operation" |

Probe tool: `tools/capability-probe.mjs` (writes machine-readable evidence).

## C. VisionRuntime

- Tracker: ByteTrack-style two-stage IoU + **constant-velocity prediction**
  (occlusion bridging), **direction classification**, wall-clock timestamps
  (injectable clock), **PTZ evidence invalidation** (`notifyCameraMoved`).
- Face: YuNet → face tracker → SFace embeddings → calibrated match
  (≥0.363 match, 0.283–0.363 uncertain — band bug fixed; it was unreachable
  in EYE-022). Enrollment quality gates (brightness + Laplacian blur),
  score-test calibration endpoint, wrong-match correction endpoint.
- Evidence discipline: `person_unknown` now requires a sustained (≥3 hits)
  real-sized face track AND carries a cropped thumbnail — a live TV-reflection
  false positive (announced with zero evidence) drove this fix.
- Measured (live camera, dual inference): person p50 95 ms / p95 106 ms at
  2 fps; replay of a real recorded segment: 263 frames, 2.05× realtime,
  chair tracked 97 frames with stable ID, honest re-detection after a PTZ pan.
- Recognition vs enrolled profiles: EYE-022 measured numbers stand
  (same person 0.801 → KNOWN; different person 0.123 → unknown).

## D. Scene intelligence (VLM)

- **Model:** `qwen2.5vl:3b` (Q4_K_M, 3.2 GB) via local Ollama 0.23.2, CPU
  (size_vram 0 — this build ignores the Radeon 680M iGPU).
- **Measured:** warmup 5 s; first encode of a NEW image ≈ 20 s @768px
  (45 s @1024px — 768 is the default); repeated image ≈ 1 s (runtime
  embedding cache); short answers 0.9–1.6 s. RAM while loaded: ~10.8 GB
  (keep_alive 10 m, tunable `HUGO_EYE_VLM_KEEP_ALIVE`).
- **Quality:** grounded on real frames (furniture, states, people presence
  correct); documented limitation case: the model once described the TV
  *reflection* scene and mis-attributed a person's location — descriptions
  are therefore stored as model interpretations with provenance
  (`event_descriptions`: model, time, uncertain flag), never as detections.
- **Non-blocking guarantee:** all inference through VlmQueue — concurrency 1,
  latest-wins per camera, cooldown, bounded queue; live/record/PTZ are never
  blocked (verified: a 3-request server-side pile-up during development
  could not stall media; the queue now serializes on-demand calls too).
- Interfaces: on-demand Q&A (`/api/ai/ask` with stored evidence image),
  event-triggered descriptions, visit summaries.

## E. Smart search

- CLIP ViT-B/32 (int8 ONNX, pinned + checksummed) runs in-process:
  session load 0.7 s, image embed 46 ms, text embed ~37 ms.
- Index: evidence thumbnails of 5 event types; async bounded queue;
  idempotent reindex + backfill; production index live (backfill triggered
  at deploy).
- Verified live (130 indexed events in dev): "someone sitting on a sofa" →
  real sofa evidence first (26–27% cosine); "a television screen" → tv
  events first; person-query in a person-free database returns honest
  low-score matches. Results carry thumbnails, scores, provenance, person
  names, and the covering recording group for direct playback.

## F. PTZ Auto-Follow

- **Compatibility finding:** C520WS exposes ContinuousMove (velocity,
  PT1S expiry), Stop, AbsoluteMove, GetStatus — no vendor autotracking.
  Implemented as closed-loop **visual servoing** on that surface.
- Control: proportional velocity toward a configurable screen region,
  dead zone, saturation, association-after-loss, lost-hold → release,
  optional return-to-home (AbsoluteMove, 0.0000 error measured), bounded
  session; single authoritative controller via the global PTZ lock held
  briefly per tick — **any manual PTZ instantly cancels** (wired into every
  movement origin incl. the DeviceAdapter surface).
- Orientation: `screenVelocityToPhysical` derived from the command tables;
  cross-validated against `mapPtzCommand` for all 32 orientation
  combinations (incl. the 180° mount) — unit-tested both ways.
- **Labeling: implemented + software tested (fake driver/tracker: follow
  direction, dead zone, lost→home, override, disabled gate) + motor-level
  hardware probes (bounded pan measured, home return exact). REAL-PERSON
  FOLLOW WALK-TEST: REQUIRES OWNER.** Feature ships disabled by default.

## G. Recording

- Modes: **continuous** (reconciled on boot/settings/quota; live-verified
  start → clean stop on mode switch, 39.7 s segment), **event-triggered**
  (pre-event GOP seeding now for ALL automation triggers; rolling
  post-event quiet window 10 s default, hard cap 300 s), manual.
- Integrity: every finished segment ffprobe-verified (`corrupt` status on
  failure); mid-clip JPEG thumbnails per group; per-camera retention
  overrides (`camera_settings.retention_days`); quota + retention as before.
- Visit sessions: one continuous person visit = one `visit.summary` event
  with duration, known persons, peak count, and every member event linked
  via `correlation_id` (unit-tested; motion alone never opens a visit).
- Audio: PCMA→AAC verified — a live recording finalized with **h264 + aac**
  streams (13.6 s segment probed).

## H. Premium UI (browser-verified on Chromium desktop)

- New **Search** page (NL query, scores, filters, evidence preview,
  recording link, reindex); Intelligence cards for visual reasoning,
  auto-follow, recording modes; Live click-to-follow + FOLLOWING badge;
  Activity visit sessions + VLM descriptions; Recordings thumbnails +
  corrupt badges; corrected stale honesty text.
- **PWA**: installable (manifest, icon, theme), app-shell service worker
  that never caches `/api/*` or `/media/*` (privacy rule in code).
- LAN access verified (UI 200 + API 401-without-auth via
  192.168.1.20:8764). **Mobile/Android device interaction test: PENDING
  OWNER** (responsive layout in place; touch interactions share the same
  code paths as desktop).

## I. Multi-camera platform

- DB-backed **camera registry** (schema v4): env seeding is idempotent
  (2.x-compatible, live-verified), onboarding REQUIRES verification
  (TCP + RTSP DESCRIBE/SDP + ONVIF device info) — an unreachable camera is
  refused with per-check errors; credential-free listings; removal cleans
  dependent rows and stops follow/recordings first.
- Multi-camera independence proven **synthetically**: two FakeCameras
  stream through independent hubs simultaneously; a locked (offline-like)
  camera stays `recovering` while the other streams (per-camera state).
- **Real second hardware camera: NOT CLAIMED** — no second device was
  available; per-camera settings/retention/zones/presets/media paths are in
  place for it.

## J. Performance (appliance: 16-core AMD, 29 GB RAM, iGPU unused by stack)

| Workload | Measured |
|---|---|
| Person detection (YOLOv8n CPU, 2 fps) | p50 95 ms / p95 106 ms per frame |
| Replay (decode+detect+track, 5 fps) | 2.05× realtime |
| Face detect (YuNet) + embed | per EYE-022: p50 14 ms; SFace on-demand |
| Full stack (continuous rec + motion + person + face) | node 18.6% of one core; RSS ~500 MB; ffmpeg children 8.9% |
| VLM (qwen2.5vl:3b, CPU) | warmup 5 s; new-image describe ≈ 20 s @768px; repeat ≈ 1 s; ~10.8 GB RAM loaded |
| CLIP embed | 46 ms image / ~37 ms text |
| Live stream | MSE/fMP4 join ≤0.7 s warm (EYE-022 baseline maintained); GOP 2.5 s, ~12.5–15 fps |
| Concurrency guard | ≤4 streams/client, ≤12 subscribers/hub, VLM queue bounded |

## K. Reliability

- **Real camera power-loss incident** (owner unplugged overnight, during the
  2.1.0 soak): 11 h 44 m offline; the service detected it in ≤42 s, produced
  exactly 2 events (degraded → recovered), zero crashes/zero ffmpeg churn,
  recovered automatically, all media + DB intact (`PRAGMA quick_check` ok).
  The interrupted soak is **recorded as interrupted** — not a 24 h PASS.
- Worker crash (SIGKILL shared decode): exposed and **fixed a real bug**
  (signal-terminated consumers produced no error → silent stall); now
  auto-recovers (verified live: providers `recovering` → active, frames
  flow, recording uninterrupted). Added a 15 s frame-stall watchdog.
- Disk guard: real 507 + `storage.low_disk` event (verified against tmpfs).
- Service restart / full reboot: clean restart, migrations apply, registry
  seeds, camera re-registers, orphan recordings swept (reboot happened
  for real at 10:32 during development).
- **Fresh 24 h soak: RUNNING on release-2.2.0** (fixed monitor re-authenticates
  on session expiry — the defect that blinded the previous soak's second
  half). Result pending by definition.

## L. Tests

- 78/78 unit + integration tests (node:test): hub lifecycle (11),
  adapter contracts, tracker (13 incl. prediction/direction/PTZ
  invalidation), orientation incl. velocity mapping, registry (4),
  multi-camera synthetic (1), visit sessions, schedule, redaction,
  autofollow controller (7), detector decode.
- Live verifications documented per gate in the commit history
  (branch eye-023, 10 commits).
- **Unverified / pending paths** (honest list):
  - Real-person walk-test: face recognition in view, auto-follow following
    a person (owner participation)
  - Android/physical-device PWA interaction (owner device)
  - Second real camera (no hardware)
  - 24 h soak result (running)
  - Firefox/iOS playback (same standard paths; only Chromium verified,
    inherited from 2.1)

## M. Git delivery

- Branch `eye-023` (10 cohesive commits, gate-by-gate), merged to **main**
  and tagged **`release-2.2.0`**. Working tree = main = deployed code.
- **Rollback**: `release-2.1.0` tag intact and **verified** — 2.1.0 boots
  cleanly against the v5-migrated database (additive migrations), serves
  health/events, leaves the schema untouched.
- Nothing pushed externally (no remote operations performed).
- Deployment: `hugo-eye.service` (systemd user unit) restarted on the final
  code — production healthy (camera OK, RTSP OK, registry seeded, search
  backfill running).

## N. Acceptance

**CONDITIONAL PASS — ready for owner acceptance.**

All engineering gates delivered with live hardware evidence; every
advertised feature works (no fake features). Conditions, all owner-side:

1. **Walk-test**: enroll household members (People), verify in-view
   recognition; click-to-follow a person with auto-follow enabled.
2. **Mobile check**: install the PWA on an Android phone/tablet and confirm
   interactions (expected to work; unverified on hardware).
3. **Soak**: the fresh 24 h run (started 14:06 CEST Oct 9) must complete
   uninterrupted on release-2.2.0 — monitored with session-expiry-proof
   telemetry; a second camera can be onboarded any time via
   Cameras → Camera registry (verified onboarding flow).

Labeling summary: **implemented + hardware tested** — live/record/snapshot/
PTZ/audio-record/health/VLM-QA/search/registry/unplug-recovery;
**implemented + software tested** — auto-follow loop, visit sessions,
multi-camera independence, face matcher calibration;
**requires owner** — walk-test, mobile device, second camera, soak completion;
**unsupported by camera APIs** — two-way talk, siren, spotlight, IR toggle,
zoom motor, camera-side events, native autotracking;
**not implemented** — nothing advertised beyond the above.
