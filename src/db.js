import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'
import { log } from './log.js'

const SCHEMA_VERSION = 5

export let db = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  camera_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  pan REAL NOT NULL,
  tilt REAL NOT NULL,
  zoom REAL NOT NULL DEFAULT 0,
  timelapse_every_min INTEGER,
  timelapse_at TEXT,
  timelapse_enabled INTEGER NOT NULL DEFAULT 0,
  capture_zone TEXT NOT NULL DEFAULT 'overview',
  last_captured_at TEXT,
  last_capture_path TEXT,
  last_capture_status TEXT,
  last_capture_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_presets_camera ON presets(camera_id);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id TEXT NOT NULL,
  zone TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  captured_at TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'snapshot'
);
CREATE INDEX IF NOT EXISTS idx_media_camera ON media(camera_id);

CREATE TABLE IF NOT EXISTS health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id TEXT NOT NULL,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  rtsp_ok INTEGER NOT NULL DEFAULT 0,
  onvif_ok INTEGER NOT NULL DEFAULT 0,
  detail TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  camera_id TEXT,
  detail TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

// V2 product tables (indoor platform)
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS camera_settings (
  camera_id TEXT PRIMARY KEY,
  display_name TEXT,
  rotate INTEGER NOT NULL DEFAULT 0,
  mirror INTEGER NOT NULL DEFAULT 0,
  flip INTEGER NOT NULL DEFAULT 0,
  privacy_disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  camera_id TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_s REAL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'recording'
);
CREATE INDEX IF NOT EXISTS idx_rec_camera ON recordings(camera_id);
CREATE INDEX IF NOT EXISTS idx_rec_group ON recordings(group_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  label TEXT DEFAULT 'panel',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT DEFAULT ''
);

ALTER TABLE events ADD COLUMN confidence REAL;
ALTER TABLE events ADD COLUMN thumb_path TEXT;
`

// V3: unified intelligence schema (EYE-022)
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  notes TEXT DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS face_images (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  embedding BLOB NOT NULL,
  quality REAL,
  source TEXT NOT NULL DEFAULT 'upload',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_face_images_person ON face_images(person_id);

CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  conditions TEXT NOT NULL,
  actions TEXT NOT NULL,
  cooldown_sec INTEGER NOT NULL DEFAULT 60,
  last_fired_at TEXT,
  last_error TEXT,
  fire_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE events ADD COLUMN provider TEXT;
ALTER TABLE events ADD COLUMN track_id INTEGER;
ALTER TABLE events ADD COLUMN person_id TEXT;
ALTER TABLE events ADD COLUMN zone TEXT;
ALTER TABLE events ADD COLUMN correlation_id TEXT;
ALTER TABLE events ADD COLUMN clip_path TEXT;

CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_camera_at ON events(camera_id, at);
`

// V4: camera registry + search/VLM/automation-history foundations (EYE-023)
const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS cameras (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'tapo',
  name TEXT NOT NULL,
  model TEXT DEFAULT 'unknown',
  host TEXT NOT NULL,
  rtsp_port INTEGER NOT NULL DEFAULT 554,
  onvif_port INTEGER NOT NULL DEFAULT 2020,
  main_path TEXT NOT NULL DEFAULT '/stream1',
  sub_path TEXT NOT NULL DEFAULT '/stream2',
  username TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE events ADD COLUMN description TEXT;

CREATE TABLE IF NOT EXISTS event_descriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  model TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'description'
);
CREATE INDEX IF NOT EXISTS idx_event_descriptions_event ON event_descriptions(event_id);

