import logger from './logger.js'

let queue

function init(options) {
  queue = options.queue
}

async function add(name, cron, handler, options = {}) {
  const qName = `whitebox:scheduler:${name}`
  const bq = queue.createQueue(qName)
  queue.createWorker(qName, handler, options)
  await bq.add(name, {}, { repeat: { cron }, removeOnComplete: true, removeOnFail: false })
  logger.info('Scheduled job added: %s (%s)', name, cron)
}

async function remove(name) {
  const qName = `whitebox:scheduler:${name}`
  const bq = queue.createQueue(qName)
  const repeatableJobs = await bq.getRepeatableJobs()
  for (const job of repeatableJobs) {
    await bq.removeRepeatableByKey(job.key)
  }
  logger.info('Scheduled job removed: %s', name)
}

export { init, add, remove }
