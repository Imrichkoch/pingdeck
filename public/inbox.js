const statusLine = document.querySelector('#inbox-status')
const list = document.querySelector('#inbox-list')
const setup = document.querySelector('#inbox-setup')
const basePath = document.body.dataset.base
const formatDate = new Intl.DateTimeFormat('sk-SK', { dateStyle: 'medium', timeStyle: 'short' })

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

async function updateInbox() {
  let subscription
  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration(basePath + '/')
      subscription = await registration?.pushManager?.getSubscription()
    }
    const entries = await PingDeckInbox.list()
    list.replaceChildren(...entries.map(makeCard))
    setup.hidden = Boolean(subscription)
    statusLine.textContent = entries.length ? 'Správy uložené v tomto zariadení.' : subscription
      ? 'Keď príde upozornenie, zobrazí sa tu.'
      : 'Pripoj zariadenie v paneli, aby mohlo prijímať upozornenia.'
  } catch {
    statusLine.textContent = 'Schránku správ sa nepodarilo načítať.'
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
