function register(app, { db, redis }) {
  app.get('/health', async (req, res) => {
    const status = { db: 'ok', redis: 'ok' }
    let code = 200

    try {
      await db.raw('SELECT 1')
    } catch {
      status.db = 'error'
      code = 503
    }

    try {
      await redis.ping()
    } catch {
      status.redis = 'error'
      code = 503
    }

    res.status(code).json(status)
  })
}

export { register }
