import { EventEmitter } from 'node:events'
import { recordEvent } from './db.js'

/** Typed product event bus (SSE relay, automations, future adapter). */
export const eventBus = new EventEmitter()

/**
 * Internal signal bus — cross-module notifications that are NOT product
 * events (never persisted, never shown). Example: 'camera.moved' tells the
 * vision providers that PTZ invalidated all box evidence.
 */
export const signalBus = new EventEmitter()

/**
 * Single write path for product events: persist to the events table, then
 * broadcast one normalized payload on the bus. Automations and SSE clients
 * only see what goes through here — an event writer that bypasses publish()
 * is invisible to rules and live clients (this was the EYE-022 gap that made
 * stream.lost / recording.* unusable in automations).
 *
 * opts: { confidence, thumbPath, provider, trackId, personId, zone,
 *         correlationId, clipPath, label, person }
 */
export function publishEvent(type, cameraId = null, detail = '', opts = {}) {
  const id = recordEvent(type, cameraId, detail, opts)
  const event = {
    id,
    type,
    cameraId,
    detail,
    at: new Date().toISOString(),
    confidence: opts.confidence ?? null,
    thumb: opts.thumbPath ?? null,
    provider: opts.provider ?? null,
    trackId: opts.trackId ?? null,
    personId: opts.personId ?? null,
    zone: opts.zone ?? null,
    correlationId: opts.correlationId ?? null,
    clipPath: opts.clipPath ?? null,
    label: opts.label ?? null,
    person: opts.person ?? null,
  }
  eventBus.emit('event', event)
  return event
}
