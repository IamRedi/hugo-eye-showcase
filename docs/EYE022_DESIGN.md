# EYE-022 — Vision Runtime & Intelligence Architecture

Status: implemented on branch `eye-022` (5 commits, 40/40 unit tests).
Baseline: `release-2.1.0` (91fdf45). Soak-test note: the release-2.1.0 24 h
soak (ends 2026-10-09 ~17:23 CEST) keeps running untouched on the production
service; deployment of this branch is gated on reviewing that result.

## Measured performance (branch, live camera, dual inference)

| Metric | Measured |
|---|---|
| Shared decode | ~4–5 fps at 640×480 |
| Person inference (YOLOv8n, 640²) | p50 95 ms, p95 112 ms (2 fps budget) |
| Face detection (YuNet, 640×480) | p50 14 ms, p95 108 ms incl. warmup (5 fps budget) |
| Whole service incl. ffmpeg children | ≈ 25 % of one core with both providers |
| node RSS with ORT | ≈ 280 MB |
| Reliability | 10/10 viewer churn cycles; stream uninterrupted through AI toggle; shared-decode SIGKILL recovered automatically |
| Recognition (stored embeddings) | same person 0.801 → KNOWN; different person 0.123 → unknown (threshold 0.363) |

Pending owner participation: live in-view recognition walk-test; enrollment
of real household members. Pending external: HUGO Core pairing (Core has no
repository yet — Eye-side contract + pairing flow are complete).

## 1. Module boundaries (all new modules are independent and testable)

```
RelayHub (existing, untouched — single producer per camera path)
   └─ VisionRuntime (src/vision/runtime.js)   ONE 'analyze' subscription per camera
        ├─ shared decode: hub H.264 → one ffmpeg RGB frame source
        ├─ FrameBus: per-consumer latest-wins slots (no unbounded queues),
        │   per-consumer fps budgets, drop counters, frame {cameraId, ts, rgb}
        ├─ provider registry: motion · person/object (YOLOv8n) · face (YuNet)
        │   each independently start/stop/restart-able; supervised with
        │   bounded backoff; a stopped provider consumes zero frames
        └─ stats: inference latency p50/p95, effective fps, drops, last error
   └─ consumers (unchanged paths): live viewers (tee pool), recordings,
        snapshots, audio listen
```

- **Person/object pipeline**: frames → YOLOv8n → NMS → class filter →
  zone check → **Tracker** → typed events + SceneState.
- **Tracker** (src/vision/tracker.js): greedy IoU matching with two passes
  (high confidence first, then low-confidence rescue — ByteTrack-inspired),
  track lifecycle `new → active → lost → removed`, hysteresis (minHits,
  maxAge), zone enter/exit/dwell, movement direction. Track IDs are opaque
  correlation handles, never identities.
- **Scene state** (src/vision/scene.js): per camera `{online, persons:[{trackId,
  familiar, confidence, since}], objects:{class:count}, zones, lastChangeAt,
  updatedAt}` — freshness-bounded; queries report staleness explicitly.
- **Face pipeline** (src/ai/faces.js): YuNet face detection (Apache-2.0,
  232 KB) → track faces across frames (same tracker core) → landmark-aligned
  112×112 crops → SFace embeddings (Apache-2.0, 37 MB) → cosine match against
  enrolled profiles → calibrated accept/uncertain/reject. Strictly separated:
  *face detected* ≠ *face tracked* ≠ *person identified*. Enrollment is
  owner-driven (People UI); unknown persons stay unknown.
- **People registry** (src/people.js): SQLite tables (`people`,
  `face_images` with embeddings BLOB); enrollment from uploaded images or
  camera snapshots; add/remove references; per-profile enable; delete removes
  embeddings. Recognition is opt-in (`privacy.familiarFaceEnabled`, default
  off) and fully local.
- **Event engine** (src/vision/events.js): unified schema v3 (provider, track
  ref, familiar person ref, zone, correlation id, clip ref, processing state)
  with DB migration; presence-interval correlation (a person standing in a
  room yields ONE arrival event, not one per frame); per-key dedup windows.
- **Automation rules** (src/automations.js): data-driven rules
  `{conditions, actions, cooldownSec, schedule?}` — conditions: event type,
  class, zone, familiarity, confidence floor, time window; actions: snapshot,
  bounded recording, notification, scene flag. Rules are editable, testable
  (dry-run), cooldown-limited and audited.
- **HUGO provider** (src/adapter/): follows the pattern frozen in Piano Core
  §16 — canonical API, identity/version/capability manifest, pairing with
  explicit owner approval, versioned invoke, SSE events, explicit unavailable
  states. HUGO Core itself has no repository yet; the Eye side is complete and
  pairing is marked pending (no mock pairing claims).

## 2. Resource discipline

- One decode per camera for all AI (previously two), inference at the
  configured resolution/fps; a disabled detector receives no frames.
- Latest-wins everywhere in the AI path: inference never blocks or queues
  unboundedly; PTZ/recording/live/audio are on separate hub consumers and
  cannot be stalled by AI (enforced by the hub's backpressure contract).
- Measured budget (to be re-verified in Gate 9): YOLOv8n 640² ≈ 20 % of one
  core at 2 fps; YuNet 320² ≈ 2-4 % at 5 fps; SFace only runs on enrolled
  matching events (not per frame).

## 3. Model manifest (pinned, checksummed, licensed)

| Model | Task | Size | License | Source |
|---|---|---|---|---|
| yolov8n.onnx | person/object | 12.8 MB | AGPL-3.0 (Ultralytics) | pinned in scripts/ai-setup.mjs |
| face_detection_yunet_2023mar.onnx | face detection | 232 KB | Apache-2.0 (opencv_zoo) | scripts/ai-setup.mjs |
| face_recognition_sface_2021dec.onnx | embeddings | 37 MB | Apache-2.0 (opencv_zoo) | scripts/ai-setup.mjs |

All downloads checksum-verified; no cloud inference at any point.
