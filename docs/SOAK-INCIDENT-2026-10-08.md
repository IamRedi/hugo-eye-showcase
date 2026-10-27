# Soak Incident Report — 2026-10-08/09: camera power loss during the 2.1.0 soak

**Classification: externally interrupted soak (camera power loss) — NOT an
application failure. Automatic recovery: PASS, verified with evidence.**

The prior 24-hour soak of `release-2.1.0` must not be reported as an
uninterrupted PASS. This document records what actually happened, using the
soak JSONL, the service journal and the SQLite database as evidence.

## Timeline (UTC; local = UTC+2)

| Time | Evidence | Event |
|---|---|---|
| 2026-10-08T15:23:41Z | soak JSONL first record | Soak monitor started (nominal end 2026-10-09T15:23Z) |
| 2026-10-08T15:26Z | systemd | Production service started (PID 1215956, release-2.1.0 @ 91fdf45) |
| 2026-10-08T19:26:39Z | `health` table | Last healthy probe: ok=1, rtsp=1, onvif=1 |
| 2026-10-08T19:27:21Z | journal + `events` | `health.changed: healthy → degraded (ONVIF ptz unreachable: timeout)` — **camera power removed** (owner-confirmed physical unplug) |
| 2026-10-08T19:28:46Z | soak JSONL | Monitor-observed cameraHealth flips false |
| 19:27Z → 07:11Z | `health` table | Probes continued every 30 s, failing cleanly (`EHOSTUNREACH`); ~1,419 rows total; **no other journal output at all** |
| 2026-10-09T07:11:40Z | journal + `events` | `health.changed: degraded → healthy (recovered)` — power restored. **Offline duration: 11 h 44 m 19 s** |
| 2026-10-09T07:34Z | live API | Health OK; RTSP OK; ONVIF OK; PTZ position readable (pan −0.468, tilt −0.922) |
| 2026-10-09T09:36Z | live pull | 8 s `stream.fmp4` capture through the service: valid fMP4 init (`ftyp iso5`) + `moof`/`mdat` fragments — **streaming restored end-to-end** |

## Assignment recovery checklist

1. **Detected the camera going offline** — YES. Degraded within ~42 s of power
   loss (30 s health interval), event + journal + API state.
2. **Avoided uncontrolled restart loops** — YES. Zero service restarts (same
   PID across the whole window, monotonic soak uptime), zero ffmpeg children
   spawned during the outage, zero reconnect storms (hubs stayed `idle`, 0
   reconnects — no viewers overnight), no crash-loop journal noise.
3. **Recovered when power returned** — YES. First healthy probe at 07:11:40Z,
   automatic, no operator action.
4. **Restored streaming correctly** — YES (verified post-incident): live fMP4
   pull through the hub produced a valid init segment and media fragments;
   ONVIF PTZ reads positions again.
5. **Preserved media and database integrity** — YES. `PRAGMA quick_check` =
   ok; 260 events intact (exactly 2 incident events logged — no fabricated
   events); all 21 recordings `status=ready`; WAL checkpoint state normal.

Resource behavior across the incident (soak JSONL, 144 good samples):
RSS max 199 MB, stable; ffmpegChildren 0; disk free ≈ 549 GB.

## Soak monitor defect found (fixed in EYE-023)

The monitor logs in once at start. DB sessions expire after 12 h, so from
2026-10-09T03:23:55Z (exactly 12 h after login) `/api/cameras` returned 401
and the monitor's `cam.cameras.map(...)` threw
`Cannot read properties of undefined (reading 'map')` — the remaining 50
samples are `ok:false` parse-error records. This is a **monitor defect**
(single-login, no re-auth), not a service failure; it masked the otherwise
clean incident telemetry from 03:23Z onward. EYE-023 replaces this tooling
(re-login on 401 + outage-aware classification).

## Disposition

- The 2.1.0 soak is recorded as **INTERRUPTED at 19:27:21Z** (~6 h 04 m into
  the 24 h window) by an external camera power loss, with **full automatic
  recovery evidence** above.
- A fresh uninterrupted soak will be run on the stable EYE-023 release after
  stabilization (per program instruction — no development paused for it).
- Production (`release-2.1.0`, main @ 91fdf45) and the historical RediON
  archive (`legacy-media-2026-10-08-11-17/`) remain untouched.
