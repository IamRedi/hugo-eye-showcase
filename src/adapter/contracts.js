/**
 * HUGO Core capability-contract shapes, mirrored from IamRedi/hugo-core
 * (commit cf03ce5, Kotlin `io.redi.robot.capability.api` /
 * `manifest.domain` / `capability.provider` / `trust.runtime`).
 *
 * These validators mirror the Kotlin invariants exactly so HUGO Eye payloads
 * can be consumed by the Core codecs fail-closed. Pure functions only.
 *
 * Key wire facts (each verified against the Kotlin source):
 *  - CapabilityReference  = "namespace.name@major.minor", major ≥ 1;
 *    compatibility is directional (same id + major, offered.minor ≥ required.minor).
 *  - CapabilityContractId (data contracts) = dotted snake_case, ≥ 2 segments, no dashes.
 *  - ProviderDefinitionId / AdapterDefinitionReference = "namespace/name"
 *    (namespace dot-separated lowercase, name may contain - and _).
 *  - ProviderInstanceId = canonical lowercase UUID.
 *  - Envelopes: requestId/auditId/authorizationReference are UUIDs;
 *    executionContext {epoch ≥ 0, sequence ≥ 0}; deadline > createdAt;
 *    input values ≤ 64 with snake_case names and Text/Integer/Decimal/Flag.
 *  - Result states and failure codes conflict exactly as in
 *    CapabilityResult.create (REJECTED/FAILED/CANCELLED/TIMED_OUT/UNKNOWN sets,
 *    COMPLETED ⇔ output ≠ null, evidence/state conflicts).
 *  - Negotiation: one entry per requested reference; SUPPORTED ⇒ offered === null
 *    or offered is backward-compatible; UNSUPPORTED/INCOMPATIBLE ⇒ offered ≠ null.
 *  - Runtime snapshot: AVAILABLE ⇔ reason === null.
 */

import crypto from 'node:crypto'

// ---------- patterns (verbatim from the Kotlin regexes) ----------

