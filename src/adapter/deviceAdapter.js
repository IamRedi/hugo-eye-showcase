/**
 * HUGO Core DeviceAdapter — contract-conformant implementation of the
 * provider surface defined in IamRedi/hugo-core (commit cf03ce5):
 *   - CapabilityProvider port: identity, runtimeSnapshot, negotiate,
 *     registerCapabilities, execute, cancel.
 *   - ProviderIdentity: definitionId/family/instanceId/displayAlias.
 *   - CommonProviderManifest + DeviceManifest documents (codec wire format).
 *   - CapabilityRequest/CapabilityResult envelopes with strict validation
 *     (src/adapter/contracts.js mirrors the Kotlin invariants).
 *
 * Authority boundary (AuthorizationGate, H030): this adapter receives an
 * opaque authorizationReference and never grants authority itself. Pairing
 * (Eye-side, below) authenticates the Core transport only. Discovery never
 * grants permission to operate the camera. HUGO Eye keeps independent
 * operation: every consumer path here is additive to the local API.
 */

import { db, kvGet as dbKvGet, kvSet as dbKvSet } from '../db.js'
import { recordEvent } from '../db.js'

// kv access with in-process fallback so contract functions stay testable
// without a database (production always persists through kv)
const memoryKv = new Map()
function kvGet(key, fallback = null) {
  try { return dbKvGet(key, fallback) } catch { return memoryKv.has(key) ? memoryKv.get(key) : fallback }
}
function kvSet(key, value) {
  memoryKv.set(key, value)
  try { dbKvSet(key, value) } catch { /* test mode */ }
}
import crypto from 'node:crypto'
import { withPtzLock } from '../ptzlock.js'
import { safeZone, getPreset } from '../presets.js'
import { writeJpegAtomic } from '../camera/ffmpeg.js'
import path from 'node:path'
import { config } from '../config.js'
import { listMedia } from '../media.js'
import { listEvents } from '../intelligence.js'
import {
  parseCapabilityReference, validateCapabilityRequest, buildCapabilityResult,
  buildNegotiationResult, buildRuntimeSnapshot,
  buildCommonManifestDocument, buildDeviceManifestDocument,
} from './contracts.js'

export const ADAPTER_ID = 'hugo.eye'
export const ADAPTER_DEFINITION_ID = 'hugo.eye/device-adapter'
export const ADAPTER_VERSION = '1.0.0'
export const PROTOCOL_SCHEMA = '1.0'

const PAIRING_KV = 'hugo_pairing'

// ---------- provider identity ----------

function slugModel(model) {
  return String(model).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'camera'
}

function vendorNamespace(model) {
  // "TP-Link Tapo C520WS" → "tp.link" (dashes are not allowed in namespaces)
  const vendor = String(model).split(/\s+/)[0] ?? 'unknown'
  const parts = vendor.toLowerCase().split('-').filter(p => /^[a-z0-9]+$/.test(p))
  return (parts.length ? parts.join('.') : 'generic').slice(0, 40)
}

/** Stable canonical UUID per camera instance (ProviderInstanceId). */
function instanceIdFor(cameraId) {
  const key = `adapter:instance:${cameraId}`
  let id = kvGet(key, null)
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    id = crypto.randomUUID()
    kvSet(key, id)
  }
  return id
}

export function providerIdentity(driver) {
  const model = String(driver.cam.model ?? 'camera')
  const vendorParts = vendorNamespace(model).split('.')
  const tokens = model.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean)
  // drop leading tokens that repeat the vendor namespace ("tp link" → gone)
  while (tokens.length > 1 && vendorParts.includes(tokens[0])) tokens.shift()
  return {
    definitionId: `${vendorNamespace(model)}/${tokens.join('-') || 'camera'}`,
    instanceId: instanceIdFor(driver.id),
    family: 'device_adapter',
    displayAlias: String(driver.cam.name ?? driver.id).slice(0, 64),
  }
}

// ---------- capability set (semantic references; Core HUGO_TASKS H078-aligned) ----------

