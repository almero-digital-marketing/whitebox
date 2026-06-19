import crypto from 'crypto'

// Static shared-secret Bearer middleware (the default). Kept as the default
// export so `import createAuth from 'whitebox-pro-server/auth'` is unchanged.
export function createAuth({ secret, logger }) {
  if (!secret) {
    throw new Error('auth secret is required')
  }

  const expected = Buffer.from(secret, 'utf8')

  return function requireAuth(req, res, next) {
    const header = req.get('authorization') || ''
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (!match) {
      logger?.warn?.({ reqId: req.id }, 'Missing bearer auth')
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const presented = Buffer.from(match[1], 'utf8')
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      logger?.warn?.({ reqId: req.id }, 'Invalid bearer auth')
      return res.status(401).json({ error: 'Unauthorized' })
    }

    next()
  }
}

export default createAuth

// ── pluggable auth seam ─────────────────────────────────────────────────────
//
// An auth "verifier" is a provider-agnostic descriptor:
//   { middleware, authorizationServers?, resource?, scopesSupported? }
// The static secret is one verifier (`bearer`); external packages (e.g.
// whitebox-pro-auth-auth0) ship others. Nothing here is provider-specific.

// The static-secret verifier.
export const bearer = (opts) => ({ middleware: createAuth(opts) })

// Normalize whatever `config.mcp.auth` is into a verifier (or null). Accepts:
//   undefined / null          → no auth
//   string                    → bearer secret
//   (req,res,next) => {}        → a bare middleware
//   { middleware, … }          → an already-composed verifier (auth0(), jwt(), …)
//   { secret }                 → bearer secret (legacy shape)
export function resolveMcpAuth(authConfig, { logger } = {}) {
  if (!authConfig) return null
  if (typeof authConfig === 'string') return { middleware: createAuth({ secret: authConfig, logger }) }
  if (typeof authConfig === 'function') return { middleware: authConfig }
  if (typeof authConfig.middleware === 'function') return authConfig
  if (authConfig.secret) return { middleware: createAuth({ secret: authConfig.secret, logger }) }
  return null
}
