import express from 'express'
import { randomUUID } from 'crypto'
import logger from './logger.js'

function createApp() {
  const app = express()

  app.use(express.json({ limit: '10mb' }))
  app.use(express.urlencoded({ extended: true, limit: '10mb' }))

  app.use((req, res, next) => {
    req.id = randomUUID()
    req.log = logger.child({ reqId: req.id, method: req.method, url: req.url })
    next()
  })

  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500
    const log = req.log || logger
    if (status >= 500) log.error({ err }, 'Unhandled error')
    else log.warn({ err }, 'Request error')
    res.status(status).json({ error: err.message || 'Internal server error' })
  })

  return app
}

export default createApp