export const PATTERNS = {
  capabilitySegment: new RegExp('^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'),
  capabilityNamespace: new RegExp('^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'),
  capabilityVersion: new RegExp('^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$'),
  definitionId: new RegExp('^[a-z][a-z0-9]*(?:[.][a-z][a-z0-9]*)*/[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$'),
  manifestContractId: new RegExp('^[a-z][a-z0-9]*(?:[.][a-z][a-z0-9_]*)*/[a-z][a-z0-9_]*(?:[-_][a-z0-9]+)*$'),
  reasonCode: new RegExp('^[a-z][a-z0-9]*(?:[.][a-z][a-z0-9_]*)*$'),
  digest: new RegExp('^sha256:[0-9a-f]{64}$'),
  uuidCanonical: new RegExp('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  argumentName: new RegExp('^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'),
}

// ---------- enums (wire values) ----------

export const ACTOR_KINDS = ['LOCAL_USER', 'HUGO_RUNTIME', 'LOCAL_SYSTEM']
export const RESULT_STATES = ['ACCEPTED', 'STARTED', 'COMPLETED', 'REJECTED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'UNKNOWN']
export const FAILURE_CODES = [
  'INVALID_REQUEST', 'UNSUPPORTED_CAPABILITY', 'INCOMPATIBLE_VERSION', 'PROVIDER_UNAVAILABLE',
  'PERMISSION_DENIED', 'APPROVAL_REQUIRED', 'SAFETY_REJECTED', 'TIMEOUT', 'CANCELLED',
  'TRANSPORT_FAILURE', 'PROVIDER_FAILURE', 'MALFORMED_RESULT', 'UNKNOWN',
]
export const REJECTED_CODES = new Set(['INVALID_REQUEST', 'UNSUPPORTED_CAPABILITY', 'INCOMPATIBLE_VERSION', 'PROVIDER_UNAVAILABLE', 'PERMISSION_DENIED', 'APPROVAL_REQUIRED', 'SAFETY_REJECTED'])
export const FAILED_CODES = new Set(['TRANSPORT_FAILURE', 'PROVIDER_FAILURE', 'MALFORMED_RESULT'])
export const OUTCOME_EVIDENCE = ['REQUEST_ACCEPTED', 'PROVIDER_REPORTED', 'LOCALLY_OBSERVED', 'OUTCOME_UNKNOWN']
export const AVAILABILITY = ['AVAILABLE', 'DEGRADED', 'UNAVAILABLE']
export const AVAILABILITY_REASONS = ['NOT_READY', 'TEMPORARILY_UNAVAILABLE', 'PERMISSION_UNAVAILABLE', 'CONNECTION_UNAVAILABLE', 'PROVIDER_FAILURE', 'UNKNOWN']
export const NEGOTIATION_STATES = ['SUPPORTED', 'UNSUPPORTED', 'INCOMPATIBLE']
export const DEVICE_CATEGORIES = ['LIGHT', 'DISPLAY', 'CAMERA', 'SENSOR', 'APPLIANCE', 'OTHER']
export const POWER_CHARACTERISTICS = ['MAINS_POWERED', 'BATTERY_POWERED', 'SELF_POWERED', 'UNKNOWN']
export const CONTROL_LOCALITIES = ['NONE', 'LOCAL', 'REMOTE', 'HYBRID']
export const MANIFEST_REQUIREMENT_KINDS = ['AUTHENTICATION', 'PERMISSION', 'SAFETY', 'RISK', 'LIFECYCLE', 'AVAILABILITY']
export const MANIFEST_SOURCES = ['PROJECT', 'ADAPTER_PACKAGE', 'VENDOR', 'ADMINISTRATOR', 'LOCAL_CONFIGURATION']

// ---------- primitive validators ----------

export function isUuid(value) {
  return typeof value === 'string' && PATTERNS.uuidCanonical.test(value)
}

function countChar(text, ch) {
  let n = 0
  for (const c of text) if (c === ch) n += 1
  return n
}

export function parseCapabilityReference(raw) {
  if (typeof raw !== 'string' || countChar(raw, '@') !== 1) return { ok: false, error: 'malformed' }
  const [idText, versionText] = raw.split('@')
  const idMatch = idText.match(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$/)
  if (!idMatch) return { ok: false, error: 'malformed id' }
  const lastDot = idText.lastIndexOf('.')
  const namespace = idText.slice(0, lastDot)
  const name = idText.slice(lastDot + 1)
  if (!PATTERNS.capabilityVersion.test(versionText)) return { ok: false, error: 'malformed version' }
  const [major, minor] = versionText.split('.').map(Number)
  if (major <= 0 || minor < 0) return { ok: false, error: 'invalid version' }
  return { ok: true, reference: { namespace, name, major, minor, wireValue: raw } }
}

/** Directional compatibility from CapabilityReference.compatibilityWith. */
export function compatibilityWith(offered, required) {
  if (!offered || !required) return { compatible: false, reason: 'DifferentCapability' }
  const offId = `${offered.namespace}.${offered.name}`
  const reqId = `${required.namespace}.${required.name}`
  if (offId !== reqId) return { compatible: false, reason: 'DifferentCapability' }
  if (offered.major !== required.major) return { compatible: false, reason: 'MajorVersionMismatch' }
  if (offered.minor < required.minor) return { compatible: false, reason: 'OfferedMinorTooOld' }
  if (offered.minor === required.minor) return { compatible: true, exact: true }
  return { compatible: true, backwardCompatibleMinor: true }
}

// ---------- envelope validation (mirrors CapabilityRequest.create) ----------

export function validateCapabilityRequest(request) {
  if (typeof request !== 'object' || request === null) return { ok: false, error: 'request must be an object' }
  const required = ['requestId', 'capability', 'providerTarget', 'actor', 'executionContext', 'createdAt', 'deadline', 'auditId']
  for (const field of required) {
    if (!(field in request)) return { ok: false, error: `missing field: ${field}` }
  }
  if (!isUuid(request.requestId)) return { ok: false, error: 'requestId must be a canonical UUID' }
  if (!isUuid(request.auditId)) return { ok: false, error: 'auditId must be a canonical UUID' }
  if (request.authorizationReference !== undefined && request.authorizationReference !== null && !isUuid(request.authorizationReference)) {
    return { ok: false, error: 'authorizationReference must be a canonical UUID' }
  }
  const cap = parseCapabilityReference(request.capability)
  if (!cap.ok) return { ok: false, error: `capability: ${cap.error}` }
  if (!ACTOR_KINDS.includes(request.actor)) return { ok: false, error: 'actor must be LOCAL_USER | HUGO_RUNTIME | LOCAL_SYSTEM' }
  const ctx = request.executionContext
  if (typeof ctx !== 'object' || ctx === null || !Number.isInteger(ctx.epoch) || ctx.epoch < 0 || !Number.isInteger(ctx.sequence) || ctx.sequence < 0) {
    return { ok: false, error: 'executionContext must be {epoch ≥ 0, sequence ≥ 0}' }
  }
  for (const t of [request.createdAt, request.deadline]) {
    if (!Number.isInteger(t) || t < 0) return { ok: false, error: 'timestamps must be non-negative integers (MonotonicTimestampMs)' }
  }
  if (request.deadline <= request.createdAt) return { ok: false, error: 'deadline must be after createdAt' }
  const target = request.providerTarget
  if (typeof target !== 'object' || target === null || target.kind !== 'exact' || !isUuid(target.providerInstanceId)) {
    return { ok: false, error: 'providerTarget must be {kind: "exact", providerInstanceId: uuid} — the authorization gate requires an exact provider' }
  }
  if (request.input !== undefined && request.input !== null) {
    const input = request.input
    if (typeof input !== 'object' || typeof input.contract !== 'string') return { ok: false, error: 'input.contract required' }
    const contractRef = `${input.contract}`
    if (countChar(contractRef, '@') !== 1) return { ok: false, error: 'input.contract must be "contract.id@major.minor"' }
    const [cid, cver] = contractRef.split('@')
    if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$/.test(cid) || !PATTERNS.capabilityVersion.test(cver)) {
      return { ok: false, error: 'input.contract malformed (dotted snake_case id, major ≥ 1)' }
    }
    const values = input.values ?? {}
    const names = Object.keys(values)
    if (names.length > 64) return { ok: false, error: 'too many arguments (max 64)' }
    for (const [name, value] of Object.entries(values)) {
      if (!PATTERNS.argumentName.test(name)) return { ok: false, error: `argument name "${name}" must be canonical snake_case` }
      const kind = typeof value
      if (kind === 'string') {
        if (value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) return { ok: false, error: `argument "${name}": text too long or control character` }
      } else if (kind === 'number') {
        if (!Number.isFinite(value)) return { ok: false, error: `argument "${name}": non-finite decimal` }
      } else if (kind !== 'boolean') {
        return { ok: false, error: `argument "${name}": only Text/Integer/Decimal/Flag are allowed` }
      }
    }
  }
  return { ok: true, request: { ...request, _capability: cap.reference } }
}

// ---------- result builder (mirrors CapabilityResult.create) ----------

export function buildCapabilityResult({ request, providerInstanceId, occurredAt, state, failure = null, evidence = 'PROVIDER_REPORTED', output = undefined }) {
  const errors = []
  if (!RESULT_STATES.includes(state)) errors.push('unknown state')
  if (!isUuid(request?.requestId)) errors.push('request.requestId missing')
  if (!isUuid(request?.auditId)) errors.push('request.auditId missing')
  if (['ACCEPTED', 'STARTED', 'COMPLETED'].includes(state) && failure !== null) errors.push(`${state} must not carry a failure`)
  if (state === 'REJECTED' && !(failure && REJECTED_CODES.has(failure.code))) errors.push('REJECTED requires a rejection failure code')
  if (state === 'FAILED' && !(failure && FAILED_CODES.has(failure.code))) errors.push('FAILED requires a transport/provider failure code')
  if (state === 'CANCELLED' && !(failure && failure.code === 'CANCELLED')) errors.push('CANCELLED requires failure code CANCELLED')
  if (state === 'TIMED_OUT' && !(failure && failure.code === 'TIMEOUT')) errors.push('TIMED_OUT requires failure code TIMEOUT')
  if (state === 'UNKNOWN' && !(failure && failure.code === 'UNKNOWN')) errors.push('UNKNOWN requires failure code UNKNOWN')
  if ((state === 'COMPLETED') !== (output !== undefined && output !== null)) errors.push('output present iff COMPLETED')
  if (state === 'UNKNOWN' && evidence !== 'OUTCOME_UNKNOWN') errors.push('UNKNOWN state requires OUTCOME_UNKNOWN evidence')
  if (evidence === 'OUTCOME_UNKNOWN' && state !== 'UNKNOWN') errors.push('OUTCOME_UNKNOWN evidence only with UNKNOWN state')
  if (evidence === 'REQUEST_ACCEPTED' && state !== 'ACCEPTED') errors.push('REQUEST_ACCEPTED evidence only with ACCEPTED state')
  if (failure) {
    if (!FAILURE_CODES.includes(failure.code)) errors.push('unknown failure code')
    if (failure.reasonCode !== undefined && failure.reasonCode !== null && !PATTERNS.reasonCode.test(failure.reasonCode)) {
      errors.push('reasonCode must be canonical dotted lowercase')
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    result: {
      requestId: request.requestId,
      capability: request.capability,
      providerInstanceId,
      executionContext: request.executionContext,
      occurredAt,
      state,
      failure: failure ? { code: failure.code, ...(failure.reasonCode ? { reasonCode: failure.reasonCode } : {}) } : null,
      evidence,
      output: output ?? null,
      auditId: request.auditId,
    },
  }
}

// ---------- negotiation (mirrors CapabilityNegotiationResult.create) ----------

export function buildNegotiationResult(providerInstanceId, requested, offeredByWire) {
  if (!Array.isArray(requested) || requested.length === 0) return { ok: false, error: 'empty negotiation' }
  if (requested.length > 64) return { ok: false, error: 'too many capabilities (max 64)' }
  if (new Set(requested).size !== requested.length) return { ok: false, error: 'duplicate capability references' }
  const entries = []
  const parsed = []
  for (const wire of requested) {
    const cap = parseCapabilityReference(wire)
    if (!cap.ok) return { ok: false, error: `capability "${wire}": ${cap.error}` }
    parsed.push(cap.reference)
  }
  for (const reference of parsed) {
    const offeredWire = offeredByWire[reference.wireValue] ?? offeredByWire[`${reference.namespace}.${reference.name}`] ?? null
    if (offeredWire === null) {
      if (!supportedByAdapter(reference)) {
        entries.push({ requested: reference.wireValue, state: 'UNSUPPORTED', offered: null })
      } else {
        entries.push({ requested: reference.wireValue, state: 'SUPPORTED', offered: null })
      }
      continue
    }
    const offered = parseCapabilityReference(offeredWire)
    if (!offered.ok) return { ok: false, error: `offered "${offeredWire}": ${offered.error}` }
    const compat = compatibilityWith(offered.reference, reference)
    entries.push({
      requested: reference.wireValue,
      state: compat.compatible ? 'SUPPORTED' : 'INCOMPATIBLE',
      offered: compat.compatible ? offeredWire : offeredWire,
    })
  }
  if (entries.filter(e => e.state === 'SUPPORTED' && e.offered !== null).some(e => {
    const offered = parseCapabilityReference(e.offered)
    const required = parseCapabilityReference(e.requested)
    return !compatibilityWith(offered.reference, required.reference).compatible
  })) {
    return { ok: false, error: 'invalid negotiation entry: SUPPORTED with incompatible offered' }
  }
  return {
    ok: true,
    result: { providerInstanceId, generation: null, entries },
  }
}

function supportedByAdapter(_reference) {
  return false   // the caller supplies the supported map; absent means unsupported
}

// ---------- runtime snapshot (mirrors ProviderRuntimeSnapshot.create) ----------

export function buildRuntimeSnapshot(generation, availability, observedAt, reason = null) {
  if (!Number.isInteger(generation) || generation < 0) return { ok: false, error: 'generation must be a non-negative integer' }
  if (!AVAILABILITY.includes(availability)) return { ok: false, error: 'unknown availability' }
  if (!Number.isInteger(observedAt) || observedAt < 0) return { ok: false, error: 'observedAt must be MonotonicTimestampMs' }
  if ((availability === 'AVAILABLE') !== (reason === null)) return { ok: false, error: 'AVAILABLE iff reason is null' }
  if (reason !== null && !AVAILABILITY_REASONS.includes(reason)) return { ok: false, error: 'unknown availability reason' }
  return { ok: true, snapshot: { generation, availability, observedAt, reason } }
}

// ---------- manifest documents (mirrors CommonProviderManifestCodec / SpecializedProviderManifestCodec) ----------

export function manifestDigest(payloadObject) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(payloadObject)).digest('hex')
  return `sha256:${hash}`
}

