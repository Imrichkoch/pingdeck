import { translate } from './locale.js'

const language = document.documentElement.lang
const t = (source, values) => translate(language, source, values)
const $ = selector => document.querySelector(selector)
const { base, name: brand, defaultTitle } = document.body.dataset
const link = path => base + path
const allDevicesStoredValue = 'Všetky zariadenia'
const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' })
const state = { accountId: '', registrationEnabled: false, needsSetup: false, accountEmail: '', devices: [], keys: [], history: [], vapidPublicKey: '', emailAddress: '', pairingEmailAvailable: false }
const views = [...document.querySelectorAll('[data-view]')]
let reloadVersion = 0
let testDeviceId = ''
let pairing

function clearPairingResult() {
  $('#pair-code').value = ''
  $('#pair-qr-image').removeAttribute('src')
  $('#pair-open').removeAttribute('href')
  $('#pair-result').hidden = true
  $('#pair-email-form').reset()
  $('#pair-email-form input[name="email"]').value = state.accountEmail
  feedback('pair-email-feedback')
}

async function request(path, { method = 'GET', data } = {}) {
  const response = await fetch(link('/api' + path), {
    method,
    headers: {
      'Accept-Language': language,
      ...(data ? { 'Content-Type': 'application/json' } : {}),
      ...(state.accountId ? { 'X-PingDeck-Account': state.accountId } : {})
    },
    body: data ? JSON.stringify(data) : undefined
  })
  if (response.status === 204) return
  const result = await response.json().catch(() => null)
  if (!response.ok && !(response.status === 502 && result?.deliveries)) {
    const error = new Error(result?.error ?? t('Server neodpovedal podľa očakávania.'))
    error.status = response.status
    throw error
  }
  return result
}

function feedback(id, message = '', isError = false) {
  const node = $('#' + id)
  node.textContent = message
  node.classList.toggle('error', isError)
}

function action(button, output, run, checkSession = true) {
  return async () => {
    if (button.disabled) return
    feedback(output)
    button.disabled = true
    try {
      await run()
    } catch (error) {
      if (checkSession && error.status === 401) {
        showEntrance(false)
        feedback('auth-feedback', t('Prihlásenie vypršalo. Prihlás sa znova.'), true)
      } else {
        feedback(output, error.message, true)
      }
    } finally {
      button.disabled = false
    }
  }
}

function onSubmit(id, output, run) {
  const form = $('#' + id)
  form.addEventListener('submit', event => {
    event.preventDefault()
    const data = Object.fromEntries(new FormData(form))
    void action(form.querySelector('[type="submit"]'), output, () => run(data, form), !['auth-form', 'signup-form', 'activate-form'].includes(id))()
  })
}

function showEntrance(needsSetup) {
  ++reloadVersion
  state.needsSetup = needsSetup
  Object.assign(state, { accountId: '', accountEmail: '', devices: [], keys: [], history: [], vapidPublicKey: '', emailAddress: '', pairingEmailAvailable: false })
  clearSecret()
  clearPairingResult()
  $('#pair-form').reset()
  pairing = undefined
  choosePlatform('')
  render()
  $('#send-form').reset()
  $('#device-form').reset()
  $('#key-form').reset()
  browserPush = undefined
  $('#auth-form').reset()
  $('#activate-form').reset()
  $('#edit-device').close()
  updatePreview()
  $('#logout').hidden = true
  $('#workspace').hidden = true
  $('#entrance').hidden = false
  renderEntrance()
}

function renderEntrance() {
  const hash = location.hash
  const signup = state.registrationEnabled && hash === '#registracia'
  const activate = hash === '#aktivacia'
  const owner = hash === '#spravca' || (state.needsSetup && hash !== '#prihlasenie' && !signup && !activate)
  const setup = owner && state.needsSetup
  $('#auth-form').hidden = signup || activate
  $('#signup-form').hidden = !signup
  $('#activate-form').hidden = !activate
  $('#auth-navigation').hidden = false
  $('#auth-login-link').hidden = !signup && !activate && !owner
  $('#auth-signup-link').hidden = signup || !state.registrationEnabled
  $('#auth-activate-link').hidden = activate || !state.registrationEnabled
  $('#auth-owner-link').hidden = owner
  $('#auth-email-label').hidden = owner
  $('#auth-email').disabled = owner
  $('#auth-email').required = !owner
  $('#setup-label').hidden = !setup
  $('#setup-code').disabled = !setup
  $('#setup-code').required = setup
  $('#password').autocomplete = setup ? 'new-password' : 'current-password'
  $('#password').minLength = setup ? 12 : 0
  $('#auth-title').textContent = t(signup ? 'Vytvor si účet' : activate ? 'Aktivuj si účet' :
    setup ? 'Nastav si prístup' : owner ? 'Prístup správcu' : 'Prihlásenie')
  $('#auth-note').textContent = t(signup ? 'Na e-mail ti pošleme dočasné heslo na aktiváciu účtu.' :
    activate ? 'Zadaj dočasné heslo z e-mailu a nastav si vlastné heslo.' :
    setup ? 'Zadaj jednorazový inštalačný kód a zvoľ si heslo s aspoň 12 znakmi.' :
    owner ? 'Prihlás sa heslom správcu tejto inštancie.' : 'Prihlás sa e-mailom a heslom svojho účtu.')
  $('#auth-submit').textContent = t(setup ? 'Vytvoriť prístup ↗' : 'Prihlásiť sa ↗')
}