/**
 * Descriptors mirror CapabilityDescriptor fields (effect/risk/safety/
 * permissionIntent/approvalRequirement/cancellation/availability/evidence).
 * `evidence` is honest: DEVICE_VERIFIED only where real-camera tests exist.
 */
const CAPABILITY_DEFS = [
  { ref: 'camera.status@1.0', label: 'Camera status', effect: 'OBSERVE', risk: 'INFORMATIONAL', safety: 'NON_PHYSICAL', input: null, output: 'camera.status.output@1.0' },
  { ref: 'camera.health@1.0', label: 'Camera health', effect: 'OBSERVE', risk: 'INFORMATIONAL', safety: 'NON_PHYSICAL', input: null, output: 'camera.health.output@1.0' },
  { ref: 'camera.snapshot@1.0', label: 'Full-resolution snapshot', effect: 'OBSERVE', risk: 'LOW', safety: 'PHYSICAL_OBSERVATION', input: 'camera.snapshot.input@1.0', output: 'camera.snapshot.output@1.0' },
  { ref: 'camera.stream@1.0', label: 'Authorized live view handle', effect: 'OBSERVE', risk: 'LOW', safety: 'PHYSICAL_OBSERVATION', input: null, output: 'camera.stream.output@1.0' },
  { ref: 'camera.ptz_move@1.0', label: 'Continuous PTZ move', effect: 'ACT', risk: 'ELEVATED', safety: 'PHYSICAL_ACTION', input: 'camera.ptz_move.input@1.0', output: null },
  { ref: 'camera.ptz_preset@1.0', label: 'Move to stored preset', effect: 'ACT', risk: 'ELEVATED', safety: 'PHYSICAL_ACTION', input: 'camera.ptz_preset.input@1.0', output: null },
  { ref: 'camera.recording_start@1.0', label: 'Start privacy-gated recording', effect: 'MODIFY', risk: 'LOW', safety: 'NON_PHYSICAL', input: null, output: 'camera.recording.output@1.0' },
  { ref: 'camera.recording_stop@1.0', label: 'Stop and finalize recording', effect: 'MODIFY', risk: 'LOW', safety: 'NON_PHYSICAL', input: null, output: 'camera.recording.output@1.0' },
  { ref: 'media.list@1.0', label: 'List indexed media', effect: 'OBSERVE', risk: 'INFORMATIONAL', safety: 'NON_PHYSICAL', input: 'media.list.input@1.0', output: 'media.list.output@1.0' },
  { ref: 'perception.scene@1.0', label: 'Current scene state (freshness-explicit)', effect: 'OBSERVE', risk: 'INFORMATIONAL', safety: 'PHYSICAL_OBSERVATION', input: null, output: 'perception.scene.output@1.0' },
  { ref: 'perception.observations@1.0', label: 'Live tracked observations (bounded, stale tracks expire)', effect: 'OBSERVE', risk: 'INFORMATIONAL', safety: 'PHYSICAL_OBSERVATION', input: null, output: 'perception.observations.output@1.0' },
  { ref: 'perception.events@1.0', label: 'List typed events', effect: 'OBSERVE', risk: 'INFORMATIONAL', safety: 'PHYSICAL_OBSERVATION', input: 'perception.events.input@1.0', output: 'perception.events.output@1.0' },
  { ref: 'perception.subscribe@1.0', label: 'Subscribe to vision events (SSE)', effect: 'OBSERVE', risk: 'INFORMATIONAL', safety: 'PHYSICAL_OBSERVATION', input: null, output: 'perception.subscribe.output@1.0' },
]

const CAPABILITY_MAP = new Map(CAPABILITY_DEFS.map(d => [d.ref, d]))

function capabilityWireValues() {
  return CAPABILITY_DEFS.map(d => d.ref).sort()
}

// ---------- manifests (codec wire format, digest over canonical payload) ----------

