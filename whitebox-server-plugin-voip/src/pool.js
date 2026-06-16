import ms from 'ms'

import * as phonebook from './phonebook.js'

const HOLD_TIMEOUT = process.env.NODE_ENV === 'production' ? ms('60s') : ms('10s')
// Once the user clicks the phone link, the OS may take 5–30s to actually
// place the call (dial UI, contact picker, etc). Hold the number longer.
const CLICKED_HOLD_TIMEOUT = process.env.NODE_ENV === 'production' ? ms('5m') : ms('30s')

let lines, connect, notify, logger

// Module-level state: the visitor pool and per-tag number slots.
let pool = {}
let slots = null

export function init(deps) {
  lines = deps.config.voip.lines
  connect = deps.connect
  notify = deps.notify
  logger = deps.logger

  // Reset state so a re-init (fresh plugin load, or a test) starts clean.
  pool = {}
  slots = null

  connect.onConnected(onConnected)
  connect.onDisconnected(onDisconnected)
  connect.onMessage(onMessage)
}

function buildSlots() {
  slots = {}
  for (const [tag, numbers] of Object.entries(lines)) {
    slots[tag] = { available: numbers.slice(), waiting: [], postponed: [] }
  }
}

function onConnected({ connectionId, passportId, sessionId }) {
  if (!slots) buildSlots()
  pool[connectionId] = {
    connectionId, sessionId, passportId,
    numbers: {}, timeouts: {}, clicked: {},
  }
  logger.debug('Visitor connected: %s', connectionId)
}

function onDisconnected({ connectionId }) {
  const entry = pool[connectionId]
  if (!entry) return
  for (const tag of Object.keys(entry.numbers)) {
    release(connectionId, tag)
  }
  for (const slot of Object.values(slots || {})) {
    slot.waiting = slot.waiting.filter(e => e.connectionId !== connectionId)
  }
  delete pool[connectionId]
  logger.debug('Visitor disconnected: %s', connectionId)
}

function onMessage({ connectionId, event, data }) {
  if (event === 'voip.pick')  assign(connectionId, data?.tag)
  if (event === 'voip.hang')  release(connectionId, data?.tag)
  if (event === 'voip.click') click(connectionId, data?.tag)
}

export function assign(connectionId, tag = 'default') {
  const entry = pool[connectionId]
  if (!entry || entry.numbers[tag]) return

  const slot = slots?.[tag]
  if (!slot) return

  if (!slot.available.length && slot.postponed.length) {
    const evicted = slot.postponed[0]
    logger.debug('Evicting postponed visitor to free number: %s %s', evicted.connectionId, tag)
    release(evicted.connectionId, tag)
  }

  if (slot.available.length) {
    const idx = Math.floor(Math.random() * slot.available.length)
    entry.numbers[tag] = slot.available.splice(idx, 1)[0]

    if (entry.timeouts[tag]) clearTimeout(entry.timeouts[tag])
    entry.timeouts[tag] = setTimeout(() => {
      if (slot.waiting.length) release(connectionId, tag)
      else slot.postponed.push(entry)
    }, HOLD_TIMEOUT)

    const number = entry.numbers[tag]
    const formatted = phonebook.format(number)
    connect.emit(connectionId, 'voip.number', { tag, number, formatted })
    logger.debug('Number assigned: %s %s %s', connectionId, tag, number)
  } else {
    slot.waiting.push(entry)
    connect.emit(connectionId, 'voip.unavailable', { tag })
    logger.debug('No numbers available: %s %s', connectionId, tag)
  }
}

export function release(connectionId, tag = 'default') {
  const entry = pool[connectionId]
  if (!entry || !entry.numbers[tag]) return

  const slot = slots?.[tag]
  if (slot) {
    slot.available.push(entry.numbers[tag])
    slot.postponed = slot.postponed.filter(e => e !== entry)
    if (slot.waiting.length) assign(slot.waiting.pop().connectionId, tag)
  }

  if (entry.timeouts[tag]) { clearTimeout(entry.timeouts[tag]); delete entry.timeouts[tag] }
  delete entry.numbers[tag]
  delete entry.clicked[tag]
}

// User clicked the phone link — strong intent to call. Extend the hold and
// fan out a notify so downstream systems can react in real time.
export function click(connectionId, tag = 'default') {
  const entry = pool[connectionId]
  if (!entry || !entry.numbers[tag]) return

  entry.clicked[tag] = Date.now()

  if (entry.timeouts[tag]) clearTimeout(entry.timeouts[tag])
  entry.timeouts[tag] = setTimeout(() => release(connectionId, tag), CLICKED_HOLD_TIMEOUT)

  logger.debug('Click: %s %s %s', connectionId, tag, entry.numbers[tag])

  notify?.('voip.click', {
    type: 'voip.click',
    data: {
      connectionId,
      passportId: entry.passportId,
      sessionId: entry.sessionId,
      tag,
      number: entry.numbers[tag],
      ts: new Date(),
    },
  }).catch?.(() => {})
}

export function notifyRing(connectionId, context) {
  const entry = pool[connectionId]
  if (!entry || !entry.numbers[context.tag]) return
  connect.emit(connectionId, 'voip.ring', { ...context, number: entry.numbers[context.tag] })
}

export function find(number) {
  for (const entry of Object.values(pool)) {
    for (const [tag, n] of Object.entries(entry.numbers)) {
      if (n === number) {
        return {
          connectionId: entry.connectionId,
          sessionId: entry.sessionId,
          passportId: entry.passportId,
          tag,
          clicked: !!entry.clicked[tag],
        }
      }
    }
  }
  return null
}
