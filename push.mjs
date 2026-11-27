import { randomUUID } from 'node:crypto'
import webPush from 'web-push'
import { config } from './config.mjs'
import { enqueueMobile, nativeTargets } from './mobile-store.mjs'
import { deleteDevice, finishHistory, startHistory, targets, vapidKeys } from './store.mjs'

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export function text(value, name, limit, required = false) {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new InputError(`Pole „${name}“ má byť text s maximálne ${limit} znakmi${required ? ' a nesmie byť prázdne' : ''}.`)
  }
  return value.trim()
}

const providers = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
  'notify.live.net'
]

export function pushSubscription(value) {
  const endpoint = text(value?.endpoint, 'endpoint', 2048, true)
  let uri
  try {
    uri = new URL(endpoint)
  } catch {
    throw new InputError('Neplatná adresa služby Web Push.')
  }
  const trustedHost = providers.some(host => uri.hostname === host || uri.hostname.endsWith('.' + host))
  if (!trustedHost || uri.protocol !== 'https:' || uri.username || uri.password || uri.port || uri.hash) {
    throw new InputError('Tento poskytovateľ Web Push nie je podporovaný.')
  }
  const p256dh = value?.keys?.p256dh
  const auth = value?.keys?.auth
  if (typeof p256dh !== 'string' || !/^[\w-]{87}$/.test(p256dh) ||
      Buffer.from(p256dh, 'base64url')[0] !== 4 ||
      typeof auth !== 'string' || !/^[\w-]{22}$/.test(auth)) {
    throw new InputError('Neplatné kľúče odberu Web Push.')
  }
  return { endpoint: uri.href, keys: { p256dh, auth } }
}

function clickUrl(value) {
  const url = text(value, 'odkaz', 1500)
  if (!url) return ''
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new InputError('Zadaj úplný odkaz začínajúci http:// alebo https://.')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new InputError('Odkaz musí byť adresa HTTP alebo HTTPS bez prihlasovacích údajov.')
  }
  return parsed.href
}

const vapidDetails = { subject: config.vapidSubject, ...vapidKeys() }
export const vapidPublicKey = vapidDetails.publicKey

export async function sendPush(body, { id = randomUUID() } = {}) {
  const title = text(body.title, 'nadpis', 100) || config.brand.defaultTitle
  const message = text(body.message, 'správa', 600, true)
  const url = clickUrl(body.url)
  const deviceId = text(body.deviceId, 'zariadenie', 64)
  const group = text(body.group, 'skupina', 48)
  const ttl = body.ttl ?? 3600
  const urgency = body.urgency ?? 'normal'
  if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > 604800) {
    throw new InputError('TTL musí byť celé číslo od 0 do 604 800 sekúnd.')
  }
  if (!['very-low', 'low', 'normal', 'high'].includes(urgency)) {
    throw new InputError('Neplatná priorita.')
  }
  if (deviceId && group) throw new InputError('Vyber jedno zariadenie alebo jednu skupinu.')
  const payload = JSON.stringify({ id, title, message, url })
  if (Buffer.byteLength(payload) > 3500) throw new InputError('Správa a odkaz sú spolu príliš dlhé.')
  const list = targets(deviceId, group)
  const mobile = nativeTargets(deviceId, group)
  const recipient = list[0] || mobile[0]
  if (!recipient) throw new InputError('Pre tento výber nie je pripojené žiadne zariadenie.', 422)
  startHistory(id, { title, message, url }, group || (deviceId ? recipient.name : 'Všetky zariadenia'))

  const queued = mobile.map(device => {
    const accepted = enqueueMobile(device.id, { id, title, message, url, urgency, ttl })
    return { deviceId: device.id, result: accepted ? 'queued' : 'failed' }
  })
  const results = await Promise.allSettled(list.map(async device => {
    try {
      await webPush.sendNotification({
        endpoint: device.endpoint,
        keys: { p256dh: device.p256dh, auth: device.auth }
      }, payload, { vapidDetails, TTL: ttl, urgency, timeout: 8000 })
      return { deviceId: device.id, result: 'accepted' }
    } catch (error) {
      const expired = [404, 410].includes(error.statusCode)
      if (expired) deleteDevice(device.id, device.endpoint)
      return { deviceId: device.id, result: expired ? 'expired' : 'failed', statusCode: error.statusCode }
    }
  }))
  const deliveries = results.map((outcome, index) => outcome.status === 'fulfilled'
    ? outcome.value : { deviceId: list[index].id, result: 'failed' }).concat(queued)
  const accepted = deliveries.filter(item => item.result === 'accepted' || item.result === 'queued').length
  const failed = deliveries.length - accepted
  const status = failed === 0 ? 'accepted' : accepted > 0 ? 'partial' : 'failed'
  finishHistory(id, { accepted, failed, status })
  return { id, status, accepted, failed, deliveries }
}
