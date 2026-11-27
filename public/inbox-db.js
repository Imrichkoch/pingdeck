(() => {
  const name = 'pingdeck-inbox:' + location.pathname.replace(/\/(?:sw\.js|iphone-app)$/, '')
  const limit = 100
  let open

  function database() {
    open ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => {
        const entries = request.result.createObjectStore('entries', { keyPath: 'id' })
        entries.createIndex('received', 'received')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return open
  }

  async function save(entry) {
    const databaseHandle = await database()
    return new Promise((resolve, reject) => {
      const transaction = databaseHandle.transaction('entries', 'readwrite')
      const entries = transaction.objectStore('entries')
      entries.put(entry)
      let count = 0
      const cursors = entries.index('received').openCursor(null, 'prev')
      cursors.onsuccess = () => {
        const row = cursors.result
        if (!row) return
        if (++count > limit) row.delete()
        row.continue()
      }
      transaction.oncomplete = resolve
      transaction.onabort = () => reject(transaction.error)
    })
  }

  async function list() {
    const databaseHandle = await database()
    return new Promise((resolve, reject) => {
      const request = databaseHandle.transaction('entries').objectStore('entries').index('received').getAll()
      request.onsuccess = () => resolve(request.result.reverse())
      request.onerror = () => reject(request.error)
    })
  }

  globalThis.PingDeckInbox = { save, list }
})()