function showWorkspace() {
  $('#entrance').hidden = true
  $('#workspace').hidden = false
  $('#logout').hidden = false
  navigate()
  void prepareBrowserPush()
  if (location.hash === '#zariadenia') suggestPlatform()
}

function navigate() {
  const hash = location.hash.slice(1)
  const selected = views.some(view => view.dataset.view === hash) ? hash : 'prehlad'
  for (const tab of views) {
    const active = tab.dataset.view === selected
    if (active) tab.setAttribute('aria-current', 'page')
    else tab.removeAttribute('aria-current')
    $('#' + tab.dataset.view).hidden = !active
  }
}

async function reload() {
  const version = ++reloadVersion
  const data = await request('/overview')
  if (version === reloadVersion) {
    Object.assign(state, data)
    render()
  }
}

function element(tag, className, content) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function record(title, detail) {
  const row = element('div', 'record')
  const description = element('div')
  description.append(element('h3', '', title))
  if (detail) description.append(element('small', '', detail))
  row.append(description)
  return [row, description]
}

function recordAction(label, output, run) {
  const button = element('button', 'button button-outline button-small', label)
  button.type = 'button'
  button.addEventListener('click', action(button, output, run))
  return button
}

const statuses = {
  pending: t('Odosiela sa'),
  accepted: t('Prijaté'),
  partial: t('Čiastočne prijaté'),
  failed: t('Zlyhalo'),
  interrupted: t('Prerušené')
}
function formatDate(value) { return date.format(new Date(value)) }

function render() {
  $('#pair-email-form').hidden = !state.pairingEmailAvailable
  $('#mail-panel').hidden = !state.emailAddress
  $('#mail-address').value = state.emailAddress
  const recipient = $('#pair-email-form input[name="email"]')
  recipient.readOnly = Boolean(state.accountEmail)
  if (recipient.readOnly) recipient.value = state.accountEmail
  const groups = [...new Set(state.devices.map(device => device.group).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, language))
  $('#device-count').textContent = state.devices.length
  const select = $('#targets')
  const previous = select.value
  select.replaceChildren(new Option(t('Vyber príjemcu'), ''))
  for (const device of state.devices) {
    select.add(new Option(t('Zariadenie · {name}', { name: device.name }), 'device:' + device.id))
  }
  for (const group of groups) select.add(new Option(t('Skupina · {name}', { name: group }), 'group:' + group))
  if (state.devices.length) select.add(new Option(t('Všetky zariadenia'), 'all'))
  if ([...select.options].some(option => option.value === previous)) select.value = previous
  $('#group-options').replaceChildren(...groups.map(group => new Option(group, group)))

  $('#device-list').replaceChildren(...state.devices.map(device => {
    const [row, description] = record(device.name, (device.platform === 'android' ? 'Android · ' : 'Web Push · ') + (device.group ? t('Skupina · {name}', { name: device.group }) : 'Bez skupiny'))
    const id = element('small', '', 'ID: ' + device.id)
    description.append(id)
    const actions = element('div', 'record-actions')
    actions.append(
      recordAction(t('Poslať test ↗'), 'device-list-feedback', () => sendTest(device.id, 'device-list-feedback')),
      recordAction(t('Upraviť'), 'device-feedback', () => editDevice(device)),
      recordAction(t('Odpojiť'), 'device-feedback', () => removeDevice(device))
    )
    row.append(actions)
    return row
  }))

  showTestDevice(testDeviceId)

  $('#history-list').replaceChildren(...state.history.map(item => {
    const [row, description] = record(item.title)
    description.append(element('p', 'history-message', item.message),
      element('small', '', [formatDate(item.created), item.target === allDevicesStoredValue ? t('Všetky zariadenia') : item.target,
        t('Prijaté {count}', { count: item.accepted }) + ' · Zlyhané ' + item.failed].join(' · ')))
    row.append(element('span', 'badge ' + item.status, statuses[item.status]))
    return row
  }))

  $('#key-list').replaceChildren(...state.keys.map(key => {
    const [row] = record(key.label, key.hint + '… · ' + (key.used
      ? t('Použitý {date}', { date: formatDate(key.used) }) : t('Vytvorený {date}', { date: formatDate(key.created) })))
    row.append(recordAction(t('Zrušiť'), 'key-feedback', async () => {
      if (!confirm(t('Zrušiť API kľúč „{name}“?', { name: key.label }))) return
      await request('/keys/' + key.id, { method: 'DELETE' })
      clearSecret()
      await reload()
      feedback('key-feedback', t('API kľúč bol zrušený.'))
    }))
    return row
  }))

  for (const [id, message] of Object.entries({
    'device-list': t('Zatiaľ tu nie sú žiadne zariadenia.'),
    'history-list': t('Zatiaľ tu nie sú žiadne odoslania.'),
    'key-list': t('Zatiaľ tu nie sú žiadne API kľúče.')
  })) {
    const list = $('#' + id)
    if (!list.childElementCount) list.append(element('p', 'muted', message))
  }
}

