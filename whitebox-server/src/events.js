import logger from './logger.js'
import { createClient } from './redis.js'

let pub
let sub
const handlers = {}

async function init(options) {
  const cfg = options.config.redis
  pub = createClient(cfg)
  sub = createClient(cfg)

  pub.on('error', err => logger.error({ err }, 'Events pub error'))
  sub.on('error', err => logger.error({ err }, 'Events sub error'))

  await pub.connect()
  await sub.connect()

  sub.on('message', (channel, message) => {
    const fns = handlers[channel]
    if (!fns || !fns.length) return
    let data
    try {
      data = JSON.parse(message)
    } catch {
      logger.warn('Unparseable event on channel: %s', channel)
      return
    }
    fns.forEach(fn => fn(data))
  })

  logger.info('Events bus ready')
}

function publish(channel, data) {
  return pub.publish(channel, JSON.stringify(data))
}

function subscribe(channel, fn) {
  if (!handlers[channel]) {
    handlers[channel] = []
    sub.subscribe(channel)
  }
  handlers[channel].push(fn)
}

function unsubscribe(channel, fn) {
  if (!handlers[channel]) return
  handlers[channel] = handlers[channel].filter(h => h !== fn)
  if (!handlers[channel].length) {
    sub.unsubscribe(channel)
    delete handlers[channel]
  }
}

export { init, publish, subscribe, unsubscribe }
