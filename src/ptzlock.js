import { log } from './log.js'

/**
 * Global PTZ mutex: only one controller (API call, patrol, future HUGO Core
 * adapter action) may drive camera movement at any time. Requests queue in
 * arrival order; the camera-side PT1S ContinuousMove timeout is the backstop.
 */
class PtzLock {
  constructor() {
    this.queue = []
    this.busy = false
    this.holder = null
  }

  async acquire(holder = 'unknown') {
    return new Promise(resolve => {
      const entry = { holder, resolve }
      this.queue.push(entry)
      this._drain()
    })
  }

  release() {
    if (!this.busy) return
    this.busy = false
    this.holder = null
    this._drain()
  }

  _drain() {
    if (this.busy) return
    const entry = this.queue.shift()
    if (!entry) return
    this.busy = true
    this.holder = entry.holder
    entry.resolve({
      holder: entry.holder,
      queuedBehind: this.queue.length,
      done: () => this.release(),
    })
  }

  status() {
    return { busy: this.busy, holder: this.holder, queued: this.queue.length }
  }
}

export const ptzLock = new PtzLock()

/** Runs `fn` while holding the PTZ lock. */
export async function withPtzLock(holder, fn) {
  const session = await ptzLock.acquire(holder)
  try {
    return await fn(session)
  } finally {
    session.done()
  }
}