function clearSecret() {
  $('#secret').value = ''
  $('#new-key').hidden = true
}

function updatePreview() {
  const { title, message } = $('#send-form').elements
  $('#preview-title').textContent = title.value.trim() || defaultTitle
  $('#preview-message').textContent = message.value.trim() || t('Tu sa zobrazí text správy.')
}

function decodeKey(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))
}

function deviceStorage(value) {
  try {
    const key = 'pingdeck:device:' + base + (state.accountId === 'owner' ? '' : ':' + state.accountId)
    if (value === null) localStorage.removeItem(key)
    else if (value !== undefined) localStorage.setItem(key, value)
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

let browserPush
let browserPushError

async function prepareBrowserPush() {
  const supported = isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  if (!supported) return
  const button = $('#device-form button[type="submit"]')
  button.disabled = true
  try {
    const worker = await navigator.serviceWorker.register(link('/sw.js'), { scope: link('/') })
    const registration = worker.active ? worker : await navigator.serviceWorker.ready
    const applicationServerKey = decodeKey(state.vapidPublicKey)
    let subscription = await registration.pushManager.getSubscription()
    const key = subscription?.options?.applicationServerKey
    if (key && !new Uint8Array(key).every((byte, index) => byte === applicationServerKey[index])) {
      await subscription.unsubscribe()
      subscription = null
    }
    browserPush = { registration, applicationServerKey, subscription }
    browserPushError = undefined
  } catch (error) {
    browserPushError = error
  } finally {
    button.disabled = false
  }
}

async function registerDevice(data) {
  if (!browserPush) {
    throw new Error(browserPushError?.message ?? t('Web Push tu nie je dostupný. Na iPhone alebo iPade otvor panel z plochy.'))
  }
  if (Notification.permission === 'denied') {
    throw new Error(t('Povoľ upozornenia v nastaveniach webu a skús znova.'))
  }
  const { registration, applicationServerKey } = browserPush
  let subscription = browserPush.subscription
  try {
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
  } catch {
    throw new Error(t('Prehliadač nedokázal vytvoriť odber upozornení.'))
  }
  browserPush.subscription = subscription
  const result = await request('/devices', { method: 'POST', data: { ...data, subscription: subscription.toJSON() } })
  deviceStorage(result.id)
  testDeviceId = result.id
  feedback('wizard-test-feedback')
  await reload()
  feedback('device-feedback', t('Zariadenie je pripravené prijímať upozornenia.'))
}

async function removeDevice(device) {
  if (!confirm(t('Odpojiť zariadenie „{name}“?', { name: device.name }))) return
  await request('/devices/' + device.id, { method: 'DELETE' })
  if (deviceStorage() === device.id && 'serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration(link('/'))
      const subscription = await registration?.pushManager.getSubscription()
      await subscription?.unsubscribe()
    } catch {
      // Server-side deletion already stops all future sends to this device.
    }
    deviceStorage(null)
    if (browserPush) browserPush.subscription = null
  }
  await reload()
  feedback('device-feedback', t('Zariadenie bolo odpojené.'))
}

function editDevice(device) {
  const { elements } = $('#edit-form')
  elements.id.value = device.id
  elements.name.value = device.name
  elements.group.value = device.group
  feedback('edit-feedback')
  $('#edit-device').showModal()
}

async function copy(text) {
  if (!navigator.clipboard) throw new Error(t('Schránka nie je dostupná. Označ a skopíruj text ručne.'))
  await navigator.clipboard.writeText(text)
}


function choosePlatform(platform) {
  for (const button of document.querySelectorAll('#device-platform button')) {
    button.setAttribute('aria-pressed', String(button.dataset.platform === platform))
  }
  $('#browser-pairing').hidden = platform !== 'web' && platform !== 'iphone'
  $('#iphone-pairing-guide').hidden = platform !== 'iphone'
  $('#android-pairing').hidden = platform !== 'android'
  showTestDevice('')
  feedback('wizard-test-feedback')
}

function suggestPlatform() {
  const installed = navigator.standalone || matchMedia('(display-mode: standalone)').matches
  const appleMobile = /iPhone|iPad/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (appleMobile && installed && !$('#device-platform [aria-pressed="true"]')) {
    choosePlatform('iphone')
  }
}

function showTestDevice(id) {
  testDeviceId = id
  const device = state.devices.find(candidate => candidate.id === id)
  $('#device-wizard-test').hidden = !device
  $('#test-device-name').textContent = device ? t('Poslať test do zariadenia {name}', { name: device.name }) : ''
}

async function watchPairing(pending) {
  while (pairing === pending) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    if (pairing !== pending) return
    try {
      const status = performance.now() >= pending.deadline ? { state: 'expired' } :
        await request('/mobile/codes/status', { method: 'POST', data: { code: pending.code } })
      if (pairing !== pending) return
      if (status.state === 'waiting') continue
      pairing = undefined
      clearPairingResult()
      if (status.state === 'linked') {
        if (!$('#android-pairing').hidden) testDeviceId = status.id
        await reload()
        feedback('pair-feedback', t('Telefón je pripojený. Teraz pošli test iba doň.'))
      } else {
        feedback('pair-feedback', t('Kód vypršal. Vytvor nový.'), true)
      }
      return
    } catch (error) {
      feedback('pair-feedback', error.message, true)
      if (error.status === 401) {
        showEntrance(false)
        return
      }
    }
  }
}

