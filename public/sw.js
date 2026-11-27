importScripts('./inbox-db.js')

self.addEventListener('push', event => {
  let payload
  try {
    payload = event.data?.json()
  } catch {
    payload = { message: event.data?.text() }
  }

  const scope = self.registration.scope
  const entry = {
    id: payload?.id ?? crypto.randomUUID(),
    title: payload?.title || 'Push upozornenie',
    message: payload?.message || '',
    url: payload?.url || '',
    received: Date.now()
  }
  const display = self.registration.showNotification(entry.title, {
    body: entry.message,
    icon: new URL('icon-192.png', scope).href,
    badge: new URL('badge.png', scope).href,
    tag: entry.id,
    data: { url: entry.url }
  })
  const archive = PingDeckInbox.save(entry).then(async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const inbox = new URL('iphone-app', scope).href
    for (const client of clients) if (client.url === inbox) client.postMessage('pingdeck-inbox')
  }).catch(() => {})
  event.waitUntil(Promise.all([display, archive]))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const fallback = new URL('iphone-app', self.registration.scope)
  let destination = fallback
  try {
    const url = new URL(event.notification.data?.url)
    if (['https:', 'http:'].includes(url.protocol)) destination = url
  } catch {
    // Open the installed app when the notification has no custom link.
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find(client => client.url === destination.href)
    if (existing) return existing.focus()
    return self.clients.openWindow(destination.href)
  })())
})
