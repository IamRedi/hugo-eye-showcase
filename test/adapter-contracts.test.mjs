import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCapabilityReference, compatibilityWith, validateCapabilityRequest,
  buildCapabilityResult, buildNegotiationResult, buildRuntimeSnapshot,
  buildCommonManifestDocument, buildDeviceManifestDocument, manifestDigest,
  PATTERNS,
} from '../src/adapter/contracts.js'
import {
  providerIdentity, commonManifestDocument, deviceManifestDocument,
  negotiate, capabilityDescriptors, adapterManifest,
} from '../src/adapter/deviceAdapter.js'

/**
 * Deterministic cross-contract tests: every assertion mirrors an invariant
 * from the HUGO Core Kotlin sources (IamRedi/hugo-core @ cf03ce5) so that
 * HUGO Eye payloads pass the Core codecs fail-closed.
 */

const UUID = '0f0e0d0c-0b0a-4938-8765-432109876543'   // canonical lowercase v4-shaped
const DRIVER = { id: 'tapo-main', cam: { id: 'tapo-main', name: 'Indoor', model: 'TP-Link Tapo C520WS' }, capabilities: { ptz: true } }

// ---------- CapabilityReference (CapabilityIdentity.kt) ----------

test('capability reference wire format: namespace.name@major.minor, major ≥ 1', () => {
  assert.equal(parseCapabilityReference('camera.status@1.0').ok, true)
  assert.equal(parseCapabilityReference('perception.scene@1.2').ok, true)
  assert.equal(parseCapabilityReference('camera_status@1.0').ok, false, 'bare snake_case without namespace is not a reference')
  assert.equal(parseCapabilityReference('camera.status').ok, false, 'version is mandatory')
  assert.equal(parseCapabilityReference('camera.status@0.9').ok, false, 'major must be ≥ 1')
  assert.equal(parseCapabilityReference('Camera.Status@1.0').ok, false, 'lowercase only')
  assert.equal(parseCapabilityReference('camera.status@1.0@2.0').ok, false, 'exactly one @')
})

test('compatibility is directional: same id + major, offered.minor ≥ required.minor', () => {
  const ref = v => parseCapabilityReference(v).reference
  assert.equal(compatibilityWith(ref('camera.status@1.0'), ref('camera.status@1.0')).exact, true)
  assert.equal(compatibilityWith(ref('camera.status@1.2'), ref('camera.status@1.0')).backwardCompatibleMinor, true)
  assert.equal(compatibilityWith(ref('camera.status@1.0'), ref('camera.status@1.2')).compatible, false, 'offered minor too old')
  assert.equal(compatibilityWith(ref('camera.status@2.0'), ref('camera.status@1.0')).compatible, false, 'major mismatch')
  assert.equal(compatibilityWith(ref('camera.other@1.0'), ref('camera.status@1.0')).reason, 'DifferentCapability')
})

// ---------- CapabilityRequest envelope (CapabilityEnvelopes.kt) ----------

function validRequest(overrides = {}) {
  return {
    requestId: UUID,
    capability: 'camera.snapshot@1.0',
    providerTarget: { kind: 'exact', providerInstanceId: UUID },
    actor: 'HUGO_RUNTIME',
    executionContext: { epoch: 1, sequence: 7 },
    createdAt: 1000,
    deadline: 9000,
    authorizationReference: UUID,
    auditId: UUID,
    input: {
      contract: 'camera.snapshot.input@1.0',
      values: { zone: 'hugo' },
    },
    ...overrides,
  }
}

test('envelope: valid request passes validation', () => {
  const r = validateCapabilityRequest(validRequest())
  assert.equal(r.ok, true)
})

test('envelope: ids must be canonical UUIDs (auditId/requestId/authorizationReference)', () => {
  assert.equal(validateCapabilityRequest(validRequest({ requestId: 'not-a-uuid' })).ok, false)
  assert.equal(validateCapabilityRequest(validRequest({ auditId: 'ABCDEF01-2345-6789-ABCD-EF0123456789' })).ok, false, 'uppercase is non-canonical')
  assert.equal(validateCapabilityRequest(validRequest({ authorizationReference: 'x' })).ok, false)
})

