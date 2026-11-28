import express from 'express'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config } from './config.mjs'
import { acceptLanguage, translate } from './public/locale.js'
import { emailRegistration, emailPairing, pairingImage, pairingLink } from './pairing-mail.mjs'
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
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'self'; img-src 'self' data:",
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
    panelButton: config.registrationEnabled ? 'button-outline' : 'button-primary',
    registrationLink: config.registrationEnabled
      ? '<a class="button button-primary" href="' + base + '/app#registracia">' + t('Vytvoriť účet ↗') + '</a>' : '',
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
pages.get('/android/pair', (req, res) => page('android-pair.html', res))
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

function requireAccount(req, res, next) {
  req.accountId = store.sessionAccount(session(req))
  const expected = req.get('x-pingdeck-account')
  if (!req.accountId || (expected && expected !== req.accountId)) {
    throw new InputError('Prihlás sa do panelu.', 401)
  }
  next()
}

function sameOrigin(req, res, next) {
  if (req.get('origin') !== config.origin) {
    throw new InputError('Požiadavka musí prísť z panelu tejto inštancie.', 403)
  }
  next()
}

api.get('/session', (req, res) => {
  const accountId = store.sessionAccount(session(req))
  res.json({
    authenticated: Boolean(accountId),
    accountId: accountId || undefined,
    needsSetup: !store.setting('password'),
    registrationEnabled: config.registrationEnabled
  })
})

function signIn(req, res, accountId) {
  store.deleteSession(session(req))
  res.cookie(cookie, store.createSession(accountId), { ...cookieOptions, maxAge: store.sessionAge })
  res.json({ ok: true, accountId })
}

function emailAddress(value) {
  if (typeof value !== 'string') return ''
  const email = value.trim().toLowerCase()
  const local = email.split('@')[0]
  if (email.length > 254 || local.length > 64 || local.startsWith('.') || local.endsWith('.') ||
      local.includes('..') || !/^[a-z\d._%+-]+@[a-z\d]+(?:[.-][a-z\d]+)*\.[a-z]{2,63}$/.test(email) ||
      email === config.mail?.address.toLowerCase()) return ''
  return email
}

const badActivation = 'Dočasné heslo je neplatné, použité alebo vypršalo.'

api.post('/register', sameOrigin, (req, res) => {
  if (!config.registrationEnabled) throw new InputError('Registrácia momentálne nie je dostupná.', 503)
  throttle('register:' + req.ip, 6, 60 * minute)
  throttle('register-global', 40, 60 * minute)
  const email = emailAddress(body(req).email)
  if (!email) throw new InputError('Zadaj platnú e-mailovú adresu.')
  const password = store.issueRegistration(email)
  if (password) {
    void emailRegistration({ to: email, password, language: languageFor(req) }).catch(error => {
      store.cancelRegistration(email, password)
      console.warn('Registration email failed:', error.code ?? error.name)
    })
  }
  res.status(202).json({ ok: true })
})

api.post('/activate', sameOrigin, async (req, res) => {
  throttle('activate:' + req.ip, 12, 15 * minute)
  const data = body(req)
  const email = emailAddress(data.email)
  const temporary = typeof data.temporaryPassword === 'string' ? data.temporaryPassword.trim() : ''
  if (!email || !/^[\w-]{43}$/.test(temporary) || !store.validRegistration(email, temporary)) {
    throw new InputError(badActivation, 401)
  }
  const password = data.password
  if (typeof password !== 'string' || password.length < 15 || password.length > 128 || !password.trim()) {
    throw new InputError('Heslo musí mať 15 až 128 znakov.')
  }
  if (password === temporary) throw new InputError('Zvoľ si iné heslo, než je dočasné heslo.')
  const accountId = store.finishRegistration(email, temporary, await store.accountPasswordHash(password))
  if (!accountId) throw new InputError(badActivation, 401)
  signIn(req, res.status(201), accountId)
})

