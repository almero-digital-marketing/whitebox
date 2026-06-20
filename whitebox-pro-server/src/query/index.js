import createAuth from '../auth.js'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'

// The core QUERY surface — REST (/query, /preview) + MCP (whitebox.query,
// whitebox.preview) over the selector engine. Mounted by server.js right after
// the engine is ready, so the query API is a first-class core capability (no
// plugin in the path). See docs/selector.md §13.
//
// register(app, { selector, mcp, config, logger }) — config.query.auth.secret
// gates the REST endpoints (same bearer scheme as the rest of core). Omitting it
// mounts the routes open — dev only, with a loud warning — mirroring the MCP auth
// seam (resolveMcpAuth → null ⇒ no auth). QUERY is an always-on core surface, so
// a missing secret can't be allowed to fail boot.
const OPEN = (req, res, next) => next()

export function register(app, { selector, mcp, config = {}, logger }) {
  const log = logger.child({ component: 'query' })
  const secret = config.query?.auth?.secret
  if (!secret) log.warn('Query surface mounted WITHOUT auth — set config.query.auth.secret (dev only)')
  const requireAuth = secret ? createAuth({ secret, logger: log }) : OPEN

  mountRoutes(app, {
    requireAuth, selector, logger: log,
    queryPath:   config.query?.path        ?? '/query',
    previewPath: config.query?.previewPath ?? '/preview',
  })
  registerMcp({ mcp }, { selector })

  log.info('Query surface ready (REST + MCP)')
}
