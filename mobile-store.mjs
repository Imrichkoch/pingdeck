import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { config } from './config.mjs'
import { db, hash, token, deviceCount } from './store.mjs'

const events = new EventEmitter()
events.setMaxListeners(config.maxDevices * 2 + 1)
const activePolls = new Set()
const pairAge = 10 * 60_000
const queueSize = 100

export function mobileDevices() {
  return db.prepare("SELECT id, name, device_group AS 'group', created, 'android' AS platform FROM mobile_devices").all()
}

export function createPairCode(name, group) {
  const code = randomBytes(16).toString('base64url')
  const expires = Date.now() + pairAge
  const now = Date.now()
  db.prepare('DELETE FROM mobile_pair_codes WHERE expires <= ?').run(now)
  db.prepare('DELETE FROM mobile_pair_receipts WHERE expires <= ?').run(now)
  if (db.prepare('SELECT count(*) AS total FROM mobile_pair_codes').get().total >= 30) return null
  db.prepare('INSERT INTO mobile_pair_codes (hash, name, device_group, expires) VALUES (?, ?, ?, ?)').run(hash(code), name, group, expires)
  return { code, expires }
}

export function pairStatus(code) {
  const tokenHash = hash(code)
  const now = Date.now()
  const linked = db.prepare('SELECT device_id FROM mobile_pair_receipts WHERE hash = ? AND expires > ?')
    .get(tokenHash, now)
  if (linked && mobileExists(linked.device_id)) return { state: 'linked', id: linked.device_id }

  const waiting = db.prepare('SELECT 1 FROM mobile_pair_codes WHERE hash = ? AND expires > ?')
    .get(tokenHash, now)
  return { state: waiting ? 'waiting' : 'expired' }
}

export function pairMobile(code) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const info = db.prepare('SELECT * FROM mobile_pair_codes WHERE hash = ? AND expires > ?')
      .get(hash(code), Date.now())
    if (!info) return null
    if (deviceCount() >= config.maxDevices) return { limit: true }

    const id = randomUUID()
    const secret = 'pdr_' + token()
    db.prepare('INSERT INTO mobile_devices VALUES (?, ?, ?, ?, ?)')
      .run(id, hash(secret), info.name, info.device_group, Date.now())
    db.prepare('INSERT INTO mobile_pair_receipts VALUES (?, ?, ?)').run(info.hash, id, info.expires)
    db.prepare('DELETE FROM mobile_pair_codes WHERE hash = ?').run(info.hash)
    db.exec('COMMIT')
    return { id, token: secret, name: info.name }
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK')
  }
}

export function nativeTargets(deviceId, group) {
  return db.prepare("SELECT id, name FROM mobile_devices WHERE (? = '' OR id = ?) AND (? = '' OR device_group = ?)")
    .all(deviceId, deviceId, group, group)
}

export function authenticateMobile(secret) {
  return db.prepare('SELECT id FROM mobile_devices WHERE hash = ?').get(hash(secret))?.id
}

export function mobileExists(id) {
  return Boolean(db.prepare('SELECT 1 FROM mobile_devices WHERE id = ?').get(id))
}

export function renameMobile(id, name, group) {
  return db.prepare('UPDATE mobile_devices SET name = ?, device_group = ? WHERE id = ?').run(name, group, id).changes > 0
}

export function removeMobile(id) {
  const removed = db.prepare('DELETE FROM mobile_devices WHERE id = ?').run(id).changes > 0
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
