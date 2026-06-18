import { Queue, Worker } from 'bullmq'
import logger from './logger.js'

let connection
const queues = {}
const workers = []

// BullMQ v5 forbids ':' in queue names (it's the Redis key separator). Call
// sites use readable names like 'mail:outbox'; map ':' → '-' for the actual
// queue. createQueue and createWorker sanitize identically so they pair up.
const safeName = (name) => name.replace(/:/g, '-')

function init(options) {
  const cfg = options.config.redis
  connection = {
    host: cfg.host,
    port: cfg.port,
    password: cfg.password,
    db: cfg.db || 0,
  }
}

function createQueue(name) {
  if (!queues[name]) {
    queues[name] = new Queue(safeName(name), { connection })
    logger.info('Queue created: %s', safeName(name))
  }
  return queues[name]
}

function createWorker(name, handler, options = {}) {
  const worker = new Worker(safeName(name), handler, { connection, ...options })
  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'Job failed: %s', name))
  worker.on('error', err => logger.error({ err }, 'Worker error: %s', name))
  workers.push(worker)
  logger.info('Worker started: %s', name)
  return worker
}

async function close() {
  await Promise.all(workers.map(w => w.close()))
  await Promise.all(Object.values(queues).map(q => q.close()))
}

export { init, createQueue, createWorker, close }