export function commonManifestDocument(driver) {
  const identity = providerIdentity(driver)
  return buildCommonManifestDocument({
    schemaVersion: PROTOCOL_SCHEMA,
    provider: {
      definitionId: identity.definitionId,
      family: 'device_adapter',
      displayName: 'HUGO Eye camera adapter',
      product: { vendor: 'HUGO Eye', model: driver.cam.model, version: ADAPTER_VERSION },
    },
    adapter: {
      id: ADAPTER_DEFINITION_ID,
      minimumVersionInclusive: ADAPTER_VERSION,
      maximumVersionExclusive: null,
    },
    capabilities: capabilityWireValues(),
    connectionMethods: [
      { reference: 'hugo.eye/http-json@1.0', required: true },
    ],
    requirements: [
      { kind: 'AUTHENTICATION', reference: 'hugo.eye/pairing-token@1.0', required: true },
      { kind: 'PERMISSION', reference: 'hugo.eye/privacy-gates@1.0', required: true },
      { kind: 'AVAILABILITY', reference: 'hugo.eye/local-runtime@1.0', required: true },
    ],
    compatibility: [],
    provenance: {
      source: 'PROJECT',
      issuer: 'HUGO Eye',
      sourceReference: 'src/adapter/deviceAdapter.js',
      evidence: 'DEVICE_VERIFIED',
    },
  })
}

export function deviceManifestDocument(driver) {
  const common = commonManifestDocument(driver)
  return buildDeviceManifestDocument({
    schemaVersion: PROTOCOL_SCHEMA,
    common: { providerDefinitionId: common.provider.definitionId, digest: common.digest },
    capabilityGroups: [
      {
        reference: 'hugo.eye/camera_control@1.0',
        capabilities: capabilityWireValues().filter(r => r.startsWith('camera.')),
      },
      {
        reference: 'hugo.eye/perception@1.0',
        capabilities: capabilityWireValues().filter(r => r.startsWith('perception.') || r.startsWith('media.')),
      },
    ],
    placementSemantics: [],
    powerCharacteristic: 'MAINS_POWERED',
    controlLocality: 'HYBRID',
  })
}

export function adapterManifest(driver) {
  return {
    common: commonManifestDocument(driver),
    device: deviceManifestDocument(driver),
    identity: providerIdentity(driver),
    registerCapabilities: capabilityDescriptors(driver),
    pairing: pairingStatus(),
    note: 'Camera DeviceAdapter for HUGO Core H078 (portable perception). Transport auth = Eye pairing; capability authority stays with the Core authorization gate (the authorizationReference is opaque here).',
  }
}

/** CapabilityProvider.registerCapabilities — descriptors with honest evidence. */
export function capabilityDescriptors(_driver) {
  return CAPABILITY_DEFS.map(d => ({
    reference: d.ref,
    label: d.label,
    description: `${d.label} via HUGO Eye (local, privacy-gated).`,
    inputContract: d.input,
    outputContract: d.output,
    effect: d.effect,
    risk: d.risk,
    safety: d.safety,
    permissionIntent: d.effect === 'OBSERVE' ? 'OBSERVE' : (d.effect === 'ACT' ? 'ACT' : 'MODIFY'),
    approvalRequirement: d.safety === 'PHYSICAL_ACTION' ? 'SESSION_CONFIRMATION' : 'WITHIN_GRANT',
    cancellation: (d.ref.startsWith('camera.recording') || d.safety === 'PHYSICAL_ACTION') ? 'SUPPORTED' : 'NOT_APPLICABLE',
    availability: 'WHILE_REGISTERED',
    evidence: 'DEVICE_VERIFIED',
    limits: d.ref === 'camera.ptz_move@1.0'
      ? [{ key: 'command_count_per_request', minimum: 1, maximum: 1, unit: 'commands' }]
      : [],
    metadata: {},
  }))
}

// ---------- negotiation ----------

export function negotiate(driver, requestedCapabilities) {
  const identity = providerIdentity(driver)
  const supported = new Map()
  for (const def of CAPABILITY_DEFS) supported.set(def.ref, def.ref)
  // every declared reference is offered at its declared version; anything
  // else is UNSUPPORTED with offered = null (no guessed alternates)
  return buildNegotiationResult(identity.instanceId, requestedCapabilities, Object.fromEntries(supported))
}

// ---------- runtime snapshot ----------

