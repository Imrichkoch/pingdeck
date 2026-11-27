import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { config } from './config.mjs'
import { hash, historyExists } from './store.mjs'

const asText = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit).trim() : '')
const maximumSize = 262_144
let current
let timer
let stopped = false

export function startMailGateway(send) {
  const options = config.mail
  if (!options || timer) return

  async function processInbox() {
    if (stopped) return
    const client = new ImapFlow({
      host: options.host,
      port: options.port,
      secure: true,
      auth: { user: options.address, pass: options.password },
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 15_000,
      disableAutoIdle: true,
      logger: false
    })
    current = client
    client.on('error', () => {})
    try {
      await client.connect()
      const lock = await client.getMailboxLock('INBOX')
      try {
        const batch = await client.search({ all: true, deleted: false }, { uid: true })
        for (const uid of (batch || []).slice(0, 5)) {
          if (stopped) break
          const metadata = await client.fetchOne(uid, { size: true, internalDate: true }, { uid: true })
          if (!metadata) continue
          const stale = Date.now() - new Date(metadata.internalDate).getTime() > 2 * 86_400_000
          if (stale || metadata.size > maximumSize) {
            await client.messageDelete(uid, { uid: true })
            continue
          }
          const id = 'mail-' + hash(options.address + ':' + client.mailbox.uidValidity + ':' + uid)
          if (!historyExists(id)) {
            const mail = await client.fetchOne(uid, { source: true }, { uid: true })
            if (!mail?.source) continue
            const parsed = await simpleParser(mail.source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true })
            const auto = parsed.headers.get('auto-submitted')
            if (!auto || String(auto).toLowerCase() === 'no') {
              let subject = parsed.subject?.trim() ?? ''
              let group = ''
              const tag = subject.match(/^\[skupina:([^\]\r\n]{1,48})\]\s*/i)
              if (tag) {
                group = tag[1].trim()
                subject = subject.slice(tag[0].length)
              }
              const title = asText(subject, 100) || 'E-mail'
              const message = asText(parsed.text, 600) || 'Správa bez textového obsahu.'
              try {
                await send({ title, message, group }, { id })
              } catch (error) {
                if (error.status === 422 && !group) break
                if (error.status !== 422) throw error
              }
            }
          }
          await client.messageDelete(uid, { uid: true })
        }
      } finally {
        lock.release()
      }
      if (client.usable) await client.logout()
    } catch (error) {
      if (!stopped && ![422, 429].includes(error.status)) {
        console.warn('IMAP gateway:', error.code ?? error.name)
      }
    } finally {
      client.close()
      current = undefined
      if (!stopped) timer = setTimeout(processInbox, options.interval).unref()
    }
  }

  timer = setTimeout(processInbox, 100).unref()
}

export function stopMailGateway() {
  stopped = true
  clearTimeout(timer)
  current?.close()
}
