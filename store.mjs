import { DatabaseSync, backup } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes, randomUUID, scrypt as derive, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import webPush from 'web-push'
import { config } from './config.mjs'

const scrypt = promisify(derive)
process.umask(0o077)
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
export const db = new DatabaseSync(join(config.dataDir, 'pingdeck.sqlite'), { timeout: 5000 })
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
    hint TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER
  ) STRICT;
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    name TEXT NOT NULL, device_group TEXT NOT NULL, created INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, message TEXT NOT NULL, url TEXT NOT NULL,
    target TEXT NOT NULL, created INTEGER NOT NULL, accepted INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS mobile_pair_codes (
    hash TEXT PRIMARY KEY, name TEXT NOT NULL, device_group TEXT NOT NULL, expires INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS mobile_pair_receipts (
    hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS mobile_devices (
    id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    device_group TEXT NOT NULL, created INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS mobile_queue (
    device_id TEXT NOT NULL REFERENCES mobile_devices(id) ON DELETE CASCADE,
    id TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, url TEXT NOT NULL,
    urgency TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
    PRIMARY KEY (device_id, id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS mobile_queue_expiry ON mobile_queue (expires);
  CREATE INDEX IF NOT EXISTS history_created ON history (created DESC);
`)

export const hash = value => createHash('sha256').update(value).digest('hex')
export const token = () => randomBytes(32).toString('base64url')
const day = 86_400_000
export const sessionAge = 7 * day

export function setting(name) {
  return db.prepare('SELECT value FROM settings WHERE name = ?').get(name)?.value
}

export function setSetting(name, value) {
  db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value')
    .run(name, value)
}

export function vapidKeys() {
  const current = setting('vapid')
  if (current) return JSON.parse(current)
  db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('vapid', JSON.stringify(webPush.generateVAPIDKeys()))
  return JSON.parse(setting('vapid'))
}

export async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return salt + ':' + (await scrypt(password, salt, 64)).toString('hex')
}

export async function validPassword(password) {
  const stored = setting('password')
  if (!stored) return false
  const candidate = await passwordHash(password, stored.split(':')[0])
  return setting('password') === stored && timingSafeEqual(Buffer.from(stored), Buffer.from(candidate))
}

export function issueSetupCode(reset = false) {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (setting('password') && !reset) throw new Error('Účet je nastavený. Na jeho obnovu použi príkaz reset.')
    const code = token()
    if (reset) {
      db.exec("DELETE FROM settings WHERE name = 'password'; DELETE FROM sessions")
    }
    setSetting('setup', hash(code))
    db.exec('COMMIT')
    return code
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function validSetup(code) {
  return setting('setup') === hash(code) && !setting('password')
}

export function finishSetup(code, password) {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (!validSetup(code)) return false
    setSetting('password', password)
    db.exec("DELETE FROM settings WHERE name = 'setup'; COMMIT")
    return true
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK')
  }
}

export function createSession() {
  const value = token()
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now())
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run(hash(value), Date.now() + sessionAge)
  return value
}

export function activeSession(value) {
  return Boolean(value && db.prepare('SELECT 1 FROM sessions WHERE hash = ? AND expires > ?')
    .get(hash(value), Date.now()))
}

export function deleteSession(value) {
  if (value) db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash(value))
}

export function apiKeys() {
  return db.prepare('SELECT id, label, hint, created, used FROM api_keys ORDER BY created DESC').all()
}

export function createApiKey(label) {
  const secret = 'pd_' + token()
  db.prepare('INSERT INTO api_keys VALUES (?, ?, ?, ?, ?, NULL)')
    .run(randomUUID(), hash(secret), label, secret.slice(0, 11), Date.now())
  return secret
}

export function verifyApiKey(secret) {
  return db.prepare('SELECT id FROM api_keys WHERE hash = ?').get(hash(secret))?.id
}

export function markApiKeyUsed(id) {
  db.prepare('UPDATE api_keys SET used = ? WHERE id = ?').run(Date.now(), id)
}

export function deleteApiKey(id) {
  return db.prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0
}

export function devices() {
  return db.prepare('SELECT id, name, device_group AS "group", created FROM devices ORDER BY created DESC').all()
}

export function deviceCount() {
  return db.prepare('SELECT (SELECT count(*) FROM devices) + (SELECT count(*) FROM mobile_devices) AS total')
    .get().total
}

export function saveDevice(name, group, { endpoint, keys }) {
  const existing = db.prepare('SELECT id FROM devices WHERE endpoint = ?').get(endpoint)
  if (existing) {
    db.prepare('UPDATE devices SET name = ?, device_group = ?, p256dh = ?, auth = ? WHERE id = ?')
      .run(name, group, keys.p256dh, keys.auth, existing.id)
    return existing.id
  }
  if (deviceCount() >= config.maxDevices) return null
  const id = randomUUID()
  db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, endpoint, keys.p256dh, keys.auth, name, group, Date.now())
  return id
}

export function updateDevice(id, name, group) {
  return db.prepare('UPDATE devices SET name = ?, device_group = ? WHERE id = ?').run(name, group, id).changes > 0
}

export function deleteDevice(id, endpoint = null) {
  return db.prepare('DELETE FROM devices WHERE id = ? AND (? IS NULL OR endpoint = ?)')
    .run(id, endpoint, endpoint).changes > 0
}

export function targets(deviceId, group) {
  if (deviceId) return db.prepare('SELECT * FROM devices WHERE id = ?').all(deviceId)
  if (group) return db.prepare('SELECT * FROM devices WHERE device_group = ?').all(group)
  return db.prepare('SELECT * FROM devices').all()
}

export function pruneHistory() {
  db.prepare('DELETE FROM history WHERE created < ?').run(Date.now() - config.historyDays * day)
}

export function recentHistory() {
  pruneHistory()
  return db.prepare('SELECT * FROM history ORDER BY created DESC, rowid DESC LIMIT 100').all()
}

export function historyExists(id) {
  return Boolean(db.prepare('SELECT 1 FROM history WHERE id = ?').get(id))
}

export function startHistory(id, { title, message, url }, target) {
  db.prepare("INSERT INTO history (id, title, message, url, target, created, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')")
    .run(id, title, message, url, target, Date.now())
}

export function finishHistory(id, { accepted, failed, status }) {
  db.prepare('UPDATE history SET accepted = ?, failed = ?, status = ? WHERE id = ?')
    .run(accepted, failed, status, id)
}

export function interruptPending() {
  db.exec("UPDATE history SET status = 'interrupted' WHERE status = 'pending'")
}

export async function snapshot(path) {
  await backup(db, path)
}