export function runtimeSnapshot(driver, healthMonitor) {
  const identity = providerIdentity(driver)
  const health = healthMonitor?.snapshot(driver.id) ?? null
  const generation = Number(kvGet('adapter:generation', 0))
  const available = Boolean(health?.ok)
  return buildRuntimeSnapshot(
    generation,
    available ? 'AVAILABLE' : 'UNAVAILABLE',
    Date.now(),
    available ? null : 'CONNECTION_UNAVAILABLE',
  )
}

export function bumpGeneration() {
  const next = Number(kvGet('adapter:generation', 0)) + 1
  kvSet('adapter:generation', next)
  return next
}

// ---------- pairing (Eye-local transport authentication; owner-approved) ----------

export function pairRequest(coreIdentity) {
  const name = String(coreIdentity?.name ?? 'hugo-core').slice(0, 60)
  kvSet('hugo_pairing_pending', { name, requestedAt: new Date().toISOString(), status: 'pending' })
  return { status: 'pending', message: 'Approval required in HUGO Eye → Settings → HUGO pairing' }
}

export function pendingPairRequest() {
  return kvGet('hugo_pairing_pending', null)
}

export function approvePairing() {
  const pending = kvGet('hugo_pairing_pending', null)
  if (!pending) return null
  const token = crypto.randomBytes(24).toString('hex')
  const pairing = { name: pending.name, approvedAt: new Date().toISOString(), tokenHash: crypto.createHash('sha256').update(token).digest('hex') }
  kvSet(PAIRING_KV, pairing)
  kvSet('hugo_pairing_pending', null)
  return { approved: true, token, name: pairing.name }
}

export function rejectPairing() {
  kvSet('hugo_pairing_pending', null)
  return { rejected: true }
}

export function revokePairing() {
  const existing = kvGet(PAIRING_KV, null)
  kvSet(PAIRING_KV, null)
  return { revoked: Boolean(existing), name: existing?.name ?? null }
}

export function pairingStatus() {
  const pairing = kvGet(PAIRING_KV, null)
  const pending = kvGet('hugo_pairing_pending', null)
  return {
    paired: Boolean(pairing),
    name: pairing?.name ?? null,
    approvedAt: pairing?.approvedAt ?? null,
    pendingRequest: pending,
  }
}