async function sendTest(id, output) {
  const result = await request('/devices/' + encodeURIComponent(id) + '/test', { method: 'POST' })
  const delivery = result.deliveries[0]?.result
  const message = delivery === 'queued'
    ? t('Test čaká na prevzatie Androidom. Skontroluj, či je príjem zapnutý.')
    : delivery === 'accepted'
      ? t('Test prijal poskytovateľ Web Push. Skontroluj upozornenia na zariadení.')
      : t('Test sa nepodarilo odoslať. Skontroluj pripojenie a povolenia zariadenia.')
  feedback(output, message, !result.accepted)
  await reload()
}

for (const button of document.querySelectorAll('#device-platform button')) {
  button.addEventListener('click', () => choosePlatform(button.dataset.platform))
}
$('#wizard-test').addEventListener('click', action($('#wizard-test'), 'wizard-test-feedback',
  () => sendTest(testDeviceId, 'wizard-test-feedback')))

async function openAccount(accountId) {
  state.accountId = accountId
  await reload()
  if (['#registracia', '#aktivacia', '#spravca', '#prihlasenie'].includes(location.hash)) {
    history.replaceState(null, '', location.pathname + location.search + '#prehlad')
  }
  showWorkspace()
}

onSubmit('auth-form', 'auth-feedback', async (data, form) => {
  const route = data.code === undefined ? '/login' : '/setup'
  const { accountId } = await request(route, { method: 'POST', data })
  form.reset()
  await openAccount(accountId)
})

onSubmit('signup-form', 'auth-feedback', async ({ email }) => {
  await request('/register', { method: 'POST', data: { email } })
  history.replaceState(null, '', location.pathname + location.search + '#aktivacia')
  $('#activate-email').value = email.trim()
  renderEntrance()
  feedback('auth-feedback', t('Ak je možné založiť účet, dočasné heslo príde e-mailom. Skontroluj aj priečinok Spam.'))
  $('#temporary-password').focus()
})

