import path from 'path'
import { pathToFileURL } from 'url'

async function load(runtime = {}) {
  const configPath = path.join(process.cwd(), 'whitebox.config.js')
  let exported
  try {
    const mod = await import(pathToFileURL(configPath).href)
    exported = mod.default
  } catch {
    throw new Error(`Cannot load whitebox.config.js from ${process.cwd()}`)
  }

  // The config default is an `async (runtime) => ({ port, db, redis, ai, plugins })`
  // factory: each plugin in `plugins` is built at the call site by importing the
  // plugin's factory and calling it with its options (see whitebox.config.example.js).
  // A plain object is still accepted for back-compat.
  const config = typeof exported === 'function' ? await exported(runtime) : exported

  const missing = ['port', 'db', 'redis'].filter(k => !config[k])
  if (missing.length) throw new Error(`whitebox.config.js missing required fields: ${missing.join(', ')}`)

  const dbFields = ['host', 'port', 'database', 'user', 'password'].filter(k => !config.db[k])
  if (dbFields.length) throw new Error(`whitebox.config.js db missing: ${dbFields.join(', ')}`)

  const redisFields = ['host', 'port'].filter(k => !config.redis[k])
  if (redisFields.length) throw new Error(`whitebox.config.js redis missing: ${redisFields.join(', ')}`)

  config.plugins = config.plugins || []
  return config
}

export { load }
