import { get as getRedis } from './redis.js'

function key(namespace, k) {
  return `whitebox:cache:${namespace}:${k}`
}

async function get(namespace, k) {
  const raw = await getRedis().get(key(namespace, k))
  if (raw === null) return null
  return JSON.parse(raw)
}

async function set(namespace, k, value, ttlSeconds) {
  const serialized = JSON.stringify(value)
  if (ttlSeconds) {
    await getRedis().set(key(namespace, k), serialized, 'EX', ttlSeconds)
  } else {
    await getRedis().set(key(namespace, k), serialized)
  }
}

async function del(namespace, k) {
  await getRedis().del(key(namespace, k))
}

export { get, set, del }