onSubmit('activate-form', 'auth-feedback', async (data, form) => {
  const { accountId } = await request('/activate', { method: 'POST', data })
  form.reset()
  await openAccount(accountId)
})

onSubmit('pair-form', 'pair-feedback', async (data, form) => {
  const { code, qr, link: openLink } = await request('/mobile/codes', { method: 'POST', data })
  clearPairingResult()
  const pending = { code, deadline: performance.now() + 10 * 60_000 }
  pairing = pending
  $('#pair-code').value = code
  $('#pair-qr-image').src = qr
  $('#pair-open').href = openLink
  $('#pair-result').hidden = false
  form.reset()
  feedback('pair-feedback', t('Kód platí 10 minút a dá sa použiť raz.'))
  void watchPairing(pending)
})

onSubmit('pair-email-form', 'pair-email-feedback', async ({ email }) => {
  const pending = pairing
  if (!pending) throw new Error(t('Párovací kód už nie je platný. Vytvor nový.'))
  await request('/mobile/codes/email', { method: 'POST', data: { code: pending.code, email } })
  if (pairing === pending) feedback('pair-email-feedback', t('Párovací e-mail bol odoslaný.'))
})

$('#copy-pair').addEventListener('click', action($('#copy-pair'), 'pair-feedback', async () => {
  await copy($('#pair-code').value)
  feedback('pair-feedback', t('Kód je v schránke.'))
}))
$('#copy-email').addEventListener('click', action($('#copy-email'), 'mail-feedback', async () => {
  await copy($('#mail-address').value)
  feedback('mail-feedback', t('Adresa je v schránke.'))
}))

onSubmit('device-form', 'device-feedback', registerDevice)
onSubmit('edit-form', 'edit-feedback', async ({ id, name, group }) => {
  await request('/devices/' + id, { method: 'PATCH', data: { name, group } })
  $('#edit-device').close()
  await reload()
  feedback('device-feedback', t('Zmeny boli uložené.'))
})

onSubmit('send-form', 'send-feedback', async ({ target, ttl, ...data }, form) => {
  if (!target) throw new Error(t('Vyber príjemcu'))
  if (target === 'all') {
    if (!confirm(t('Odoslať upozornenie na všetky zariadenia ({count})?', { count: state.devices.length }))) return
    data.broadcast = true
  }
  if (target.startsWith('device:')) data.deviceId = target.slice(7)
  if (target.startsWith('group:')) data.group = target.slice(6)
  data.ttl = Number(ttl)
  const result = await request('/send', { method: 'POST', data })
  feedback('send-feedback', t('Prijaté na doručenie: {accepted}. Zlyhané: {failed}.', result), !result.accepted)
  if (result.accepted && !result.failed) {
    form.reset()
    updatePreview()
  }
  await reload()
})

onSubmit('key-form', 'key-feedback', async (data, form) => {
  const { token } = await request('/keys', { method: 'POST', data })
  $('#secret').value = token
  $('#new-key').hidden = false
  form.reset()
  await reload()
})

$('#logout').addEventListener('click', action($('#logout'), 'workspace-feedback', async () => {
  await request('/logout', { method: 'POST' })
  location.reload()
}))
$('#refresh').addEventListener('click', action($('#refresh'), 'workspace-feedback', reload))
$('#copy-key').addEventListener('click', action($('#copy-key'), 'key-feedback', async () => {
  await copy($('#secret').value)
  feedback('key-feedback', t('Kľúč je v schránke.'))
}))
$('#copy-api').addEventListener('click', action($('#copy-api'), 'workspace-feedback', async () => {
  await copy($('#api-example').textContent)
  feedback('workspace-feedback', t('Príklad je v schránke.'))
}))
$('#hide-key').addEventListener('click', clearSecret)
$('#cancel-edit').addEventListener('click', () => $('#edit-device').close())
$('#send-form').addEventListener('input', updatePreview)
window.addEventListener('hashchange', () => {
  if (location.hash === '#main') return
  if (!$('#entrance').hidden) {
    feedback('auth-feedback')
    renderEntrance()
    return
  }
  navigate()
  if (location.hash === '#zariadenia') suggestPlatform()
})

try {
  const session = await request('/session')
  state.registrationEnabled = session.registrationEnabled
  if (session.authenticated) {
    await openAccount(session.accountId)
  } else {
    showEntrance(session.needsSetup)
  }
} catch (error) {
  $('#auth-title').textContent = t('{brand} je nedostupný', { brand })
  $('#auth-note').textContent = error.message
}
