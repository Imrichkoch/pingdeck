import express from 'express'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config } from './config.mjs'
import { acceptLanguage, translate } from './public/locale.js'
import * as store from './store.mjs'
import * as mobile from './mobile-store.mjs'
import { startMailGateway, stopMailGateway } from './mail.mjs'
import { InputError, pushSubscription, sendPush, text, vapidPublicKey } from './push.mjs'

const app = express()
const pages = express.Router()
const api = express.Router()
const root = fileURLToPath(new URL('./public/', import.meta.url))
const views = fileURLToPath(new URL('./views/', import.meta.url))
const { base, brand } = config
const cookie = 'pingdeck_session'
const cookieOptions = { path: base + '/', httpOnly: true, secure: config.secure, sameSite: 'strict' }
const src = config.sourceArchive && existsSync(config.sourceArchive)
const apk = config.androidApk && existsSync(config.androidApk)

app.disable('x-powered-by')
if (config.trustProxy) app.set('trust proxy', 1)
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  })
  next()
})
if (base) app.get(base, (req, res, next) => req.path === base ? res.redirect(308, base + '/') : next())
app.use(base || '/', pages)

const html = value => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char])

function languageFor(req) {
  const selected = (req.get('cookie') ?? '').match(/(?:^|;\s*)pingdeck_language=(en|sk)(?:;|$)/)?.[1]
  return selected ?? acceptLanguage(req.get('accept-language'))
}

function localizedResponse(res, language) {
  res.set('Content-Language', language)
  res.vary('Accept-Language').vary('Cookie')
}

function page(file, res) {
  const req = res.req
  const canonical = new URL(config.origin)
  if (config.secure && req.get('host')?.toLowerCase() !== canonical.host) {
    return res.redirect(308, canonical.origin + base + req.path + new URL(req.originalUrl, canonical).search)
  }
  const selected = req.query.lang
  const language = ['sk', 'en'].includes(selected) ? selected : languageFor(req)
  if (language === selected) {
    res.cookie('pingdeck_language', language, { ...cookieOptions, maxAge: 365 * 86400000 })
  }
  localizedResponse(res, language)
  res.set('Cache-Control', 'no-store')
  const t = value => html(translate(language, value))
  const languageName = t('Jazyk')
  const languageSwitch = '<nav class="language-switch" aria-label="' + languageName + '">' +
    ['sk', 'en'].map((value, index) => '<a data-language="' + value + '" href="?lang=' + value +
      '" lang="' + value + '" hreflang="' + value + '"' + (language === value ? ' aria-current="true"' : '') +
      ' aria-label="' + ['Slovenčina', 'English'][index] + '">' + value.toUpperCase() + '</a>').join('') + '</nav>'
  const template = readFileSync(views + file, 'utf8')
  const values = {
    name: html(brand.name),
    description: t(brand.description),
    lang: language,
    languageSwitch,
    defaultTitle: html(brand.defaultTitle),
    base,
    endpoint: html(config.origin + base + '/api/v1/push'),
    androidLink: apk ? '<a class="button button-outline" href="' + base + '/android">Android ↓</a>' : '',
    sourceLink: src ? `<a class="button button-outline" href="${base}/source.zip">${t('Stiahnuť kód ↓')}</a>` : ''
  }
  res.type('html').send(template.replace(/\{\{(\w+|t:[^{}]+)\}\}/g,
    (_, key) => key.startsWith('t:') ? t(key.slice(2)) : values[key]))
}

