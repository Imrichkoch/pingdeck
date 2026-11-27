import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { issueSetupCode, snapshot } from './store.mjs'

process.umask(0o077)
const [command, path] = process.argv.slice(2)
try {
  if (command === 'setup' || command === 'reset') {
    console.log(issueSetupCode(command === 'reset'))
  } else if (command === 'backup' && path) {
    const target = resolve(path)
    if (existsSync(target)) throw new Error('Cieľový súbor už existuje.')
    await snapshot(target)
    console.log(target)
  } else {
    throw new Error('Použitie: npm run access -- setup | reset | backup <súbor>')
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
