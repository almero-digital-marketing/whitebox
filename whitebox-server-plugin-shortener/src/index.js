// whitebox-server-plugin-shortener
//
// Branded short links on their own host that hide a passport behind an opaque
// code. A personalized link, when clicked, hard-binds the visitor's session to
// that customer — stitching any anonymous browsing history onto them via the
// core passport merge. The passport id never appears in a URL: only the code,
// then a single-use claim token in the redirect.
//
// Factory: shortener({ baseUrl, auth: { secret }, codeLength?, defaultTtlSec?,
//                       identityTtlSec?, claimTtlSec?, param? }).

import path from 'path'
import { fileURLToPath } from 'url'

import createAuth from 'whitebox-server/auth'
import * as store from './store.js'
import * as service from './service.js'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function shortener(options = {}) {
  return {
    name: 'shortener',

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_shortener_migrations',
      })
    },

    async register(app, ctx) {
      const { db, passports, awareness, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'shortener' })

      // The short host is just baseUrl's hostname (one source of truth: it both
      // builds short_url and gates the redirect route).
      const host = options.baseUrl ? new URL(options.baseUrl).hostname : null
      if (!host) logger.warn('shortener: no baseUrl configured — the /:code redirect is disabled')

      const config = {
        baseUrl: options.baseUrl,
        host,
        param: options.param || 'wb',
        codeLength: options.codeLength || 8,
        defaultTtlSec:  options.defaultTtlSec  ?? 60 * 60 * 24 * 30,  // link redirect lifetime
        identityTtlSec: options.identityTtlSec ?? 60 * 60 * 24,        // identity bind window
        claimTtlSec:    options.claimTtlSec    ?? 180,                 // claim-token TTL after a click
      }

      // Bearer guards the management surface only; the redirect + claim are public.
      const requireAuth = options.auth?.secret
        ? createAuth({ secret: options.auth.secret, logger })
        : (req, res) => res.status(401).json({ error: 'shortener: set auth.secret to manage links' })

      store.init({ db })
      service.init({ passports, awareness, logger, config })

      mountRoutes(app, { requireAuth, host, logger })
      registerMcp(ctx, { service })

      logger.info('Shortener plugin ready (%s)', host ? `short host: ${host}` : 'no baseUrl — redirect off')
      return { service }
    },
  }
}
