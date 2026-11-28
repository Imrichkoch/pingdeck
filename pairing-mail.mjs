import QRCode from 'qrcode'
import nodemailer from 'nodemailer'
import { config } from './config.mjs'
import { translate } from './public/locale.js'

const mail = config.pairMail
const transport = mail && nodemailer.createTransport({
  host: mail.host,
  port: mail.port,
  secure: true,
  auth: { user: mail.address, pass: mail.password },
  connectionTimeout: 8000,
  greetingTimeout: 8000,
  socketTimeout: 15000,
  disableFileAccess: true,
  disableUrlAccess: true
})

export function pairingLink(code) {
  return config.origin + config.base + '/android/pair#code=' + code
}

export async function pairingImage(code) {
  return QRCode.toBuffer(pairingLink(code), { type: 'png', width: 360, margin: 4, errorCorrectionLevel: 'M' })
}

const escape = value => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char])

export async function emailPairing({ to, code, language }) {
  const t = source => translate(language, source)
  const link = pairingLink(code)
  const heading = t('Spáruj Android s PingDeckom')
  const instructions = t('Na telefóne otvor odkaz nižšie. Ak čítaš e-mail na inom zariadení, naskenuj QR kód v aplikácii PingDeck.')
  const expiry = t('Kód je jednorazový a platí najviac 10 minút od vytvorenia. E-mail s kódom nepreposielaj.')
  const open = t('Otvoriť v PingDecku')
  const label = t('Párovací kód')
  const cid = 'pingdeck-pairing@' + new URL(config.origin).hostname
  const result = await transport.sendMail({
    from: { name: config.brand.name, address: mail.address },
    to: [{ address: to }],
    subject: heading,
    headers: { 'Auto-Submitted': 'auto-generated' },
    text: [heading, instructions, open + ' — ' + link, label + ' — ' + code, expiry].join('\n\n'),
    html: '<h1>' + escape(heading) + '</h1><p>' + escape(instructions) + '</p><p><a href="' +
      escape(link) + '">' + escape(open) + '</a></p><p><img src="cid:' + escape(cid) +
      '" width="300" height="300" alt="QR"></p><p>' + escape(label) + ' <strong>' +
      escape(code) + '</strong></p><p>' + escape(expiry) + '</p>',
    attachments: [{ filename: 'pingdeck-pairing.png', content: await pairingImage(code), contentType: 'image/png', cid }]
  })
  if (!result.accepted.length) throw new Error('Pairing message was not accepted by SMTP.')
}
