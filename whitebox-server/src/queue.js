import { Queue, Worker } from 'bullmq'
import logger from './logger.js'

let connection
const queues = {}
const workers = []

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
    queues[name] = new Queue(name, { connection })
    logger.info('Queue created: %s', name)
  }
  return queues[name]
}

function createWorker(name, handler, options = {}) {
  const worker = new Worker(name, handler, { connection, ...options })
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