pages.get('/', (req, res) => page('landing.html', res))
pages.get('/app', (req, res) => {
  res.set('Cache-Control', 'no-store')
  page('app.html', res)
})
pages.get('/iphone-app', (req, res) => page('iphone-app.html', res))
pages.get(['/manifest.webmanifest', '/iphone.webmanifest'], (req, res) => {
  const iphone = req.path === '/iphone.webmanifest'
  const language = languageFor(req)
  localizedResponse(res, language)
  res.set('Cache-Control', 'private, no-cache')
  res.type('application/manifest+json').send({
    id: base + (iphone ? '/iphone-app' : '/'),
    name: brand.name,
    short_name: brand.name,
    description: translate(language, brand.description),
    lang: language,
    start_url: base + (iphone ? '/iphone-app' : '/app'),
    scope: base + '/',
    display: 'standalone',
    background_color: '#f5f2ea',
    theme_color: '#f5f2ea',
    icons: [192, 512].map(size => ({
      src: `./icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable'
    }))
  })
})
pages.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache')
  res.type('js').sendFile(root + 'sw.js')
})
if (src) {
  pages.get('/source.zip', (req, res) => res.download(config.sourceArchive, 'pingdeck-source.zip'))
}
pages.get('/iphone', (req, res) => page('iphone.html', res))
if (apk) {
  pages.get('/android', (req, res) => page('android.html', res))
  pages.get('/pingdeck.apk', (req, res) => res.download(config.androidApk, 'pingdeck.apk', {
    headers: { 'Content-Type': 'application/vnd.android.package-archive', 'Cache-Control': 'no-cache' }
  }))
}
pages.use('/fonts/bricolage', express.static(fileURLToPath(new URL(
  './node_modules/@fontsource-variable/bricolage-grotesque/files/', import.meta.url))))
pages.use('/fonts/plex', express.static(fileURLToPath(new URL(
  './node_modules/@fontsource/ibm-plex-mono/files/', import.meta.url))))
pages.use(express.static(root, { index: false }))
pages.use('/api', api)

const minute = 60_000
const limits = new Map()
function throttle(key, max, duration = minute) {
  const now = Date.now()
  const entry = limits.get(key)
  if (!entry || entry.expires <= now) {
    limits.set(key, { count: 1, expires: now + duration })
    return
  }
  if (++entry.count > max) {
    throw new InputError('Príliš veľa požiadaviek. Skús to o chvíľu.', 429)
  }
}
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of limits) if (entry.expires <= now) limits.delete(key)
}, minute).unref()

api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})
api.use(express.json({ limit: '16kb' }))
api.get('/health', (req, res) => res.json({ status: 'ok' }))

function body(req) {
  if (!req.is('application/json') || !req.body || Array.isArray(req.body) || typeof req.body !== 'object') {
    throw new InputError('Pošli objekt JSON s Content-Type: application/json.', 415)
  }
  return req.body
}

function session(req) {
  const entry = (req.get('cookie') ?? '').split(';').map(item => item.trim())
    .find(item => item.startsWith(cookie + '='))
  const value = entry?.slice(cookie.length + 1)
  return /^[\w-]{43}$/.test(value ?? '') ? value : ''
}

function requireOwner(req, res, next) {
  if (!store.activeSession(session(req))) throw new InputError('Prihlás sa do panelu.', 401)
  next()
}

function sameOrigin(req, res, next) {
  if (req.get('origin') !== config.origin) {
    throw new InputError('Požiadavka musí prísť z panelu tejto inštancie.', 403)
  }
  next()
}

api.get('/session', (req, res) => res.json({
  authenticated: store.activeSession(session(req)),
  needsSetup: !store.setting('password')
}))

api.post('/setup', sameOrigin, async (req, res) => {
  const { code, password } = body(req)
  throttle('auth:' + req.ip, 10, 15 * minute)
  if (typeof code !== 'string' || !/^[\w-]{43}$/.test(code) || !store.validSetup(code)) {
    throw new InputError('Neplatný alebo použitý inštalačný kód.', 401)
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 128 || !password.trim()) {
    throw new InputError('Heslo musí mať 12 až 128 znakov.')
  }
  if (!store.finishSetup(code, await store.passwordHash(password))) {
    throw new InputError('Tento inštalačný kód už bol použitý.', 409)
  }
  res.cookie(cookie, store.createSession(), { ...cookieOptions, maxAge: store.sessionAge }).status(201).json({ ok: true })
})

api.post('/login', sameOrigin, async (req, res) => {
  const { password } = body(req)
  throttle('auth:' + req.ip, 10, 15 * minute)
  if (typeof password !== 'string' || !password || password.length > 128 || !await store.validPassword(password)) {
    throw new InputError('Heslo je nesprávne.', 401)
  }
  limits.delete('auth:' + req.ip)
  store.deleteSession(session(req))
  res.cookie(cookie, store.createSession(), { ...cookieOptions, maxAge: store.sessionAge }).json({ ok: true })
})

api.post('/logout', sameOrigin, (req, res) => {
  store.deleteSession(session(req))
  res.clearCookie(cookie, cookieOptions).status(204).end()
})

api.get('/overview', requireOwner, (req, res) => res.json({
  devices: [...store.devices(), ...mobile.mobileDevices()].sort((a, b) => b.created - a.created),
  emailAddress: config.mail?.address ?? '',
  androidAvailable: Boolean(apk),
  keys: store.apiKeys(),
  history: store.recentHistory(),
  vapidPublicKey
}))

api.post('/devices', sameOrigin, requireOwner, (req, res) => {
  const data = body(req)
  const id = store.saveDevice(text(data.name, 'názov', 48, true), text(data.group, 'skupina', 48),
    pushSubscription(data.subscription))
  if (!id) throw new InputError('Dosiahol sa limit zariadení tejto inštancie.', 409)
  res.status(201).json({ id })
})

api.patch('/devices/:id', sameOrigin, requireOwner, (req, res) => {
  const data = body(req)
  const name = text(data.name, 'názov', 48, true)
  const group = text(data.group, 'skupina', 48)
  if (!store.updateDevice(req.params.id, name, group) && !mobile.renameMobile(req.params.id, name, group)) {
    throw new InputError('Zariadenie sa nenašlo.', 404)
  }
  res.status(204).end()
})

api.delete('/devices/:id', sameOrigin, requireOwner, (req, res) => {
  if (!store.deleteDevice(req.params.id) && !mobile.removeMobile(req.params.id)) throw new InputError('Zariadenie sa nenašlo.', 404)
  res.status(204).end()
})

api.post('/keys', sameOrigin, requireOwner, (req, res) => {
  const data = body(req)
  if (store.apiKeys().length >= 30) throw new InputError('Dosiahol sa limit 30 kľúčov.', 409)
  res.status(201).json({ token: store.createApiKey(text(data.label, 'názov', 48, true)) })
})

api.delete('/keys/:id', sameOrigin, requireOwner, (req, res) => {
  if (!store.deleteApiKey(req.params.id)) throw new InputError('Kľúč sa nenašiel.', 404)
  res.status(204).end()
})

api.post('/mobile/codes', sameOrigin, requireOwner, (req, res) => {
  const data = body(req)
  const result = mobile.createPairCode(text(data.name, 'názov', 48, true), text(data.group, 'skupina', 48))
  if (!result) throw new InputError('Je vytvorených príliš veľa platných kódov.', 429)
  res.status(201).json(result)
})

api.post('/mobile/codes/status', sameOrigin, requireOwner, (req, res) => {
  const { code } = body(req)
  if (typeof code !== 'string' || !/^[\w-]{22}$/.test(code)) {
    throw new InputError('Neplatný alebo použitý párovací kód.')
  }
  res.json(mobile.pairStatus(code))
})

api.post('/mobile/pair', (req, res) => {
  const { code } = body(req)
  throttle('pair:' + req.ip, 30)
  if (typeof code !== 'string' || !/^[\w-]{22}$/.test(code)) {
    throw new InputError('Neplatný alebo použitý párovací kód.', 401)
  }
  const result = mobile.pairMobile(code)
  if (!result) throw new InputError('Neplatný alebo použitý párovací kód.', 401)
  if (result.limit) throw new InputError('Dosiahol sa limit zariadení.', 409)
  res.status(201).json(result)
})

function requireMobile(req, res, next) {
  const value = req.get('authorization')?.match(/^Bearer (pdr_[\w-]{43})$/i)?.[1]
  req.mobileId = value && mobile.authenticateMobile(value)
  if (!req.mobileId) throw new InputError('Telefón treba znova spárovať.', 401)
  next()
}

api.get('/mobile/messages', requireMobile, async (req, res) => {
  throttle('poll:' + req.mobileId, 90)
  const controller = new AbortController()
  res.once('close', () => controller.abort())
  const messages = await mobile.pollMobile(req.mobileId, controller.signal)
  if (controller.signal.aborted) return
  if (!mobile.mobileExists(req.mobileId)) throw new InputError('Telefón treba znova spárovať.', 401)
  if (!messages) throw new InputError('Prebieha už jedno čakanie na správy.', 429)
  res.json({ messages })
})

api.post('/mobile/ack', requireMobile, (req, res) => {
  const { ids } = body(req)
  if (!Array.isArray(ids) || ids.length > 30 ||
      !ids.every(id => typeof id === 'string' && /^[\w-]{1,70}$/.test(id))) {
    throw new InputError('Neplatný zoznam správ.')
  }
  mobile.ackMobile(req.mobileId, ids)
  res.status(204).end()
})

api.delete('/mobile/device', requireMobile, (req, res) => {
  mobile.removeMobile(req.mobileId)
  res.status(204).end()
})

let inFlight = 0
async function limitedSend(data, options = {}) {
  throttle('send', config.sendsPerMinute)
  if (inFlight >= 4) throw new InputError('Prebieha už viacero odoslaní. Skús to o chvíľu.', 429)
  inFlight++
  try {
    return await sendPush(data, options)
  } finally {
    inFlight--
  }
}

async function dispatch(req, res) {
  const result = await limitedSend(body(req))
  if (req.apiKeyId) store.markApiKeyUsed(req.apiKeyId)
  res.status(result.accepted ? 202 : 502).json(result)
}

api.post('/devices/:id/test', sameOrigin, requireOwner, async (req, res) => {
  const language = languageFor(req)
  const result = await limitedSend({
    deviceId: req.params.id,
    title: translate(language, 'Testovacia správa z PingDecku'),
    message: translate(language, 'Ak vidíš túto správu, upozornenia fungujú.'),
    ttl: 300
  })
  res.status(result.accepted ? 202 : 502).json(result)
})

api.post('/send', sameOrigin, requireOwner, (req, res, next) => {
  const { deviceId, group, broadcast } = body(req)
  const hasTarget = (typeof deviceId === 'string' && Boolean(deviceId.trim())) ||
    (typeof group === 'string' && Boolean(group.trim()))
  if (hasTarget ? broadcast === true : broadcast !== true) {
    throw new InputError('Vyber príjemcu alebo výslovne označ všetky zariadenia.')
  }
  next()
}, dispatch)
api.post('/v1/push', (req, res, next) => {
  const raw = req.get('authorization')?.match(/^Bearer (pd_[\w-]{43})$/i)?.[1]
  req.apiKeyId = raw && store.verifyApiKey(raw)
  if (!req.apiKeyId) {
    res.set('WWW-Authenticate', 'Bearer realm="PingDeck"')
    throw new InputError('Je potrebný platný API kľúč typu Bearer.', 401)
  }
  next()
}, dispatch)
api.use((req, res) => res.status(404).json({ error: 'Rozhranie sa nenašlo.' }))

app.use((req, res) => res.status(404).type('text').send('Táto stránka sa nenašla.'))
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error)
  const status = error instanceof InputError ? error.status
    : error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500
  const message = error instanceof InputError ? error.message
    : status === 413 ? 'Požiadavka je príliš veľká.'
      : status === 400 ? 'Neplatný JSON.' : 'Interná chyba servera.'
  if (status === 500) console.error(error)
  if (status === 429) res.set('Retry-After', req.path === '/login' || req.path === '/setup' ? '900' : '60')
  const language = languageFor(req)
  res.set('Content-Language', language)
  res.status(status).json({ error: translate(language, message) })
})

store.interruptPending()
store.pruneHistory()
setInterval(store.pruneHistory, 60 * minute).unref()
mobile.pruneMobileQueue()
setInterval(mobile.pruneMobileQueue, minute).unref()
startMailGateway(limitedSend)
const server = app.listen(config.port, config.host, () => {
  console.log(`Listening on ${config.host}:${config.port}${base}/`)
})
server.requestTimeout = 25_000
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopMailGateway()
    server.close(() => process.exit(0))
  })
}
