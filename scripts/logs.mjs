#!/usr/bin/env node
/**
 * TextBot Log Inspector — continuous monitor for /api/diag
 * Usage: node scripts/logs.mjs [--port 3001] [--interval 1000]
 */

const PORT     = process.argv.includes('--port')     ? process.argv[process.argv.indexOf('--port') + 1]     : '3001'
const INTERVAL = process.argv.includes('--interval') ? parseInt(process.argv[process.argv.indexOf('--interval') + 1]) : 1000

// ANSI colours
const C = {
  reset:  '\x1b[0m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  white:  '\x1b[37m',
}

function ts(epochMs) {
  return new Date(epochMs).toLocaleTimeString('en-US', { hour12: false })
}

function colour(msg) {
  if (/error|fail|abort/i.test(msg))   return C.red
  if (/warn|missing|stale|fall.?back/i.test(msg)) return C.yellow
  if (/complete|success|active|ok\b/i.test(msg))  return C.green
  if (/ocr|scanned|extract/i.test(msg))            return C.cyan
  if (/chunk|index|embed/i.test(msg))              return C.blue
  if (/auto-index check/i.test(msg))               return C.dim
  return C.white
}

function formatMsg(msg) {
  // Truncate the [object Object] spam in hasCachedPages
  return msg.replace(/hasCachedPages=(\[object Object\],?)+/, 'hasCachedPages=<pages>')
}

let lastSeen = Date.now() - 10_000   // show last 10s on startup
let firstRun = true

async function poll() {
  try {
    const url = `http://localhost:${PORT}/api/diag?since=${lastSeen}`
    const res  = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const logs = await res.json()

    if (firstRun && logs.length === 0) {
      process.stdout.write(`${C.dim}[log-inspector] connected — waiting for events…${C.reset}\n`)
      firstRun = false
    }

    for (const entry of logs) {
      const time  = ts(entry.t)
      const col   = colour(entry.msg)
      const msg   = formatMsg(entry.msg)
      process.stdout.write(`${C.dim}${time}${C.reset}  ${col}${msg}${C.reset}\n`)
      lastSeen = Math.max(lastSeen, entry.t)
      firstRun = false
    }
  } catch (err) {
    process.stdout.write(`${C.red}[log-inspector] ${err.message} — retrying…${C.reset}\n`)
  }
}

process.stdout.write(`${C.bold}${C.magenta}TextBot Log Inspector${C.reset}  port=${PORT}  interval=${INTERVAL}ms\n`)
process.stdout.write(`${C.dim}${'─'.repeat(60)}${C.reset}\n`)

poll()
const timer = setInterval(poll, INTERVAL)

process.on('SIGINT', () => {
  clearInterval(timer)
  process.stdout.write(`\n${C.dim}[log-inspector] stopped.${C.reset}\n`)
  process.exit(0)
})