export function buildCommonManifestDocument(manifest) {
  // mirrors CommonProviderManifestCodec rootFields + field order
  const payload = {
    schemaVersion: manifest.schemaVersion,
    provider: manifest.provider,
    adapter: manifest.adapter,
    capabilities: [...manifest.capabilities].sort(),
    connectionMethods: [...manifest.connectionMethods].sort((a, b) => a.reference.localeCompare(b.reference)),
    requirements: [...manifest.requirements].sort((a, b) => a.kind.localeCompare(b.kind) || a.reference.localeCompare(b.reference)),
    compatibility: [...manifest.compatibility].sort((a, b) => a.subject.localeCompare(b.subject)),
    extensions: [],
    provenance: manifest.provenance,
  }
  const digest = manifestDigest(payload)
  return {
    schemaVersion: payload.schemaVersion,
    digest,
    provider: payload.provider,
    adapter: payload.adapter,
    capabilities: payload.capabilities,
    connectionMethods: payload.connectionMethods,
    requirements: payload.requirements,
    compatibility: payload.compatibility,
    extensions: payload.extensions,
    provenance: payload.provenance,
  }
}

export function buildDeviceManifestDocument({ schemaVersion, common, capabilityGroups, placementSemantics = [], powerCharacteristic, controlLocality, extensions = [] }) {
  // enum values are encoded lowercase by the Kotlin codec (name.lowercase())
  const payload = {
    kind: 'device',
    schemaVersion,
    common,
    extensions,
    details: {
      category: String('camera').toLowerCase(),
      capabilityGroups,
      placementSemantics,
      powerCharacteristic: String(powerCharacteristic ?? 'unknown').toLowerCase(),
      controlLocality: String(controlLocality ?? 'none').toLowerCase(),
    },
  }
  const digest = manifestDigest(payload)
  return { ...payload, digest }
}
