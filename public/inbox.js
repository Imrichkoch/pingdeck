import { translate } from './locale.js'

const language = document.documentElement.lang
const t = source => translate(language, source)
const statusLine = document.querySelector('#inbox-status')
const list = document.querySelector('#inbox-list')
const setup = document.querySelector('#inbox-setup')
const signIn = document.querySelector('#inbox-login')
const basePath = document.body.dataset.base
const formatDate = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' })

function text(tag, value, className) {
  const node = document.createElement(tag)
  node.textContent = value
  if (className) node.className = className
  return node
}

function makeCard(entry) {
  const card = document.createElement('article')
  card.className = 'app-card inbox-entry'
  card.append(text('h2', entry.title), text('p', entry.message))
  card.append(text('time', formatDate.format(entry.received), 'muted'))
  if (entry.url) {
    try {
      const url = new URL(entry.url)
      if (['http:', 'https:'].includes(url.protocol)) {
        const link = text('a', 'Otvoriť odkaz ↗')
        link.href = url.href
        card.append(link)
      }
    } catch {
      // A message can be displayed even when its link has expired or is invalid.
    }
  }
  return card
}

let inboxVersion = 0

async function updateInbox() {
  const version = ++inboxVersion
  statusLine.textContent = t('Načítavam správy…')
  list.replaceChildren()
  setup.hidden = true
  signIn.hidden = true
  let subscription
  try {
    const response = await fetch(basePath + '/api/session', { cache: 'no-store' })
    if (!response.ok) throw new Error('Session unavailable')
    const session = await response.json()
    if (version !== inboxVersion) return
    if (!session.authenticated) {
      statusLine.textContent = t('Prihlás sa, aby sa zobrazili správy tvojho účtu.')
      signIn.hidden = false
      return
    }
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration(basePath + '/')
      subscription = await registration?.pushManager?.getSubscription()
    }
    const entries = (await PingDeckInbox.list()).filter(entry => {
      const owner = entry.accountId ?? (entry.id.includes(':') ? entry.id.split(':', 1)[0] : 'owner')
      return owner === session.accountId
    })
    if (version !== inboxVersion) return
    list.replaceChildren(...entries.map(makeCard))
    setup.hidden = Boolean(subscription)
    statusLine.textContent = entries.length ? t('Správy uložené v tomto zariadení.') : subscription
      ? t('Keď príde upozornenie, zobrazí sa tu.')
      : t('Pripoj zariadenie v paneli, aby mohlo prijímať upozornenia.')
  } catch {
    if (version !== inboxVersion) return
    statusLine.textContent = t('Schránku správ sa nepodarilo načítať.')
  }
}

if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
  document.querySelector('#inbox-help').hidden = true
}
navigator.serviceWorker?.addEventListener('message', () => void updateInbox())
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void updateInbox()
})
void updateInbox()