api.post('/setup', sameOrigin, async (req, res) => {
  const { code: input, password } = body(req)
  const code = typeof input === 'string' ? input.trim() : ''
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
  signIn(req, res.status(201), store.ownerId)
})

api.post('/login', sameOrigin, async (req, res) => {
  const { email, password } = body(req)
  const ownerLogin = email === undefined
  const limit = (ownerLogin ? 'owner-auth:' : 'auth:') + req.ip
  throttle(limit, 10, 15 * minute)
  const badLogin = ownerLogin ? 'Heslo je nesprávne.' : 'E-mail alebo heslo je nesprávne.'
  if (typeof password !== 'string' || !password || password.length > 128) throw new InputError(badLogin, 401)
  const accountId = ownerLogin
    ? (await store.validPassword(password) ? store.ownerId : undefined)
    : await store.loginAccount(emailAddress(email), password)
  if (!accountId) throw new InputError(badLogin, 401)
  limits.delete(limit)
  signIn(req, res, accountId)
})

api.post('/logout', sameOrigin, (req, res) => {
  store.deleteSession(session(req))
  res.clearCookie(cookie, cookieOptions).status(204).end()
})

api.get('/overview', requireAccount, (req, res) => res.json({
  devices: [...store.devices(req.accountId), ...mobile.mobileDevices(req.accountId)].sort((a, b) => b.created - a.created),
  emailAddress: req.accountId === store.ownerId ? (config.mail?.address ?? '') : '',
  accountEmail: store.accountEmail(req.accountId),
  androidAvailable: Boolean(apk),
  pairingEmailAvailable: Boolean(config.pairMail),
  keys: store.apiKeys(req.accountId),
  history: store.recentHistory(req.accountId),
  vapidPublicKey
}))

api.post('/devices', sameOrigin, requireAccount, (req, res) => {
  const data = body(req)
  const { id, conflict } = store.saveDevice(text(data.name, 'názov', 48, true), text(data.group, 'skupina', 48),
    pushSubscription(data.subscription), req.accountId)
  if (conflict) throw new InputError('Prehliadač je spojený s iným účtom. Odpoj ho v pôvodnom účte alebo použi iný profil prehliadača.', 409)
  if (!id) throw new InputError('Dosiahol sa limit zariadení.', 409)
  res.status(201).json({ id })
})

api.patch('/devices/:id', sameOrigin, requireAccount, (req, res) => {
  const data = body(req)
  const name = text(data.name, 'názov', 48, true)
  const group = text(data.group, 'skupina', 48)
  if (!store.updateDevice(req.params.id, name, group, req.accountId) &&
      !mobile.renameMobile(req.params.id, name, group, req.accountId)) {
    throw new InputError('Zariadenie sa nenašlo.', 404)
  }
  res.status(204).end()
})

api.delete('/devices/:id', sameOrigin, requireAccount, (req, res) => {
  if (!store.deleteDevice(req.params.id, req.accountId) && !mobile.removeMobile(req.params.id, req.accountId)) throw new InputError('Zariadenie sa nenašlo.', 404)
  res.status(204).end()
})

api.post('/keys', sameOrigin, requireAccount, (req, res) => {
  const data = body(req)
  if (store.apiKeys(req.accountId).length >= 30) throw new InputError('Dosiahol sa limit 30 kľúčov.', 409)
  res.status(201).json({ token: store.createApiKey(text(data.label, 'názov', 48, true), req.accountId) })
})

api.delete('/keys/:id', sameOrigin, requireAccount, (req, res) => {
  if (!store.deleteApiKey(req.params.id, req.accountId)) throw new InputError('Kľúč sa nenašiel.', 404)
  res.status(204).end()
})

