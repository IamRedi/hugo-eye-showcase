// Typed HUGO Eye API client (same-origin; cookie session)

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function req<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  })
  if (res.status === 401) throw new ApiError(401, 'unauthorized')
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (data as any).error ?? `HTTP ${res.status}`)
  return data as T
}

export const api = {
  login: (token: string) => req('/api/login', { method: 'POST', body: JSON.stringify({ token }) }),
  logout: () => req('/api/logout', { method: 'POST' }),
  health: () => req('/api/health'),
  cameras: () => req<{ cameras: CameraInfo[] }>('/api/cameras'),
  cameraStatus: (id: string) => req(`/api/cameras/${id}/status`),
  cameraCapabilities: (id: string) => req<CapabilityMatrix>(`/api/cameras/${id}/capabilities`),
  cameraSettings: (id: string) => req<{ settings: CameraSettings }>(`/api/cameras/${id}/settings`),
  patchCameraSettings: (id: string, patch: Partial<CameraSettings>) =>
    req(`/api/cameras/${id}/settings`, { method: 'PATCH', body: JSON.stringify(patch) }),
  snapshot: (id: string, zone?: string) =>
    req('/api/cameras/' + id + '/snapshot', { method: 'POST', body: JSON.stringify({ zone }) }),
  ptz: (id: string, command: string) =>
    req(`/api/cameras/${id}/ptz`, { method: 'POST', body: JSON.stringify({ command }) }),
  presets: (id: string) => req<{ presets: Preset[] }>(`/api/cameras/${id}/presets`),
  createPreset: (id: string, body: { name: string; captureZone?: string }) =>
    req(`/api/cameras/${id}/presets`, { method: 'POST', body: JSON.stringify(body) }),
  deletePreset: (id: string, presetId: string) =>
    req(`/api/cameras/${id}/presets/${presetId}`, { method: 'DELETE' }),
  gotoPreset: (id: string, presetId: string) =>
    req(`/api/cameras/${id}/presets/${presetId}/goto`, { method: 'POST' }),
  settings: () => req<{ settings: ProductSettings }>('/api/settings'),
  patchSettings: (patch: any) => req<{ settings: ProductSettings }>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  storage: () => req<StorageStats>('/api/storage'),
  sessions: () => req<{ sessions: SessionInfo[] }>('/api/access/sessions'),
  revokeAllSessions: () => req('/api/access/sessions/revoke-all', { method: 'POST' }),
  audit: () => req<{ entries: AuditEntry[] }>('/api/audit'),
  events: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString()
    return req<{ events: EventItem[] }>('/api/events' + (qs ? '?' + qs : ''))
  },
  intelligence: () => req<IntelligenceStatus>('/api/intelligence'),
  automations: () => req<{ automations: Automation[] }>('/api/automations'),
  patchAutomation: (body: { id: string; enabled: boolean; seconds?: number }) =>
    req('/api/automations', { method: 'PATCH', body: JSON.stringify(body) }),
  recordings: (camera?: string) =>
    req<{ recordings: Recording[] }>('/api/recordings' + (camera ? `?camera=${camera}` : '')),
  startRecording: (camera: string) => req('/api/recordings/start', { method: 'POST', body: JSON.stringify({ camera }) }),
  stopRecording: (camera: string) => req('/api/recordings/stop', { method: 'POST', body: JSON.stringify({ camera }) }),
  deleteRecordingGroup: (groupId: string) =>
    req(`/api/recordings/${groupId}?confirm=true`, { method: 'DELETE' }),
  adapterManifest: () => req('/api/adapter/manifest'),
  media: (id: string, zone?: string, limit = 20) =>
    req<{ items: { zone: string; capturedAt: string; sizeBytes: number; url: string }[] }>(
      `/api/cameras/${id}/media${zone ? `?zone=${encodeURIComponent(zone)}` : ''}${zone ? '&' : '?'}limit=${limit}`),
  cameraZone: (id: string) => req<{ zone: Zone | null }>(`/api/cameras/${id}/zone`),
  visionScene: () => req<{ scene: SceneState[] }>('/api/vision/scene'),
  visionDetections: () => req<{ detections: Detection[] }>('/api/vision/detections'),
  people: () => req<{ people: PersonProfile[] }>('/api/people'),
  createPerson: (name: string, notes = '') => req<{ person: PersonProfile }>('/api/people', { method: 'POST', body: JSON.stringify({ name, notes }) }),
  updatePerson: (id: string, patch: Partial<PersonProfile>) =>
    req<{ person: PersonProfile }>(`/api/people/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePerson: (id: string) => req(`/api/people/${id}`, { method: 'DELETE' }),
  enrollFace: (id: string, body: { image?: string; camera?: string }) =>
    req<{ ok: boolean; quality?: number; error?: string; ambiguity?: boolean }>(`/api/people/${id}/enroll`, { method: 'POST', body: JSON.stringify(body) }),
  removeReference: (personId: string, refId: string) =>
    req(`/api/people/${personId}/references/${refId}`, { method: 'DELETE' }),
  rules: () => req<{ rules: AutomationRule[]; sceneFlags: Record<string, any> }>('/api/rules'),
  createRule: (rule: Partial<AutomationRule>) => req<{ rule: AutomationRule }>('/api/rules', { method: 'POST', body: JSON.stringify(rule) }),
  updateRule: (id: string, patch: Partial<AutomationRule>) => req<{ rule: AutomationRule }>(`/api/rules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteRule: (id: string) => req(`/api/rules/${id}`, { method: 'DELETE' }),
  testRule: (id: string, event?: any) => req<{ matched: boolean; results: any[] }>(`/api/rules/${id}/test`, { method: 'POST', body: JSON.stringify({ event }) }),
  adapterPairing: () => req<any>('/api/adapter/pairing'),
  approvePairing: () => req<any>('/api/adapter/pairing/approve', { method: 'POST' }),
  revokePairing: () => req<any>('/api/adapter/pairing/revoke', { method: 'POST' }),
  setCameraZone: (id: string, zone: Zone | null) =>
    req<{ zone: Zone | null }>(`/api/cameras/${id}/zone`, { method: 'PUT', body: JSON.stringify({ zone }) }),

  search: (params: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
    return req<SearchResponse>('/api/search' + (qs ? '?' + qs : ''))
  },
  searchStatus: () => req<SearchStatus>('/api/search/status'),
  searchReindex: (limit = 500) => req<{ indexed: number; considered: number }>('/api/search/reindex', { method: 'POST', body: JSON.stringify({ limit }) }),
  aiVision: () => req<AiVisionStatus>('/api/ai/vision'),
  aiAsk: (camera: string, question: string) =>
    req<{ ok: boolean; answer?: string; model?: string; ms?: number; uncertain?: boolean; error?: string }>(
      '/api/ai/ask', { method: 'POST', body: JSON.stringify({ camera, question }) }),
  describeEvent: (id: number) =>
    req<{ ok: boolean; description: string; model: string; uncertain: boolean }>(`/api/events/${id}/describe`, { method: 'POST' }),
  follow: (camera: string, target: { trackId?: number; x?: number; y?: number }) =>
    req<{ ok: boolean; trackId?: number; error?: string }>(`/api/cameras/${camera}/follow`, { method: 'POST', body: JSON.stringify(target) }),
  followStatus: (camera: string) => req<{ follow: FollowStatus }>(`/api/cameras/${camera}/follow`),
  followStop: (camera: string) => req(`/api/cameras/${camera}/follow/stop`, { method: 'POST', body: JSON.stringify({}) }),
  visits: () => req<{ openVisits: VisitSession[] }>('/api/vision/visits'),
  visionOverlay: (camera: string) =>
    req<{ ok: boolean; at: string; tracks: OverlayTrack[] }>(`/api/vision/overlay?camera=${encodeURIComponent(camera)}`),
  registry: () => req<{ cameras: RegistryCamera[] }>('/api/cameras/registry'),
  probeCamera: (body: { host: string; rtspPort?: number; onvifPort?: number; username: string; password: string; mainPath?: string }) =>
    req<{ ok: boolean; probe: ProbeResult }>(
      '/api/cameras/registry/probe', { method: 'POST', body: JSON.stringify(body) }),
  createCamera: (body: { id: string; host: string; username: string; password: string; name?: string; rtspPort?: number; onvifPort?: number; mainPath?: string; subPath?: string }) =>
    req<{ ok: boolean; camera?: RegistryCamera; probe?: ProbeResult | null; error?: string }>(
      '/api/cameras/registry', { method: 'POST', body: JSON.stringify(body) }),
  updateRegistryCamera: (id: string, patch: { name?: string; enabled?: boolean; password?: string }) =>
    req<{ ok: boolean }>(`/api/cameras/registry/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  removeRegistryCamera: (id: string) => req(`/api/cameras/registry/${id}`, { method: 'DELETE' }),

  /**
   * Cookie-authenticated MJPEG URL — works even when the UI origin differs
   * from the API origin (vite dev proxy), where the grant POST would be
   * CSRF-blocked. GET streams accept the session cookie directly.
   * The nonce matters: re-setting an identical img src never re-fires the
   * load, so a retry with the same URL would stay broken forever.
   */
  mjpegCookieUrl(cameraId: string, quality: 'sub' | 'main' = 'sub'): string {
    return `/api/cameras/${cameraId}/stream.mjpeg?q=${quality}&r=${Date.now().toString(36)}`
  },

  async streamGrant(cameraId: string): Promise<string> {
    const data = await req<{ grant: string }>('/api/stream-grant', { method: 'POST', body: JSON.stringify({ camera: cameraId }) })
    return data.grant
  },
  async streamUrl(cameraId: string, quality: 'sub' | 'main' = 'sub'): Promise<string> {
    const grant = await this.streamGrant(cameraId)
    return `/api/cameras/${cameraId}/stream.mjpeg?grant=${grant}&q=${quality}`
  },
}

export type CameraInfo = {
  id: string; kind: string; name: string; model: string; host: string
  rtspPort: number; onvifPort: number; mainPath: string; subPath: string
  orientation: { rotate: number; mirror: boolean; flip: boolean }
  privacyBlocked: boolean
  capabilities: { onvif: boolean; ptz: boolean; onvifProfiles: string[]; videoResolution: any }
  health: Health | null
  recording: { recording: boolean; startedAt: string | null }
  stream: { sub: HubStatus | null; main: HubStatus | null } | null
}

export type HubStatus = {
  quality: 'sub' | 'main'
  state: 'idle' | 'connecting' | 'streaming' | 'recovering'
  since: string
  fps: number | null
  keyframeIntervalS: number | null
  subscribers: { id: number; kind: string; bytes: number; drops: number }[]
  reconnects: number
  lastError: string | null
}

export type Zone = { points: [number, number][] }
export type SceneState = {
  cameraId: string; online: boolean; fresh: boolean; observationAgeMs: number | null
  persons: { trackId: number; known: boolean; familiar: { personId: string; name: string; score: number } | null; score: number; since: string }[]
  personCount: number | null; knownPersons: { name: string; score: number }[]; unknownPersons: number | null
  objects: Record<string, number>; zonesActive: string[]
  lastChange: string | null; lastChangeAt: string | null; fps: number | null
}
export type Detection = {
  cameraId: string; kind: 'object' | 'face'; label: string; name?: string | null
  trackId: number; score: number; box: { x: number; y: number; w: number; h: number }; at: string | null
}
export type PersonProfile = {
  id: string; name: string; notes: string; enabled: boolean
  createdAt: string; updatedAt: string; referenceCount?: number
  references: { id: string; imageUrl: string; quality: number; source: string; createdAt: string }[]
}
export type AutomationRule = {
  id: string; name: string; enabled: boolean
  conditions: { eventType?: string; cameraId?: string; label?: string; zone?: string; familiarity?: string; minConfidence?: number; timeWindow?: { from: string; to: string } }
  actions: { type: string; seconds?: number; zone?: string; message?: string; key?: string; value?: any }[]
  cooldownSec: number; lastFiredAt: string | null; lastError: string | null; fireCount: number
}

export type Health = {
  ok: boolean; rtspOk: boolean; onvifOk: boolean
  position: { pan: number; tilt: number; zoom: number } | null
  detail: string; checkedAt: string
}

export type CameraSettings = {
  cameraId: string; displayName: string | null
  rotate: number; mirror: boolean; flip: boolean; privacyDisabled: boolean
}

export type Preset = {
  id: string; cameraId: string; name: string; slug: string
  pan: number; tilt: number; zoom: number
  timelapseEveryMin: number | null; timelapseAt: string | null; timelapseEnabled: boolean
  captureZone: string; lastCapturedAt: string | null; lastCaptureStatus: string | null
}

export type ProductSettings = {
  privacy: { recordingEnabled: boolean; microphoneEnabled: boolean; aiEnabled: boolean; familiarFaceEnabled: boolean }
  storage: { maxStorageGb: number; retentionDays: number; minFreeGb: number; eventRetentionDays: number }
  motion: { enabled: boolean; threshold: number; minIntervalSec: number; preBufferGops: number }
  ai: { personEnabled: boolean; inferenceFps: number; minConfidence: number; minIntervalSec: number; classes: string[] }
  face: { detectionScore: number; matchThreshold: number; eventIntervalSec: number }
  automations: { motionRecord: { enabled: boolean; seconds: number; cooldownSec: number }; motionNotify: { enabled: boolean } }
  aiVision: { enabled: boolean; describeEvents: boolean; cooldownSec: number }
  autofollow: { enabled: boolean; screenX: number; screenY: number; returnHome: boolean; lostHoldMs: number }
  recording: { mode: 'events' | 'continuous' | 'off'; postEventSec: number; maxSec: number }
}

export type StorageStats = {
  recordingSegments: number; recordingBytes: number; snapshotBytes: number; totalBytes: number
  maxBytes: number; retentionDays: number; minFreeGb: number; freeBytes: number
}

export type SessionInfo = { id: string; label: string; created_at: string; expires_at: string; revoked: boolean; expired: boolean }
export type AuditEntry = { at: string; action: string; detail: string }
export type EventItem = {
  id: number; at: string; type: string; cameraId: string; detail: string
  confidence: number | null; thumbUrl: string | null
  description?: string | null; correlationId?: string | null; personId?: string | null; zone?: string | null
}
export type Recording = {
  id: string; groupId: string; cameraId: string; startedAt: string; endedAt: string | null
  sizeBytes: number; durationS: number | null; trigger: string; status: string
  thumbUrl: string | null; url: string
}
export type Automation = { id: string; label: string; description: string; enabled: boolean; requires: string[]; configurable?: any }
export type CapabilityMatrix = {
  cameraId: string; model: string
  verified: CapRow[]; available: CapRow[]; hardwareOnly: CapRow[]; unavailable?: CapRow[]
  profiles: string[]; videoResolution: any
}
export type CapRow = { id: string; label: string; via: string; gate?: string; reason?: string }
export type IntelligenceStatus = {
  aiEnabled: boolean
  availability: { runtime: boolean; model: boolean; modelPath: string }
  motion: { enabled: boolean; active: boolean; threshold: number; minIntervalSec: number; providers: MotionProviderStatus[] }
  person: {
    enabled: boolean; classes: string[]; inferenceFps: number; minConfidence: number; minIntervalSec: number
    active: boolean
    providers: { cameraId: string; state: string; lastError: string | null; stats: any }[]
  }
  face: {
    familiarFaceEnabled: boolean; detectionScore: number; matchThreshold: number; eventIntervalSec: number
    available: boolean; enrolledCount: number; active: boolean
    providers: { cameraId: string; state: string; faces?: any[] }[]
  }
  vision: { cameraId: string; sourceActive: boolean; frames: number; lastFrameAt: string | null; providers: any[] }[]
  providers: { id: string; label: string; state: string; note?: string; engine?: string }[]
  aiVision: {
    enabled: boolean; describeEvents: boolean; cooldownSec: number
    provider: { id: string; model: string; state: string; lastError: string | null; lastMs: number | null; calls: number }
    queued: number; running: boolean; submitted: number; completed: number; failed: number
  }
}
export type SearchHit = {
  id: number; at: string; type: string; cameraId: string; detail: string
  confidence: number | null; thumbUrl: string | null
  personId: string | null; personName: string | null; zone: string | null
  description: string | null; score: number | null; provenance: string
  recording: { groupId: string; start: string; end: string; covering: boolean } | null
}
export type SearchResponse = { ok: boolean; query: string | null; model: string; scanned: number; results: SearchHit[]; error?: string }
export type SearchStatus = {
  availability: { runtime: boolean; model: boolean; vocab: boolean; merges: boolean }
  embedder: { id: string; ready: boolean }
  model: string; indexed: number; indexable: number; queue: number
  stats: { indexed: number; failed: number; skipped: number; lastError: string | null; lastIndexedAt: string | null }
}
export type AiVisionStatus = {
  enabled: boolean; describeEvents: boolean; cooldownSec: number
  provider: { id: string; model: string; state: string; lastError: string | null; lastMs: number | null; calls: number }
  queued: number; running: boolean; submitted: number; completed: number; failed: number
}
export type FollowStatus = {
  cameraId: string; state: 'idle' | 'following' | 'returning'; targetTrackId: number | null
  since: string | null; home: { pan: number; tilt: number; zoom: number } | null
  config: { deadZone: number; maxSpeed: number; tickMs: number; lostHoldMs: number; returnHome: boolean }
  stats: { sessions: number; corrections: number; losses: number; lastError: string | null; lastLatencyMs: number | null }
}
export type RegistryCamera = {
  id: string; kind: string; name: string; model: string; host: string
  rtspPort: number; onvifPort: number; mainPath: string; subPath: string
  username: string; enabled: boolean; source: string; createdAt: string; updatedAt: string
}
export type ProbeResult = {
  ok: boolean; rtspTcp: boolean; rtspStatus: number | null
  video: string | null; audio: string | null
  onvifModel: string | null; firmware: string | null; errors: string[]
}
export type OverlayTrack = {
  trackId: number
  box: { x: number; y: number; w: number; h: number }
  score: number
  identity: {
    state: 'VERIFIED_FACE' | 'TRACKED_CONTINUITY' | 'POSSIBLE_MATCH' | 'UNKNOWN'
    label: string
    basis: string | null
    personId: string | null
    score: number | null
    verifiedAt: string | null
    reentered: boolean
    trackAgeMs: number | null
  }
  posture: 'standing' | 'sitting' | null
  motion: 'moving' | 'stationary' | null
  facing: string | null
  derivedFrom: string | null
  movementSignature?: {
    windowMs: number; samples: number; meanSpeed: number
    directionChangeRate: number; aspectOscillation: number; note: string
  }
}
export type VisitSession = { cameraId: string; id: string; openedAt: string; events: number; persons: number }
export type MotionProviderStatus = { cameraId: string; running: boolean; frames: number; events: number; lastEventAt: string | null; lastDiff: number }

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n > 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB'
  if (n > 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB'
  if (n > 1024) return (n / 1024).toFixed(0) + ' KB'
  return n + ' B'
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
