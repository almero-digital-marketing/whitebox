import logger from './logger.js'

const QUEUE_NAME = 'whitebox:webhooks'
let webhookQueue

function init(options) {
  const { concurrency = 5, retries = 3, timeout = 10000 } = options.config.webhooks || {}

  webhookQueue = options.queue.createQueue(QUEUE_NAME)

  options.queue.createWorker(QUEUE_NAME, async job => {
    const { url, method = 'POST', data, headers = {} } = job.data
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: method !== 'GET' ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(timeout),
    })
    if (!response.ok) throw new Error(`Webhook responded ${response.status}: ${url}`)
    logger.debug('Webhook delivered: %s', url)
  }, {
    concurrency,
    defaultJobOptions: {
      attempts: retries,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
    },
  })
}

function send({ url, method, data, headers }) {
  if (!url) return
  return webhookQueue.add('webhook', { url, method, data, headers })
}

export { init, send }