CREATE TABLE IF NOT EXISTS event_embeddings (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  embedding BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL,
  event_id INTEGER,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT DEFAULT '',
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_rule ON automation_runs(rule_id, at);
`

// V5: recording thumbnails + per-camera retention (EYE-023 Gate 7)
const SCHEMA_V5 = `
ALTER TABLE recordings ADD COLUMN thumb_path TEXT;
ALTER TABLE camera_settings ADD COLUMN retention_days INTEGER;
ALTER TABLE camera_settings ADD COLUMN recording_enabled INTEGER NOT NULL DEFAULT 1;
`

const MIGRATIONS = {
  2: SCHEMA_V2,
  3: SCHEMA_V3,
  4: SCHEMA_V4,
  5: SCHEMA_V5,
}

export function openDb() {
  fs.mkdirSync(path.dirname(config.storage.dbPath), { recursive: true })
  db = new DatabaseSync(config.storage.dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)
  const version = Number(db.prepare("SELECT value FROM kv WHERE key='schema_version'").get()?.value ?? 1)
  for (let v = version; v < SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v + 1]
    if (!sql) break
    try {
      db.exec(sql)
    } catch (error) {
      // ALTER ADD COLUMN fails if columns already exist (partial prior run) — safe to continue.
      if (!String(error.message).includes('duplicate column')) throw error
    }
  }
  // UPSERT (not DO NOTHING): the stored version must advance with the schema,
  // otherwise every boot re-runs all migrations.
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('schema_version', String(SCHEMA_VERSION))
  log.info(`database ready (schema v${SCHEMA_VERSION}) at ${config.storage.dbPath}`)
  initIndoorProduct()
  return db
}

/**
 * V2 product initialization — runs once. Separates the garden-era 0.1.0 data
 * from the active indoor product without destroying anything:
 *  - garden presets are moved to legacy_presets (kept in the DB file)
 *  - 0.1.0-era media files are moved to ~/hugo-eye-data/legacy-media-<ts>/
 *  - the first camera gets display name + its mount rotation (CAM1_ROTATE,
 *    e.g. 180 for an inverted ceiling mount; default 0)
 */
function initialRotate() {
  const rotate = Number(process.env.CAM1_ROTATE ?? 0)
  return [0, 90, 180, 270].includes(rotate) ? rotate : 0
}

export function initIndoorProduct() {
  if (db.prepare("SELECT value FROM kv WHERE key='product_init_done'").get()) return
  try {
    const presetCount = db.prepare('SELECT count(*) AS n FROM presets').get().n
    if (presetCount > 0) {
      db.exec(`CREATE TABLE IF NOT EXISTS legacy_presets AS SELECT * FROM presets WHERE 0`)
      db.exec('INSERT INTO legacy_presets SELECT * FROM presets')
      db.exec('DELETE FROM presets')
      log.info(`indoor init: moved ${presetCount} garden-era presets to legacy_presets`)
    }
    const mediaRoot = config.storage.mediaDir
    if (fs.existsSync(mediaRoot)) {
      const entries = fs.readdirSync(mediaRoot).filter(e => !e.startsWith('.') && e !== 'recordings' && e !== 'events')
      if (entries.length > 0) {
        const legacyDir = path.join(path.dirname(mediaRoot), `legacy-media-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}`)
        fs.mkdirSync(legacyDir, { recursive: true })
        for (const entry of entries) {
          fs.renameSync(path.join(mediaRoot, entry), path.join(legacyDir, entry))
        }
        db.exec('DELETE FROM media')
        log.info(`indoor init: moved ${entries.length} legacy media folders to ${legacyDir}`)
      }
    }
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO camera_settings (camera_id, display_name, rotate, mirror, flip, created_at, updated_at)
        VALUES (?, ?, ?, 0, 0, ?, ?)
        ON CONFLICT(camera_id) DO NOTHING`)
      .run(config.cameras[0]?.id ?? 'tapo-main', 'Indoor', initialRotate(), now, now)
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('product_init_done', now)
    log.info('indoor product initialized (fresh media library, legacy data separated)')
  } catch (error) {
    log.error(`indoor init failed (will retry next start): ${error.message}`)
  }
}

export function recordEvent(type, cameraId = null, detail = '', {
  confidence = null, thumbPath = null, provider = null, trackId = null,
  personId = null, zone = null, correlationId = null, clipPath = null,
} = {}) {
  if (!db) return null
  const info = db.prepare(`INSERT INTO events (at, type, camera_id, detail, confidence, thumb_path,
        provider, track_id, person_id, zone, correlation_id, clip_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(new Date().toISOString(), type, cameraId, String(detail).slice(0, 2000), confidence, thumbPath,
      provider, trackId, personId, zone, correlationId, clipPath)
  return info.lastInsertRowid
}

export function kvGet(key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value)
  } catch {
    return row.value
  }
}

export function kvSet(key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
}

export function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'preset'
}

export function uniqueSlug(name, excludeId = null) {
  const base = slugify(name)
  let slug = base
  for (let i = 2; i < 100; i += 1) {
    const row = db.prepare('SELECT id FROM presets WHERE slug = ?').get(slug)
    if (!row || row.id === excludeId) return slug
    slug = `${base}-${i}`
  }
  return `${base}-${Date.now()}`
}

export function newId() {
  return crypto.randomBytes(12).toString('hex')
}
