import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import logger from './logger.js'

const requireFromCwd = createRequire(process.cwd() + '/')

async function resolve(name) {
  // Plugins ship as separate npm packages named `whitebox-server-plugin-<name>`
  // and are discovered by walking the consumer's node_modules. With npm
  // workspaces, sibling packages are symlinked into the root node_modules
  // automatically, so development and production use the same code path.
  const pkg = `whitebox-server-plugin-${name}`
  try {
    const resolved = requireFromCwd.resolve(pkg)
    return (await import(pathToFileURL(resolved).href)).default
  } catch (err) {
    throw new Error(`Plugin "${name}" not found — install ${pkg} (${err.message})`)
  }
}

async function load(app, ctx) {
  for (const name of ctx.config.plugins) {
    logger.info('Loading plugin: %s', name)
    const plugin = await resolve(name)

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
