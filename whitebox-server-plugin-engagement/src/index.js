import path from 'path'
import { fileURLToPath } from 'url'

import * as content from './content.js'
import * as sections from './sections.js'
import * as text from './text.js'
import * as videos from './videos.js'
import * as images from './images.js'
import createAuth from 'whitebox-server/auth'

import { createDispatch, KIND_BY_TYPE, batchSchema } from './events.js'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default {
  name: 'engagement',

  async migrate(db) {
    await db.migrate.latest({
      directory: path.join(__dirname, 'migrations'),
      tableName: 'whitebox_engagement_migrations',
    })
  },

  async register(app, ctx) {
    const { config, db, connect, awareness, ai, logger: rootLogger } = ctx
    const logger = rootLogger.child({ plugin: 'engagement' })
    const engagementConfig = config.engagement || {}

    // Singleton modules: capture deps once via init(), in dependency order.
    // content first (sections/text/videos/images import it as a namespace),
    // then the consumers which only need awareness/logger via init.
    content.init({ db, ai, config, logger })
    sections.init({ awareness, logger })
    text.init({ awareness, logger })
    videos.init({ awareness, logger })
    images.init({ awareness, logger })

    const requireAuth = createAuth({ secret: engagementConfig.auth?.secret, logger })

    const { dispatch, dispatchBatchEvent } = createDispatch({ sections, text, videos, images, logger })

    // Live events arrive over the existing connect socket. Batched envelope
    // is also supported for high-volume sessions.
    connect.onMessage(async ({ connectionId, event, data }) => {
      const kind = KIND_BY_TYPE[event]
      if (!kind && event !== 'engagement.batch') return

      const visitor = connect.find(connectionId)
      if (!visitor?.passportId) return

      if (event === 'engagement.batch') {
        const parsed = batchSchema.safeParse(data)
        if (!parsed.success) {
          logger.warn({ err: parsed.error }, 'engagement.batch validation failed')
          return
        }
        for (const e of parsed.data.events) await dispatchBatchEvent(visitor, e)
        return
      }
      await dispatch(visitor, kind, data)
    })

    mountRoutes(app, { db, content, dispatchBatchEvent, requireAuth })
    registerMcp(ctx, { db, content })

    logger.info('Engagement plugin ready')
  },
}
