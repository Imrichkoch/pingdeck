import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { config } from './config.mjs'
import { db, hash, token, deviceCount } from './store.mjs'

const events = new EventEmitter()
events.setMaxListeners(config.maxDevices * 2 + 1)
const activePolls = new Set()
const pairAge = 10 * 60_000
const queueSize = 100

export function mobileDevices(accountId) {
  return db.prepare("SELECT id, name, device_group AS 'group', created, 'android' AS platform FROM mobile_devices WHERE account_id = ?").all(accountId)
}

export function createPairCode(name, group, accountId) {
  const code = randomBytes(16).toString('base64url')
  const expires = Date.now() + pairAge
  const now = Date.now()
  db.prepare('DELETE FROM mobile_pair_codes WHERE expires <= ?').run(now)
  db.prepare('DELETE FROM mobile_pair_receipts WHERE expires <= ?').run(now)
  if (db.prepare('SELECT count(*) AS total FROM mobile_pair_codes WHERE account_id = ?').get(accountId).total >= 30) return null
  db.prepare('INSERT INTO mobile_pair_codes (hash, name, device_group, expires, account_id) VALUES (?, ?, ?, ?, ?)')
    .run(hash(code), name, group, expires, accountId)
  return { code, expires }
}

export function pairStatus(code, accountId) {
  const tokenHash = hash(code)
  const now = Date.now()
  const linked = db.prepare('SELECT device_id FROM mobile_pair_receipts WHERE hash = ? AND expires > ? AND account_id = ?')
    .get(tokenHash, now, accountId)
  if (linked && mobileExists(linked.device_id)) return { state: 'linked', id: linked.device_id }

  const waiting = db.prepare('SELECT 1 FROM mobile_pair_codes WHERE hash = ? AND expires > ? AND account_id = ?')
    .get(tokenHash, now, accountId)
  return { state: waiting ? 'waiting' : 'expired' }
}

export function pairMobile(code) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const info = db.prepare('SELECT * FROM mobile_pair_codes WHERE hash = ? AND expires > ?')
      .get(hash(code), Date.now())
    if (!info) return null
    if (deviceCount(info.account_id) >= config.maxDevices) return { limit: true }

    const id = randomUUID()
    const secret = 'pdr_' + token()
    db.prepare('INSERT INTO mobile_devices (id, hash, name, device_group, created, account_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, hash(secret), info.name, info.device_group, Date.now(), info.account_id)
    db.prepare('INSERT INTO mobile_pair_receipts (hash, device_id, expires, account_id) VALUES (?, ?, ?, ?)')
      .run(info.hash, id, info.expires, info.account_id)
    db.prepare('DELETE FROM mobile_pair_codes WHERE hash = ?').run(info.hash)
    db.exec('COMMIT')
    return { id, token: secret, name: info.name }
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK')
  }
}

export function nativeTargets(deviceId, group, accountId) {
  return db.prepare("SELECT id, name FROM mobile_devices WHERE account_id = ? AND (? = '' OR id = ?) AND (? = '' OR device_group = ?)")
    .all(accountId, deviceId, deviceId, group, group)
}

export function authenticateMobile(secret) {
  return db.prepare('SELECT id, account_id AS accountId FROM mobile_devices WHERE hash = ?').get(hash(secret))
}

export function mobileExists(id) {
  return Boolean(db.prepare('SELECT 1 FROM mobile_devices WHERE id = ?').get(id))
}

export function renameMobile(id, name, group, accountId) {
  return db.prepare('UPDATE mobile_devices SET name = ?, device_group = ? WHERE id = ? AND account_id = ?')
    .run(name, group, id, accountId).changes > 0
}

export function removeMobile(id, accountId) {
  const removed = db.prepare('DELETE FROM mobile_devices WHERE id = ? AND account_id = ?').run(id, accountId).changes > 0
  if (removed) events.emit(id)
  return removed
}

export function pruneMobileQueue() {
  db.prepare('DELETE FROM mobile_queue WHERE expires <= ?').run(Date.now())
}

export function enqueueMobile(deviceId, { id, title, message, url, urgency, ttl }) {
  if (!ttl && !activePolls.has(deviceId)) return false
  const now = Date.now()
  const expires = now + (ttl === 0 ? 2_000 : ttl * 1_000)
  const result = db.prepare(
    'INSERT OR IGNORE INTO mobile_queue VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(deviceId, id, title, message, url, urgency, now, expires)
  db.prepare(`
    DELETE FROM mobile_queue WHERE device_id = ? AND id IN (
      SELECT id FROM mobile_queue WHERE device_id = ?
      ORDER BY created DESC, rowid DESC LIMIT -1 OFFSET ?
    )
  `).run(deviceId, deviceId, queueSize)
  events.emit(deviceId)
  return result.changes > 0
}

function queued(deviceId) {
  return db.prepare(
    'SELECT id, title, message, url, urgency, created FROM mobile_queue WHERE device_id = ? AND expires > ? ORDER BY created, rowid LIMIT 30'
  ).all(deviceId, Date.now())
}

export async function pollMobile(deviceId, signal) {
  const existing = queued(deviceId)
  if (existing.length) return existing
  if (activePolls.has(deviceId)) return null
  activePolls.add(deviceId)
  try {
    await once(events, deviceId, { signal: AbortSignal.any([signal, AbortSignal.timeout(18_000)]) })
  } catch (error) {
    if (error.name !== 'AbortError') throw error
  } finally {
    activePolls.delete(deviceId)
  }
  return queued(deviceId)
}

export function ackMobile(deviceId, ids) {
  const remove = db.prepare('DELETE FROM mobile_queue WHERE device_id = ? AND id = ?')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const id of ids) remove.run(deviceId, id)
    db.exec('COMMIT')
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK')
  }
}
