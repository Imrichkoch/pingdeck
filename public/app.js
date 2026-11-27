const $ = selector => document.querySelector(selector)
const { base, name: brand, defaultTitle } = document.body.dataset
const link = path => base + path
const date = new Intl.DateTimeFormat('sk-SK', { dateStyle: 'medium', timeStyle: 'short' })
const state = { needsSetup: false, devices: [], keys: [], history: [], vapidPublicKey: '', emailAddress: '' }
const views = [...document.querySelectorAll('[data-view]')]
let reloadVersion = 0

async function request(path, { method = 'GET', data } = {}) {
  const response = await fetch(link('/api' + path), {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined
  })
  if (response.status === 204) return
  const result = await response.json().catch(() => null)
  if (!response.ok && !(response.status === 502 && result?.deliveries)) {
    const error = new Error(result?.error ?? 'Server neodpovedal podľa očakávania.')
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
        feedback('auth-feedback', 'Prihlásenie vypršalo. Prihlás sa znova.', true)
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
    void action(form.querySelector('[type="submit"]'), output, () => run(data, form), id !== 'auth-form')()
  })
}

function showEntrance(needsSetup) {
  ++reloadVersion
  state.needsSetup = needsSetup
  Object.assign(state, { devices: [], keys: [], history: [], vapidPublicKey: '', emailAddress: '' })
  clearSecret()
  $('#pair-code').value = ''
  $('#pair-result').hidden = true
  $('#pair-form').reset()
  render()
  $('#send-form').reset()
  $('#device-form').reset()
  $('#key-form').reset()
  $('#auth-form').reset()
  $('#edit-device').close()
  updatePreview()
  $('#logout').hidden = true
  $('#workspace').hidden = true
  $('#entrance').hidden = false
  $('#auth-form').hidden = false
  $('#setup-label').hidden = !needsSetup
  $('#setup-code').required = needsSetup
  $('#password').autocomplete = needsSetup ? 'new-password' : 'current-password'
  $('#password').minLength = needsSetup ? 12 : 0
  $('#auth-title').textContent = needsSetup ? 'Nastav si prístup' : 'Prihlásenie'
  $('#auth-note').textContent = needsSetup
    ? 'Zadaj jednorazový inštalačný kód a zvoľ si heslo s aspoň 12 znakmi.'
    : 'Prihlás sa heslom správcu tejto inštancie.'
  $('#auth-submit').textContent = needsSetup ? 'Vytvoriť prístup ↗' : 'Prihlásiť sa ↗'
}

function showWorkspace() {
  $('#entrance').hidden = true
  $('#workspace').hidden = false
  $('#logout').hidden = false
  navigate()
  void prepareBrowserPush()
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
  pending: 'Odosiela sa',
  accepted: 'Prijaté',
  partial: 'Čiastočne prijaté',
  failed: 'Zlyhalo',
  interrupted: 'Prerušené'
}
function formatDate(value) { return date.format(new Date(value)) }

