import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const isWindows = process.platform === 'win32'
const npm = isWindows ? 'npm.cmd' : 'npm'

const [parserRunning, crmRunning] = await Promise.all([portIsOccupied(43127), portIsOccupied(5173)])
if (parserRunning || crmRunning) {
  if (parserRunning && crmRunning) {
    console.log('Порты CRM и локального парсера уже заняты. Если это запущенный CRM, откройте http://localhost:5173 — повторный запуск не нужен.')
    console.log('Для перезапуска сначала остановите прежний npm run dev:connected через Ctrl+C в его терминале.')
  } else {
    console.error(`Порт ${parserRunning ? 'парсера (43127)' : 'CRM (5173)'} уже занят. Остановите прежний процесс перед совместным запуском.`)
  }
  process.exit(parserRunning && crmRunning ? 0 : 1)
}

console.log('Building the local parser...')
execFileSync(npm, ['--prefix', 'local-parser', 'run', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: isWindows,
})

const token = randomBytes(32).toString('base64url')
const parser = spawn(process.execPath, ['local-parser/dist/local-parser/src/server.js'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PARSER_PAIRING_TOKEN: token, PARSER_PRINT_PAIRING_TOKEN: 'false' },
})
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_LOCAL_PARSER_TOKEN: token },
})

let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  parser.kill()
  vite.kill()
  process.exitCode = code
}

parser.once('error', (error) => { console.error('Local parser failed to start:', error); shutdown(1) })
vite.once('error', (error) => { console.error('Vite failed to start:', error); shutdown(1) })
parser.once('exit', (code) => { if (!shuttingDown) shutdown(code ?? 1) })
vite.once('exit', (code) => { if (!shuttingDown) shutdown(code ?? 1) })
process.once('SIGINT', () => shutdown(0))
process.once('SIGTERM', () => shutdown(0))

function portIsOccupied(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (occupied) => { socket.destroy(); resolve(occupied) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1000, () => finish(true))
  })
}
