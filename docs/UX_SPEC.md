# HUGO Eye — UX Specification (V2)

Premium local-first indoor smart camera product. Design language: calm dark
surface (deep navy `#0a0f1c`), soft elevation cards, one accent (indigo→cyan
gradient), generous spacing, 13–15 px type (Inter/system), 8 px spacing grid,
rounded-xl, hairline borders (white/6). Light theme via tokens. Motion: 150–200 ms
ease-out transitions only.

## Information architecture (7 sections + panel)

1. **Live** (default) — dominant 16:9 viewer; right rail: camera selector,
   PTZ pad (press-and-hold, stop-on-release), zoom ±, presets, snapshot, record,
   audio listen; orientation popover (rotate 0/90/180/270, mirror, flip —
   persisted per camera; PTZ directions follow display orientation and are
   labelled as such); quality selector (Sub/Main); fullscreen; digital zoom
   (wheel/pinch + drag, "1.0×" chip reset); status strip: transport, resolution,
   latency, codec; offline banner with auto-reconnect + manual retry.
2. **Activity** — real motion events (live via SSE): filter by camera/type/time;
   thumbnails, confidence, dedup notice; toast on new event. No fabricated
   entries; person/face types appear only when their provider is actually active.
3. **Recordings** — privacy-gated: master enable + per-camera; day-grouped
   segment list, inline player, download, delete, storage usage bar, quota and
   retention summary, disk guard state.
4. **Cameras** — device cards: name/model/host, online state, capability matrix
   with honest badges (Verified / Available-gated / Unavailable-via-ONVIF),
   orientation editor, connection test, preset management.
5. **Intelligence** — provider cards with real status: Motion (active; threshold,
   interval, CPU, events today) / Person, Face, Object (Planned — requires
   inference-engine milestone; explicitly "not active in this build"); master AI
   gate; privacy & consent copy for future familiar-face recognition.
6. **Automations** — bounded real rules: "Motion → record N s" (toggle, gated by
   recording), "Motion → notify" (SSE toast). Custom rules: "Coming later".
7. **Settings** — Privacy (gates with consequences text, per-camera privacy),
   Storage (quota slider, retention, usage, media path), Access (sessions,
   revoke, token info), System (versions, uptime, disk, camera health),
   Integrations (HUGO Core: prepared, not connected; Home Assistant: interface
   prepared; media gateway status), Audit log (last 100, no media content).

**Compact Panel Mode** (`/panel`): fullscreen live, large clock, status dot,
snapshot, preset quick-buttons, PTZ mini-pad; no navigation chrome; auto-hide
cursor; designed for wall tablets; same auth.

## Interaction rules

- Every visible control maps to a real API action; unsupported capabilities
  render as explicit "Unavailable via camera protocol" chips — never as buttons
  that do nothing.
- Destructive actions (delete recording, revoke session, disable privacy gate)
  confirm inline.
- Empty states are instructive ("Enable recording in Privacy to start").
- Keyboard: all primary actions reachable, focus-visible rings; PTZ pad supports
  arrow-key hold + release = stop. Touch targets ≥ 44 px. Contrast ≥ 4.5:1 for
  text.
- Responsive: ≥1280 two-column; 768–1279 single column with rail below;
  <768 bottom nav, stacked controls. Panel mode at any size.

## Camera orientation behavior (upside-down mount fix)

- Per-camera `rotate ∈ {0,90,180,270}` (default 180 — mounted inverted),
  `mirror` (h-flip), `flip` (v-flip). Applied identically to live, snapshots,
  recordings, and event thumbnails.
- PTZ pad and arrow keys act in **screen space**; the product remaps to physical
  camera motion using the orientation (e.g., at 180°, screen-left = physical
  right) — the control tooltip states this.
- Snapshot/recording files are stored **rotated** so exports match the live view.
