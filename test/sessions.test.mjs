import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.HUGO_EYE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eye-sessions-'))
const dbMod = await import('../src/db.js')
const { VisitSessionizer } = await import('../src/vision/sessions.js')
const { eventBus } = await import('../src/eventbus.js')
await dbMod.openDb()
const { recordEvent, db } = dbMod

// a known person profile so recognition events resolve to a name
db.prepare('INSERT INTO people (id, name, notes, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
  .run('p-alice', 'Alice', '', new Date().toISOString(), new Date().toISOString())

function emit(type, cameraId, detail, opts = {}) {
  const id = recordEvent(type, cameraId, detail, opts)
  const row = { id, type, cameraId, at: new Date().toISOString(), detail, ...opts }
  eventBus.emit('event', row)
  return id
}

test('visit: person presence events fold into one session with correlated timeline', async () => {
  const s = new VisitSessionizer()
  const a = emit('person', 'cam1', 'person arrived (confidence 0.80, track 1)', {})
  const b = emit('person_known', 'cam1', 'Alice recognized (similarity 0.81)', { personId: 'p-alice' })
  const c = emit('person', 'cam1', 'person present (count 2)', {})
  // unrelated motion must not extend or open visits
  const m = emit('motion', 'cam1', 'motion detected', {})
  assert.equal(s.open.size, 1)
  const visit = [...s.open.values()][0]
  assert.equal(visit.memberIds.length, 3, 'all three presence events join; motion does not')
  // scene goes quiet → session closes on the next tick trigger
  s._close(visit, 'gap')
  const summary = s.status()
  assert.equal(summary.openVisits.length, 0)
  // summary event exists and is correlated
  const linked = db.prepare('SELECT COUNT(*) n FROM events WHERE correlation_id = ?').get(visit.id).n
  assert.ok(linked >= 3, `opening + members + summary linked (got ${linked})`)
  const sum = db.prepare("SELECT detail, type FROM events WHERE type = 'visit.summary' AND correlation_id = ?").get(visit.id)
  assert.ok(sum, 'summary event written')
  assert.ok(sum.detail.includes('with Alice'), 'known person named in the summary')
  assert.ok(sum.detail.includes('3 linked event(s)'), 'member count in summary')
})
