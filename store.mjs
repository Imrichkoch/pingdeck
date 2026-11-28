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
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS registrations (
    email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires INTEGER NOT NULL, resend_after INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS mobile_queue_expiry ON mobile_queue (expires);
  CREATE INDEX IF NOT EXISTS history_created ON history (created DESC);
`)

export const ownerId = 'owner'

db.exec('BEGIN IMMEDIATE')
try {
  const scopedTables = ['sessions', 'api_keys', 'devices', 'mobile_devices',
    'mobile_pair_codes', 'mobile_pair_receipts', 'history']
  for (const table of scopedTables) {
    const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table)
    if (!columns.some(column => column.name === 'account_id')) {
      db.exec("ALTER TABLE " + table + " ADD COLUMN account_id TEXT NOT NULL DEFAULT 'owner'")
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS history_account_created ON history (account_id, created DESC);
    CREATE INDEX IF NOT EXISTS api_keys_account ON api_keys (account_id);
    CREATE INDEX IF NOT EXISTS devices_account ON devices (account_id);
    CREATE INDEX IF NOT EXISTS mobile_devices_account ON mobile_devices (account_id);
    CREATE INDEX IF NOT EXISTS mobile_pair_codes_account ON mobile_pair_codes (account_id);
    COMMIT;
  `)
} finally {
  if (db.isTransaction) db.exec('ROLLBACK')
}

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
      db.exec("DELETE FROM settings WHERE name = 'password'")
      db.prepare('DELETE FROM sessions WHERE account_id = ?').run(ownerId)
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

export function accountByEmail(email) {
  return db.prepare('SELECT id, password FROM accounts WHERE email = ?').get(email)
}

export function accountEmail(id) {
  return db.prepare('SELECT email FROM accounts WHERE id = ?').get(id)?.email ?? ''
}

const invalidAccountHash = '0'.repeat(32) + ':' + '0'.repeat(128)

// Account passwords use a higher work factor than the legacy administrator hash.
export async function accountPasswordHash(password, salt = randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64, { N: 131072, maxmem: 160 * 1024 * 1024 })
  return salt + ':' + derived.toString('hex')
}

export async function loginAccount(email, password) {
  const account = accountByEmail(email)
  const stored = account?.password ?? invalidAccountHash
  const candidate = await accountPasswordHash(password, stored.split(':')[0])
  return timingSafeEqual(Buffer.from(stored), Buffer.from(candidate)) ? account?.id : undefined
}

export function issueRegistration(email) {
  const now = Date.now()
  const password = token()
  db.prepare('DELETE FROM registrations WHERE expires <= ?').run(now)
  const created = db.prepare(
    'INSERT INTO registrations (email, hash, expires, resend_after) ' +
    'SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE email = ?) ' +
    'ON CONFLICT(email) DO UPDATE SET hash = excluded.hash, expires = excluded.expires, ' +
    'resend_after = excluded.resend_after WHERE registrations.resend_after <= ?'
  ).run(email, hash(password), now + 30 * 60_000, now + 5 * 60_000, email, now)
  return created.changes ? password : undefined
}

export function cancelRegistration(email, password) {
  db.prepare('DELETE FROM registrations WHERE email = ? AND hash = ?').run(email, hash(password))
}

export function validRegistration(email, password) {
  const row = db.prepare('SELECT hash FROM registrations WHERE email = ? AND expires > ?').get(email, Date.now())
  return row && timingSafeEqual(Buffer.from(row.hash), Buffer.from(hash(password)))
}

export function finishRegistration(email, temporaryPassword, password) {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (!validRegistration(email, temporaryPassword)) return
    const id = randomUUID()
    const created = db.prepare('INSERT OR IGNORE INTO accounts (id, email, password, created) VALUES (?, ?, ?, ?)')
      .run(id, email, password, Date.now())
    db.prepare('DELETE FROM registrations WHERE email = ?').run(email)
    db.exec('COMMIT')
    return created.changes ? id : undefined
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK')
  }
}

export function createSession(accountId = ownerId) {
  const value = token()
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now())
  db.prepare('INSERT INTO sessions (hash, expires, account_id) VALUES (?, ?, ?)')
    .run(hash(value), Date.now() + sessionAge, accountId)
  return value
}