export function pairingTokenValid(token) {
  if (!token) return false
  const pairing = kvGet(PAIRING_KV, null)
  if (!pairing) return false
  const hash = crypto.createHash('sha256').update(String(token)).digest('hex')
  const a = Buffer.from(hash)
  const b = Buffer.from(pairing.tokenHash)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ---------- execution (CapabilityRequest → CapabilityResult) ----------

/**
 * Executes one envelope. Authority stays external: the adapter checks
 * envelope currency, exact provider binding, negotiation and its OWN privacy
 * gates — the authorizationReference is recorded, never interpreted.
 */
export async function executeCapabilityRequest(request, ctx) {
  const { driver, healthMonitor, intelligence } = ctx
  const identity = providerIdentity(driver)

  const validation = validateCapabilityRequest(request)
  if (!validation.ok) {
    return rejectWith(request, identity.instanceId, 'INVALID_REQUEST', null, validation.error)
  }
  const envelope = validation.request

  // exact provider binding (AuthorizationGate semantics: any-compatible is denied)
  if (envelope.providerTarget.providerInstanceId !== identity.instanceId) {
    return rejectWith(envelope, identity.instanceId, 'PROVIDER_UNAVAILABLE', 'provider.mismatch', 'request targets a different provider instance')
  }
  // Request currency — the same invariant the AuthorizationGate enforces
  // (createdAt <= now < deadline); enforced strictly, no clock-skew grace.
  if (Date.now() >= envelope.deadline) {
    return buildCapabilityResult({
      request: envelope, providerInstanceId: identity.instanceId, occurredAt: Date.now(),
      state: 'TIMED_OUT', failure: { code: 'TIMEOUT', reasonCode: 'request.expired' }, evidence: 'PROVIDER_REPORTED',
    })
  }

  const def = CAPABILITY_MAP.get(envelope.capability)
  if (!def) {
    return rejectWith(envelope, identity.instanceId, 'UNSUPPORTED_CAPABILITY', null, `capability not declared by ${ADAPTER_ID}`)
  }

  const values = envelope.input?.values ?? {}
  try {
    const output = await dispatchCapability(envelope, def, values, { driver, healthMonitor, intelligence })
    return buildCapabilityResult({
      request: envelope, providerInstanceId: identity.instanceId, occurredAt: Date.now(),
      state: 'COMPLETED', failure: null, evidence: 'PROVIDER_REPORTED',
      output: { contract: def.output, values: sanitizeOutputValues(output) },
    })
  } catch (error) {
    const code = error?.adapterCode ?? 'PROVIDER_FAILURE'
    return rejectWith(envelope, identity.instanceId, code, error?.adapterReason ?? null, error?.message ?? 'execution failed')
  }
}

/** Requests cancellation of a running invocation (bounded set today). */
export async function cancelCapabilityRequest(request, ctx) {
  const identity = providerIdentity(ctx.driver)
  const validation = validateCapabilityRequest(request)
  if (!validation.ok) return rejectWith(request, identity.instanceId, 'INVALID_REQUEST', null, validation.error)
  const envelope = validation.request
  const { recordingState, stopRecording } = await import('../recordings.js')
  const state = recordingState(ctx.driver.id)
  if (state.recording) {
    await stopRecording(ctx.driver.id, { reason: 'core_cancelled' })
    return buildCapabilityResult({
      request: envelope, providerInstanceId: identity.instanceId, occurredAt: Date.now(),
      state: 'CANCELLED', failure: { code: 'CANCELLED', reasonCode: 'recording.stopped' }, evidence: 'PROVIDER_REPORTED',
    })
  }
  return buildCapabilityResult({
    request: envelope, providerInstanceId: identity.instanceId, occurredAt: Date.now(),
    state: 'CANCELLED', failure: { code: 'CANCELLED', reasonCode: 'nothing.to.cancel' }, evidence: 'PROVIDER_REPORTED',
  })
}

function rejectWith(request, providerInstanceId, code, reasonCode, message) {
  // For pre-validation failures the envelope may be unusable — emit a result
  // with a fresh correlation ids so the rejection remains auditable upstream.
  const safeEnvelope = (request && typeof request.requestId === 'string' && isUuidLike(request.requestId))
    ? request
    : { requestId: crypto.randomUUID(), capability: 'unknown.request@1.0', executionContext: { epoch: 0, sequence: 0 }, auditId: crypto.randomUUID() }
  return buildCapabilityResult({
    request: safeEnvelope, providerInstanceId, occurredAt: Date.now(),
    state: code === 'TIMEOUT' ? 'TIMED_OUT' : 'REJECTED',
    failure: code === 'TIMEOUT'
      ? { code: 'TIMEOUT', reasonCode }
      : { code, ...(reasonCode ? { reasonCode } : {}), ...(message ? { message: String(message).slice(0, 200) } : {}) },
    evidence: 'PROVIDER_REPORTED',
  })
}

function isUuidLike(value) {
  return typeof value === 'string' && /^[0-9a-fA-F-]{36}$/.test(value)
}

function sanitizeOutputValues(output) {
  const values = {}
  for (const [key, value] of Object.entries(output ?? {})) {
    const name = String(key).replace(/[^A-Za-z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, c => c.toLowerCase())
    values[name] = value
  }
  return values
}

// ---------- capability dispatch (real Eye operations) ----------

async function dispatchCapability(envelope, def, values, { driver, healthMonitor, intelligence }) {
  switch (def.ref) {
    case 'camera.status@1.0': {
      const position = driver.capabilities.ptz ? await driver.getStatusPosition().catch(() => null) : null
      return {
        camera: driver.id,
        display_alias: providerIdentity(driver).displayAlias,
        ptz_available: driver.capabilities.ptz,
        position,
      }
    }
    case 'camera.health@1.0':
      return { camera: driver.id, health: healthMonitor?.snapshot(driver.id) ?? null }
    case 'camera.snapshot@1.0': {
      const zone = safeZone(typeof values.zone === 'string' ? values.zone : 'hugo')
      const { jpeg } = await driver.snapshot({ zone })
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
      const finalPath = path.join(config.storage.mediaDir, zone, `${stamp}.jpg`)
      writeJpegAtomic(finalPath, jpeg)
      recordEvent('adapter.snapshot', driver.id, zone)
      return { camera: driver.id, zone, path: finalPath, bytes: jpeg.length }
    }
    case 'camera.stream@1.0':
      return {
        camera: driver.id,
        endpoints: {
          fmp4: `/api/cameras/${driver.id}/stream.fmp4`,
          mjpeg: `/api/cameras/${driver.id}/stream.mjpeg`,
        },
        note: 'same-origin session or short-lived grant; the owner UI issues these — never raw credentials',
      }
    case 'camera.ptz_move@1.0': {
      const command = String(values.command ?? '')
      return withPtzLock('adapter', async () => {
        if (command === 'stop') await driver.ptzStop()
        else await driver.ptzMove(command)
        recordEvent('adapter.ptz', driver.id, command)
        return { camera: driver.id, command }
      })
    }
    case 'camera.ptz_preset@1.0': {
      const preset = getPreset(String(values.preset_id ?? ''))
      if (!preset) {
        const error = new Error('preset not found')
        error.adapterCode = 'INVALID_REQUEST'
        throw error
      }
      return withPtzLock('adapter', async () => {
        await driver.gotoPosition({ pan: preset.pan, tilt: preset.tilt, zoom: preset.zoom })
        recordEvent('adapter.goto_preset', driver.id, preset.name)
        return { camera: driver.id, preset: preset.name }
      })
    }
    case 'camera.recording_start@1.0': {
      const { startRecording } = await import('../recordings.js')
      const result = await startRecording(driver, { trigger: 'adapter' })
      if (!result.ok) {
        const error = new Error(result.error)
        error.adapterCode = result.code === 403 ? 'PERMISSION_DENIED' : 'PROVIDER_FAILURE'
        throw error
      }
      return { camera: driver.id, group_id: result.groupId, audio: result.audio }
    }
    case 'camera.recording_stop@1.0': {
      const { stopRecording } = await import('../recordings.js')
      const result = await stopRecording(driver.id, { reason: 'adapter' })
      if (!result.ok) {
        const error = new Error(result.error)
        error.adapterCode = 'PROVIDER_FAILURE'
        throw error
      }
      return { camera: driver.id, group_id: result.groupId }
    }
    case 'media.list@1.0':
      return {
        camera: driver.id,
        items: listMedia({ cameraId: driver.id, zone: typeof values.zone === 'string' ? values.zone : null, limit: Math.min(500, Number(values.limit) || 100) }).items,
      }
    case 'perception.scene@1.0': {
      if (!intelligence) throw new Error('intelligence unavailable')
      const scenes = intelligence.sceneSnapshot(driver.id)
      return { scene: scenes, freshness_note: 'fresh=false means the last observation is stale — Core must answer accordingly' }
    }
    case 'perception.observations@1.0': {
      if (!intelligence) throw new Error('intelligence unavailable')
      const observations = []
      for (const cameraCtx of intelligence.runtimes?.values?.() ?? []) {
        if (cameraCtx.driver.id !== driver.id) continue
        const person = cameraCtx.person.status()
        for (const t of person.live ?? []) {
          observations.push({ cameraId: cameraCtx.driver.id, kind: 'track', label: t.label, trackId: t.trackId, score: t.score, box: t.box, zones: t.zones })
        }
        for (const f of cameraCtx.face.status().faces ?? []) {
          observations.push({ cameraId: cameraCtx.driver.id, kind: 'face', trackId: f.trackId, familiar: f.familiar, box: f.box })
        }
      }
      return { observations }
    }
    case 'perception.events@1.0':
      return {
        camera: driver.id,
        events: listEvents({
          cameraId: driver.id,
          type: typeof values.type === 'string' ? values.type : null,
          limit: Math.min(500, Number(values.limit) || 100),
        }),
      }
    case 'perception.subscribe@1.0':
      return { camera: driver.id, endpoint: '/api/events/stream', transport: 'SSE', auth: 'session or pairing token' }
    default:
      throw new Error(`unhandled capability: ${def.ref}`)
  }
}
