import Redlock from 'redlock'
import logger from './logger.js'

let redlock

function init(options) {
  redlock = new Redlock([options.redis], { retryCount: 3, retryDelay: 200 })
  redlock.on('clientError', err => logger.error({ err }, 'Redlock error'))
}

function acquire(resource, ttl) {
  return redlock.lock(`whitebox:lock:${resource}`, ttl)
}

function release(lock) {
  return lock.unlock()
}

export { init, acquire, release }