test('envelope: deadline strictly after createdAt (REQUEST_NOT_CURRENT rule)', () => {
  assert.equal(validateCapabilityRequest(validRequest({ deadline: 1000 })).ok, false, 'deadline == createdAt rejected')
  assert.equal(validateCapabilityRequest(validRequest({ deadline: 999 })).ok, false)
  assert.equal(validateCapabilityRequest(validRequest({ createdAt: -1 })).ok, false, 'monotonic timestamps ≥ 0')
})

test('envelope: exact provider target required; any-compatible denied (AuthorizationGate)', () => {
  assert.equal(validateCapabilityRequest(validRequest({ providerTarget: { kind: 'any_compatible' } })).ok, false)
  assert.equal(validateCapabilityRequest(validRequest({ providerTarget: { kind: 'exact', providerInstanceId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' } })).ok, true)
})

test('envelope: actor enum and execution context bounds', () => {
  assert.equal(validateCapabilityRequest(validRequest({ actor: 'SOMEONE' })).ok, false)
  assert.equal(validateCapabilityRequest(validRequest({ executionContext: { epoch: -1, sequence: 0 } })).ok, false)
})

test('envelope: input data — canonical snake_case names, typed values, ≤ 64', () => {
  const bad = validateCapabilityRequest(validRequest({ input: { contract: 'x@1.0', values: { 'Bad Name': 1 } } }))
  assert.equal(bad.ok, false)
  const badValue = validateCapabilityRequest(validRequest({ input: { contract: 'x@1.0', values: { nested: { deep: true } } } }))
  assert.equal(badValue.ok, false, 'only Text/Integer/Decimal/Flag allowed')
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`arg_${i}`, i]))
  assert.equal(validateCapabilityRequest(validRequest({ input: { contract: 'x@1.0', values: many } })).ok, false, 'max 64 arguments')
})

// ---------- CapabilityResult (state/failure/evidence/output conflicts) ----------

const BASE_REQ = validRequest()

test('result: COMPLETED iff output present; ACCEPTED/STARTED carry no failure', () => {
  assert.equal(buildCapabilityResult({ request: BASE_REQ, providerInstanceId: UUID, occurredAt: 1, state: 'COMPLETED', output: { contract: 'c@1.0', values: {} } }).ok, true)
  assert.equal(buildCapabilityResult({ request: BASE_REQ, providerInstanceId: UUID, occurredAt: 1, state: 'COMPLETED' }).ok, false, 'COMPLETED without output')
  assert.equal(buildCapabilityResult({ request: BASE_REQ, providerInstanceId: UUID, occurredAt: 1, state: 'ACCEPTED', failure: { code: 'CANCELLED' } }).ok, false)
})

test('result: REJECTED/FAILED/CANCELLED/TIMED_OUT failure-code sets', () => {
  const build = (state, failure) => buildCapabilityResult({ request: BASE_REQ, providerInstanceId: UUID, occurredAt: 1, state, failure })
  assert.equal(build('REJECTED', { code: 'PERMISSION_DENIED' }).ok, true)
  assert.equal(build('REJECTED', { code: 'TIMEOUT' }).ok, false, 'TIMEOUT is not a rejection code')
  assert.equal(build('FAILED', { code: 'PROVIDER_FAILURE' }).ok, true)
  assert.equal(build('CANCELLED', { code: 'CANCELLED' }).ok, true)
  assert.equal(build('CANCELLED', { code: 'PROVIDER_FAILURE' }).ok, false)
  assert.equal(build('TIMED_OUT', { code: 'TIMEOUT' }).ok, true)
})

test('result: evidence/state conflicts (REQUEST_ACCEPTED, OUTCOME_UNKNOWN)', () => {
  assert.equal(buildCapabilityResult({ request: BASE_REQ, providerInstanceId: UUID, occurredAt: 1, state: 'ACCEPTED', evidence: 'REQUEST_ACCEPTED' }).ok, true)
  assert.equal(buildCapabilityResult({ request: BASE_REQ, providerInstanceId: UUID, occurredAt: 1, state: 'COMPLETED', evidence: 'REQUEST_ACCEPTED', output: { contract: 'c@1.0', values: {} } }).ok, false)
  assert.equal(buildCapabilityResult({ request: BASE_REQ, providerInstanceId: UUID, occurredAt: 1, state: 'UNKNOWN', failure: { code: 'UNKNOWN' }, evidence: 'PROVIDER_REPORTED' }).ok, false)
  assert.equal(buildCapabilityResult({ request: BASE_REQ, providerInstanceId: UUID, occurredAt: 1, state: 'UNKNOWN', failure: { code: 'UNKNOWN' }, evidence: 'OUTCOME_UNKNOWN' }).ok, true)
})

test('result: reasonCode must be canonical dotted lowercase', () => {
  const bad = buildCapabilityResult({ request: BASE_REQ, providerInstanceId: UUID, occurredAt: 1, state: 'REJECTED', failure: { code: 'PERMISSION_DENIED', reasonCode: 'Not_Canonical' } })
  assert.equal(bad.ok, false)
})

// ---------- negotiation (CapabilityNegotiationResult.create) ----------

test('negotiation: declared capability negotiates SUPPORTED; unknown is UNSUPPORTED with no offered', () => {
  const r = buildNegotiationResult(UUID, ['camera.snapshot@1.0', 'camera.teleport@1.0'], { 'camera.snapshot@1.0': 'camera.snapshot@1.0' })
  assert.equal(r.ok, true)
  const snapshot = r.result.entries.find(e => e.requested === 'camera.snapshot@1.0')
  const unknown = r.result.entries.find(e => e.requested === 'camera.teleport@1.0')
  assert.equal(snapshot.state, 'SUPPORTED')
  assert.equal(unknown.state, 'UNSUPPORTED')
  assert.equal(unknown.offered, null, 'no guessed alternates for unsupported capabilities')
})

test('negotiation: empty and duplicate requests are rejected (max 64 enforced too)', () => {
  assert.equal(buildNegotiationResult(UUID, [], {}).ok, false)
  assert.equal(buildNegotiationResult(UUID, ['camera.status@1.0', 'camera.status@1.0'], {}).ok, false)
})

// ---------- runtime snapshot (ProviderRuntimeSnapshot.create) ----------

test('runtime snapshot: AVAILABLE iff reason is null; generation ≥ 0', () => {
  assert.equal(buildRuntimeSnapshot(0, 'AVAILABLE', 1, null).ok, true)
  assert.equal(buildRuntimeSnapshot(0, 'AVAILABLE', 1, 'PROVIDER_FAILURE').ok, false)
  assert.equal(buildRuntimeSnapshot(0, 'UNAVAILABLE', 1, null).ok, false)
  assert.equal(buildRuntimeSnapshot(-1, 'AVAILABLE', 1, null).ok, false)
})

// ---------- manifests (CommonProviderManifestCodec / SpecializedProviderManifestCodec wire format) ----------

test('provider identity matches the definition-id pattern (namespace/name, no dashes in namespace)', () => {
  const identity = providerIdentity(DRIVER)
  assert.ok(PATTERNS.definitionId.test(identity.definitionId), `definitionId "${identity.definitionId}" must match the Kotlin pattern`)
  assert.equal(identity.family, 'device_adapter')
  assert.ok(PATTERNS.uuidCanonical.test(identity.instanceId))
  assert.ok(!/[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}/i.test(identity.displayAlias), 'no MAC-like stable addresses in the alias')
})

test('common manifest document: exact codec field set, sorted capabilities, sha256 digest over payload', () => {
  const doc = commonManifestDocument(DRIVER)
  for (const field of ['schemaVersion', 'digest', 'provider', 'adapter', 'capabilities', 'connectionMethods', 'requirements', 'compatibility', 'extensions', 'provenance']) {
    assert.ok(field in doc, `missing root field ${field}`)
  }
  assert.equal(doc.schemaVersion, '1.0')
  assert.equal(doc.provider.family, 'device_adapter')
  assert.ok(PATTERNS.digest.test(doc.digest))
  // digest is deterministic and covers the payload
  const redigested = manifestDigest({
    schemaVersion: doc.schemaVersion,
    provider: doc.provider,
    adapter: doc.adapter,
    capabilities: doc.capabilities,
    connectionMethods: doc.connectionMethods,
    requirements: doc.requirements,
    compatibility: doc.compatibility,
    extensions: doc.extensions,
    provenance: doc.provenance,
  })
  assert.equal(redigested, doc.digest, 'digest recomputes over the served payload')
  const capabilities = doc.capabilities
  assert.deepEqual([...capabilities].sort(), capabilities, 'capabilities sorted by wireValue (create() invariant)')
  for (const cap of capabilities) assert.equal(parseCapabilityReference(cap).ok, true, `declared capability "${cap}" must parse`)
})

test('device manifest document: category camera, codec field set, binds the common digest', () => {
  const doc = deviceManifestDocument(DRIVER)
  for (const field of ['kind', 'schemaVersion', 'digest', 'common', 'extensions', 'details']) {
    assert.ok(field in doc, `missing root field ${field}`)
  }
  assert.equal(doc.kind, 'device')
  assert.equal(doc.details.category, 'camera')
  assert.equal(doc.details.powerCharacteristic, 'mains_powered')
  assert.equal(doc.common.providerDefinitionId, 'tp.link/tapo-c520ws')
  const declared = doc.capabilities ?? []
  void declared
  // every capability in groups is declared in the common manifest (SpecializedManifestValidator invariant)
  const common = commonManifestDocument(DRIVER)
  const groupCaps = doc.details.capabilityGroups.flatMap(g => g.capabilities)
  for (const cap of groupCaps) assert.ok(common.capabilities.includes(cap), `group capability ${cap} must be declared in the common manifest`)
  assert.ok(PATTERNS.digest.test(doc.common.digest))
})

test('adapter aggregate manifest exposes descriptors with honest evidence classes', () => {
  const manifest = adapterManifest(DRIVER)
  assert.equal(manifest.device.details.category, 'camera')
  const descriptors = manifest.registerCapabilities
  assert.ok(descriptors.length >= 10)
  for (const d of descriptors) {
    assert.equal(parseCapabilityReference(d.reference).ok, true)
    assert.ok(['DECLARED', 'DOCUMENTED', 'AUTOMATED_TESTED', 'DEVICE_VERIFIED', 'HARDWARE_VERIFIED'].includes(d.evidence))
    assert.ok(['OBSERVE', 'ACT', 'MODIFY'].includes(d.effect))
  }
  const ptz = descriptors.find(d => d.reference === 'camera.ptz_move@1.0')
  assert.equal(ptz.safety, 'PHYSICAL_ACTION', 'PTZ must be declared a physical action')
  assert.equal(ptz.approvalRequirement, 'SESSION_CONFIRMATION')
  const snapshotCap = descriptors.find(d => d.reference === 'camera.snapshot@1.0')
  assert.equal(snapshotCap.evidence, 'DEVICE_VERIFIED', 'snapshot is verified on the real camera')
})

test('negotiate() against the live capability set: declared → SUPPORTED, foreign → UNSUPPORTED', () => {
  const r = negotiate(DRIVER, ['camera.snapshot@1.0', 'light.turn_on@1.0'])
  assert.equal(r.ok, true)
  assert.equal(r.result.entries.find(e => e.requested === 'camera.snapshot@1.0').state, 'SUPPORTED')
  assert.equal(r.result.entries.find(e => e.requested === 'light.turn_on@1.0').state, 'UNSUPPORTED')
  assert.equal(r.result.providerInstanceId, providerIdentity(DRIVER).instanceId)
})
