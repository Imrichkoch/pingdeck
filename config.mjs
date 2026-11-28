import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const local = process.env.PUBLIC_ORIGIN ?? 'http://localhost:3417'
const origin = new URL(local)
if (origin.href !== origin.origin + '/' ||
    (origin.protocol !== 'https:' &&
     !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) {
  throw new Error('PUBLIC_ORIGIN musí byť HTTPS origin alebo http://localhost pre lokálny vývoj.')
}

const base = process.env.BASE_PATH ?? ''
if (!/^(?:\/[a-zA-Z0-9_-]+)*$/.test(base)) {
  throw new Error('BASE_PATH musí byť prázdna alebo v tvare /pingdeck bez koncového /.')
}

function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} musí byť celé číslo od ${min} do ${max}.`)
  }
  return value
}

const brand = JSON.parse(readFileSync(new URL('./branding.json', import.meta.url), 'utf8'))
for (const [key, limit] of Object.entries({ name: 32, description: 180, defaultTitle: 100 })) {
  if (typeof brand[key] !== 'string' || !brand[key].trim() || brand[key].length > limit) {
    throw new Error(`Neplatná hodnota branding.json → ${key}.`)
  }
}

const mailHost = process.env.MAIL_IMAP_HOST ?? ''
const mailAddress = process.env.MAIL_IMAP_ADDRESS ?? ''
const mailPassword = process.env.MAIL_IMAP_PASSWORD ?? ''
const mail = mailHost ? {
  host: mailHost,
  address: mailAddress,
  password: mailPassword,
  port: integer('MAIL_IMAP_PORT', 993, 1, 65535),
  interval: integer('MAIL_POLL_SECONDS', 15, 5, 300) * 1_000
} : null
if (mail && (!mailPassword || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailAddress))) {
  throw new Error('Pre Mailu nastav MAIL_IMAP_ADDRESS a MAIL_IMAP_PASSWORD.')
}

const pairMailHost = process.env.PAIR_SMTP_HOST ?? ''
const pairMail = pairMailHost ? {
  host: pairMailHost,
  port: integer('PAIR_SMTP_PORT', 465, 1, 65535),
  address: process.env.PAIR_SMTP_ADDRESS ?? '',
  password: process.env.PAIR_SMTP_PASSWORD ?? ''
} : null
if (pairMail && (!pairMail.password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pairMail.address) ||
                 pairMail.address.toLowerCase() === mail?.address.toLowerCase())) {
  throw new Error('PAIR_SMTP vyžaduje vlastnú odosielaciu schránku a heslo.')
}

export const config = Object.freeze({
  brand,
  origin: origin.origin,
  base,
  port: integer('PORT', 3417, 1, 65535),
  host: process.env.HOST ?? '127.0.0.1',
  trustProxy: process.env.TRUST_PROXY === '1',
  secure: origin.protocol === 'https:',
  dataDir: resolve(process.env.DATA_DIR ?? './data'),
  historyDays: integer('HISTORY_DAYS', 30, 1, 365),
  maxDevices: integer('MAX_DEVICES', 25, 1, 50),
  sendsPerMinute: integer('SENDS_PER_MINUTE', 30, 1, 120),
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
  mail,
  pairMail,
  registrationEnabled: process.env.REGISTRATION_ENABLED === '1' && Boolean(pairMail),
  androidApk: process.env.ANDROID_APK ? resolve(process.env.ANDROID_APK) : '',
  sourceArchive: process.env.SOURCE_ARCHIVE ? resolve(process.env.SOURCE_ARCHIVE) : ''
})