api.post('/mobile/codes', sameOrigin, requireAccount, async (req, res) => {
  const data = body(req)
  const result = mobile.createPairCode(text(data.name, 'názov', 48, true), text(data.group, 'skupina', 48), req.accountId)
  if (!result) throw new InputError('Je vytvorených príliš veľa platných kódov.', 429)
  const png = await pairingImage(result.code)
  res.status(201).json({ ...result, link: pairingLink(result.code), qr: 'data:image/png;base64,' + png.toString('base64') })
})

api.post('/mobile/codes/email', sameOrigin, requireAccount, async (req, res) => {
  if (!config.pairMail) throw new InputError('Odosielanie párovacích e-mailov nie je nastavené.', 503)
  const { code, email } = body(req)
  const recipient = emailAddress(email)
  if (!recipient) throw new InputError('Zadaj platnú e-mailovú adresu príjemcu.')
  if (req.accountId !== store.ownerId && recipient !== store.accountEmail(req.accountId)) {
    throw new InputError('Párovací e-mail môžeš poslať na adresu svojho účtu.', 403)
  }
  if (typeof code !== 'string' || !/^[\w-]{22}$/.test(code) || mobile.pairStatus(code, req.accountId).state !== 'waiting') {
    throw new InputError('Párovací kód už nie je platný. Vytvor nový.', 409)
  }
  throttle('pair-email', 5)
  throttle('pair-email:' + store.hash(code), 3, 10 * minute)
  try {
    await emailPairing({ to: recipient, code, language: languageFor(req) })
  } catch (error) {
    console.warn('Pairing email failed:', error.code ?? error.name)
    throw new InputError('Párovací e-mail sa nepodarilo odoslať. Skús znova.', 502)
  }
  res.status(204).end()
})

api.post('/mobile/codes/status', sameOrigin, requireAccount, (req, res) => {
  const { code } = body(req)
  if (typeof code !== 'string' || !/^[\w-]{22}$/.test(code)) {
    throw new InputError('Neplatný alebo použitý párovací kód.')
  }
  res.json(mobile.pairStatus(code, req.accountId))
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
  const device = value && mobile.authenticateMobile(value)
  if (!device) throw new InputError('Telefón treba znova spárovať.', 401)
  req.mobileId = device.id
  req.accountId = device.accountId
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
  mobile.removeMobile(req.mobileId, req.accountId)
  res.status(204).end()
})

let inFlight = 0
async function limitedSend(data, options = {}) {
  throttle('send:' + (options.accountId ?? store.ownerId), config.sendsPerMinute)
  if (inFlight >= 4) throw new InputError('Prebieha už viacero odoslaní. Skús to o chvíľu.', 429)
  inFlight++
  try {
    return await sendPush(data, options)
  } finally {
    inFlight--
  }
}

async function dispatch(req, res) {
  const result = await limitedSend(body(req), { accountId: req.accountId })
  if (req.apiKeyId) store.markApiKeyUsed(req.apiKeyId)
  res.status(result.accepted ? 202 : 502).json(result)
}

api.post('/devices/:id/test', sameOrigin, requireAccount, async (req, res) => {
  const language = languageFor(req)
  const result = await limitedSend({
    deviceId: req.params.id,
    title: translate(language, 'Testovacia správa z PingDecku'),
    message: translate(language, 'Ak vidíš túto správu, upozornenia fungujú.'),
    ttl: 300
  }, { accountId: req.accountId })
  res.status(result.accepted ? 202 : 502).json(result)
})

api.post('/send', sameOrigin, requireAccount, (req, res, next) => {
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
  const key = raw && store.verifyApiKey(raw)
  if (!key) {
    res.set('WWW-Authenticate', 'Bearer realm="PingDeck"')
    throw new InputError('Je potrebný platný API kľúč typu Bearer.', 401)
  }
  req.apiKeyId = key.id
  req.accountId = key.accountId
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
  if (status === 429) {
    const retry = req.path === '/register' ? '3600' : ['/login', '/setup', '/activate'].includes(req.path) ? '900' : '60'
    res.set('Retry-After', retry)
  }
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
