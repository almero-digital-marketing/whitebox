import logger from './logger.js'

// Plugins are built in whitebox.config.js — each plugin package exports a named
// factory (`engagement`, `crm`, …) that is imported there and called with its
// options, producing a `{ name, register, migrate? }` object. By the time we get
// here, `ctx.config.plugins` is already an array of those built objects, so the
// loader just runs each one in order. (No dynamic name → package resolution —
// the config file's `import` statements are the explicit, checkable manifest.)
async function load(app, ctx) {
  for (const plugin of ctx.config.plugins) {
    if (!plugin || typeof plugin.register !== 'function') {
      throw new Error(`Invalid entry in config.plugins — expected a plugin factory result { name, register }, got ${typeof plugin}. Did you forget to call the factory, e.g. engagement({ ... })?`)
    }
    const name = plugin.name || '(unnamed)'
    logger.info('Loading plugin: %s', name)

    if (plugin.migrate) {
      await plugin.migrate(ctx.db)
      logger.info('Migrations done: %s', name)
    }

    const api = await plugin.register(app, ctx)
    if (api) ctx.plugins[name] = api
    logger.info('Plugin ready: %s', name)
  }
}

export { load }
