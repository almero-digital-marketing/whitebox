import path from 'path'
import { pathToFileURL } from 'url'

async function load() {
  const configPath = path.join(process.cwd(), 'whitebox.config.js')
  let config
  try {
    const mod = await import(pathToFileURL(configPath).href)
    config = mod.default
  } catch {
    throw new Error(`Cannot load whitebox.config.js from ${process.cwd()}`)
  }

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
