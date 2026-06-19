import { describe, it, expect, vi } from 'vitest'
import * as context from '../src/context.js'

const logger = { warn: vi.fn() }

// context is now an init + module-singleton module. init() rebuilds the
// providers Map, so a fresh init() per test fully resets state.
function createContext(deps) {
  context.init(deps)
  return context
}

describe('core/context', () => {
  it('collects from all registered providers under their names', async () => {
    const ctx = createContext({ logger })
    ctx.register('crm', async (pid) => [{ kind: 'reservation', external_id: 'r1', passport_id: pid }])
    ctx.register('billing', async () => [{ plan: 'pro' }])

    const result = await ctx.collect('p-1')
    expect(result).toEqual({
      crm: [{ kind: 'reservation', external_id: 'r1', passport_id: 'p-1' }],
      billing: [{ plan: 'pro' }],
    })
  })

  it('passes opts (including default limit=20) to providers', async () => {
    const ctx = createContext({ logger })
    const fn = vi.fn(async () => [])
    ctx.register('x', fn)
    await ctx.collect('p-1', { question: 'why?' })
    expect(fn).toHaveBeenCalledWith('p-1', { question: 'why?', limit: 20, offset: 0 })
  })

  it('respects caller-provided limit', async () => {
    const ctx = createContext({ logger })
    const fn = vi.fn(async () => [])
    ctx.register('x', fn)
    await ctx.collect('p-1', { limit: 5 })
    expect(fn).toHaveBeenCalledWith('p-1', { limit: 5, offset: 0 })
  })

  it('isolates provider failures — one throwing does not break others', async () => {
    const ctx = createContext({ logger })
    ctx.register('good', async () => ({ ok: true }))
    ctx.register('bad', async () => { throw new Error('boom') })
    const result = await ctx.collect('p-1')
    expect(result.good).toEqual({ ok: true })
    expect(result.bad).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('returns {} when passportId is falsy', async () => {
    const ctx = createContext({ logger })
    ctx.register('crm', async () => [{ a: 1 }])
    expect(await ctx.collect(null)).toEqual({})
    expect(await ctx.collect(undefined)).toEqual({})
  })

  it('unregister removes a provider', async () => {
    const ctx = createContext({ logger })
    ctx.register('crm', async () => [{ a: 1 }])
    ctx.unregister('crm')
    expect(await ctx.collect('p-1')).toEqual({})
  })

  it('names() returns registered provider names', () => {
    const ctx = createContext({ logger })
    ctx.register('a', async () => null)
    ctx.register('b', async () => null)
    expect(ctx.names().sort()).toEqual(['a', 'b'])
  })

  it('rejects invalid registrations', () => {
    const ctx = createContext({ logger })
    expect(() => ctx.register('', async () => null)).toThrow()
    expect(() => ctx.register('x', 'not-a-fn')).toThrow()
  })

  it('opts.providers restricts which providers run', async () => {
    const ctx = createContext({ logger })
    const a = vi.fn(async () => 'a')
    const b = vi.fn(async () => 'b')
    ctx.register('a', a)
    ctx.register('b', b)
    const result = await ctx.collect('p-1', { providers: ['a'] })
    expect(result).toEqual({ a: 'a' })
    expect(b).not.toHaveBeenCalled()
  })

  it('unknown providers in opts.providers are silently skipped at registry level', async () => {
    // The HTTP layer 400s on unknowns; the registry itself just filters.
    const ctx = createContext({ logger })
    ctx.register('a', async () => 'a')
    const result = await ctx.collect('p-1', { providers: ['a', 'ghost'] })
    expect(result).toEqual({ a: 'a' })
  })

  it('passes offset (default 0) to providers for paging', async () => {
    const ctx = createContext({ logger })
    const fn = vi.fn(async () => [])
    ctx.register('x', fn)
    await ctx.collect('p-1', { limit: 5, offset: 10 })
    expect(fn).toHaveBeenCalledWith('p-1', expect.objectContaining({ limit: 5, offset: 10 }))
    await ctx.collect('p-1', { limit: 5 })
    expect(fn).toHaveBeenLastCalledWith('p-1', expect.objectContaining({ offset: 0 }))
  })

  it('warns but overwrites when re-registering same name', async () => {
    const ctx = createContext({ logger })
    ctx.register('crm', async () => 'first')
    ctx.register('crm', async () => 'second')
    expect(logger.warn).toHaveBeenCalled()
    const result = await ctx.collect('p-1')
    expect(result.crm).toBe('second')
  })
})