export function sessionAccount(value) {
  return value && db.prepare('SELECT account_id FROM sessions WHERE hash = ? AND expires > ?')
    .get(hash(value), Date.now())?.account_id
}

export function deleteSession(value) {
  if (value) db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash(value))
}

export function apiKeys(accountId) {
  return db.prepare('SELECT id, label, hint, created, used FROM api_keys WHERE account_id = ? ORDER BY created DESC').all(accountId)
}

export function createApiKey(label, accountId) {
  const secret = 'pd_' + token()
  db.prepare('INSERT INTO api_keys (id, hash, label, hint, created, account_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), hash(secret), label, secret.slice(0, 11), Date.now(), accountId)
  return secret
}

export function verifyApiKey(secret) {
  return db.prepare('SELECT id, account_id AS accountId FROM api_keys WHERE hash = ?').get(hash(secret))
}

export function markApiKeyUsed(id) {
  db.prepare('UPDATE api_keys SET used = ? WHERE id = ?').run(Date.now(), id)
}

export function deleteApiKey(id, accountId) {
  return db.prepare('DELETE FROM api_keys WHERE id = ? AND account_id = ?').run(id, accountId).changes > 0
}

export function devices(accountId) {
  return db.prepare('SELECT id, name, device_group AS "group", created FROM devices WHERE account_id = ? ORDER BY created DESC')
    .all(accountId)
}

export function deviceCount(accountId) {
  return db.prepare('SELECT (SELECT count(*) FROM devices WHERE account_id = ?) + ' +
    '(SELECT count(*) FROM mobile_devices WHERE account_id = ?) AS total').get(accountId, accountId).total
}

export function saveDevice(name, group, { endpoint, keys }, accountId) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = db.prepare('SELECT id, account_id FROM devices WHERE endpoint = ?').get(endpoint)
    if (existing && existing.account_id !== accountId) return { conflict: true }
    if (existing) {
      db.prepare('UPDATE devices SET name = ?, device_group = ?, p256dh = ?, auth = ? WHERE id = ? AND account_id = ?')
        .run(name, group, keys.p256dh, keys.auth, existing.id, accountId)
    } else {
      if (deviceCount(accountId) >= config.maxDevices) return {}
      db.prepare('INSERT INTO devices (id, endpoint, p256dh, auth, name, device_group, created, account_id) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), endpoint, keys.p256dh, keys.auth, name, group, Date.now(), accountId)
    }
    const { id } = db.prepare('SELECT id FROM devices WHERE endpoint = ?').get(endpoint)
    db.exec('COMMIT')
    return { id }
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK')
  }
}

export function updateDevice(id, name, group, accountId) {
  return db.prepare('UPDATE devices SET name = ?, device_group = ? WHERE id = ? AND account_id = ?')
    .run(name, group, id, accountId).changes > 0
}

export function deleteDevice(id, accountId, endpoint = null) {
  return db.prepare('DELETE FROM devices WHERE id = ? AND account_id = ? AND (? IS NULL OR endpoint = ?)')
    .run(id, accountId, endpoint, endpoint).changes > 0
}

export function targets(deviceId, group, accountId) {
  return db.prepare("SELECT * FROM devices WHERE account_id = ? AND (? = '' OR id = ?) AND (? = '' OR device_group = ?)")
    .all(accountId, deviceId, deviceId, group, group)
}

export function pruneHistory() {
  db.prepare('DELETE FROM history WHERE created < ?').run(Date.now() - config.historyDays * day)
}

export function recentHistory(accountId) {
  pruneHistory()
  return db.prepare('SELECT * FROM history WHERE account_id = ? ORDER BY created DESC, rowid DESC LIMIT 100').all(accountId)
}

export function historyExists(id) {
  return Boolean(db.prepare('SELECT 1 FROM history WHERE id = ?').get(id))
}

export function startHistory(id, { title, message, url }, target, accountId) {
  db.prepare("INSERT INTO history (id, title, message, url, target, created, status, account_id) " +
    "VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
    .run(id, title, message, url, target, Date.now(), accountId)
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
