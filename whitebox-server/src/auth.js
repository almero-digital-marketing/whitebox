import crypto from 'crypto'

export default ({ secret, logger }) => {
  if (!secret) {
    throw new Error('auth secret is required')
  }

  const expected = Buffer.from(secret, 'utf8')

  return function requireAuth(req, res, next) {
    const header = req.get('authorization') || ''
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (!match) {
      logger.warn({ reqId: req.id }, 'Missing bearer auth')
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const presented = Buffer.from(match[1], 'utf8')
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      logger.warn({ reqId: req.id }, 'Invalid bearer auth')
      return res.status(401).json({ error: 'Unauthorized' })
    }

    next()
  }
}