function render() {
  $('#mail-panel').hidden = !state.emailAddress
  $('#mail-address').value = state.emailAddress
  const groups = [...new Set(state.devices.map(device => device.group).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'sk'))
  $('#device-count').textContent = state.devices.length
  const select = $('#targets')
  const previous = select.value
  select.replaceChildren(new Option('Všetky zariadenia', 'all'))
  for (const device of state.devices) {
    select.add(new Option('Zariadenie · ' + device.name, 'device:' + device.id))
  }
  for (const group of groups) select.add(new Option('Skupina · ' + group, 'group:' + group))
  if ([...select.options].some(option => option.value === previous)) select.value = previous
  $('#group-options').replaceChildren(...groups.map(group => new Option(group, group)))

  $('#device-list').replaceChildren(...state.devices.map(device => {
    const [row, description] = record(device.name, (device.platform === 'android' ? 'Android · ' : 'Web Push · ') + (device.group ? 'Skupina · ' + device.group : 'Bez skupiny'))
    const id = element('small', '', 'ID: ' + device.id)
    description.append(id)
    const actions = element('div', 'record-actions')
    actions.append(
      recordAction('Upraviť', 'device-feedback', () => editDevice(device)),
      recordAction('Odpojiť', 'device-feedback', () => removeDevice(device))
    )
    row.append(actions)
    return row
  }))

  $('#history-list').replaceChildren(...state.history.map(item => {
    const [row, description] = record(item.title)
    description.append(element('p', 'history-message', item.message),
      element('small', '', [formatDate(item.created), item.target,
        'Prijaté ' + item.accepted + ' · Zlyhané ' + item.failed].join(' · ')))
    row.append(element('span', 'badge ' + item.status, statuses[item.status]))
    return row
  }))

  $('#key-list').replaceChildren(...state.keys.map(key => {
    const [row] = record(key.label, key.hint + '… · ' + (key.used
      ? 'Použitý ' + formatDate(key.used) : 'Vytvorený ' + formatDate(key.created)))
    row.append(recordAction('Zrušiť', 'key-feedback', async () => {
      if (!confirm('Zrušiť API kľúč „' + key.label + '“?')) return
      await request('/keys/' + key.id, { method: 'DELETE' })
      clearSecret()
      await reload()
      feedback('key-feedback', 'API kľúč bol zrušený.')
    }))
    return row
  }))

  for (const [id, message] of Object.entries({
    'device-list': 'Zatiaľ tu nie sú žiadne zariadenia.',
    'history-list': 'Zatiaľ tu nie sú žiadne odoslania.',
    'key-list': 'Zatiaľ tu nie sú žiadne API kľúče.'
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
  $('#preview-message').textContent = message.value.trim() || 'Tu sa zobrazí text správy.'
}

function decodeKey(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))
}

function deviceStorage(value) {
  try {
    const key = 'pingdeck:device:' + base
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
    throw new Error(browserPushError?.message ?? 'Web Push tu nie je dostupný. Na iPhone alebo iPade otvor panel z plochy.')
  }
  const { registration, applicationServerKey } = browserPush
  let subscription = browserPush.subscription
  try {
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
  } catch (error) {
    throw new Error('Prehliadač nedokázal vytvoriť odber upozornení. ' + error.message)
  }
  browserPush.subscription = subscription
  const result = await request('/devices', { method: 'POST', data: { ...data, subscription: subscription.toJSON() } })
  deviceStorage(result.id)
  await reload()
  feedback('device-feedback', 'Zariadenie je pripravené prijímať upozornenia.')
}

async function removeDevice(device) {
  if (!confirm('Odpojiť zariadenie „' + device.name + '“?')) return
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
  feedback('device-feedback', 'Zariadenie bolo odpojené.')
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
  if (!navigator.clipboard) throw new Error('Schránka nie je dostupná. Označ a skopíruj text ručne.')
  await navigator.clipboard.writeText(text)
}

onSubmit('auth-form', 'auth-feedback', async (data, form) => {
  const { code, password } = data
  await request(state.needsSetup ? '/setup' : '/login', {
    method: 'POST', data: state.needsSetup ? { code: code.trim(), password } : { password }
  })
  form.reset()
  await reload()
  showWorkspace()
})

onSubmit('pair-form', 'pair-feedback', async (data, form) => {
  const { code } = await request('/mobile/codes', { method: 'POST', data })
  $('#pair-code').value = code
  $('#pair-result').hidden = false
  form.reset()
  feedback('pair-feedback', 'Kód platí 10 minút a dá sa použiť raz.')
})

$('#copy-pair').addEventListener('click', action($('#copy-pair'), 'pair-feedback', async () => {
  await copy($('#pair-code').value)
  feedback('pair-feedback', 'Kód je v schránke.')
}))
$('#copy-email').addEventListener('click', action($('#copy-email'), 'mail-feedback', async () => {
  await copy($('#mail-address').value)
  feedback('mail-feedback', 'Adresa je v schránke.')
}))

onSubmit('device-form', 'device-feedback', registerDevice)
onSubmit('edit-form', 'edit-feedback', async ({ id, name, group }) => {
  await request('/devices/' + id, { method: 'PATCH', data: { name, group } })
  $('#edit-device').close()
  await reload()
  feedback('device-feedback', 'Zmeny boli uložené.')
})

onSubmit('send-form', 'send-feedback', async ({ target, ttl, ...data }, form) => {
  if (target.startsWith('device:')) data.deviceId = target.slice(7)
  if (target.startsWith('group:')) data.group = target.slice(6)
  data.ttl = Number(ttl)
  const result = await request('/send', { method: 'POST', data })
  feedback('send-feedback', 'Prijaté na doručenie: ' + result.accepted + '. Zlyhané: ' + result.failed + '.', !result.accepted)
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
  feedback('key-feedback', 'Kľúč je v schránke.')
}))
$('#copy-api').addEventListener('click', action($('#copy-api'), 'workspace-feedback', async () => {
  await copy($('#api-example').textContent)
  feedback('workspace-feedback', 'Príklad je v schránke.')
}))
$('#hide-key').addEventListener('click', clearSecret)
$('#cancel-edit').addEventListener('click', () => $('#edit-device').close())
$('#send-form').addEventListener('input', updatePreview)
window.addEventListener('hashchange', navigate)

try {
  const session = await request('/session')
  if (session.authenticated) {
    await reload()
    showWorkspace()
  } else {
    showEntrance(session.needsSetup)
  }
} catch (error) {
  $('#auth-title').textContent = brand + ' je nedostupný'
  $('#auth-note').textContent = error.message
}
