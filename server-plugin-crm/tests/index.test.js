import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import { crm } from '../src/index.js'

// A minimal ctx — CRM now depends on ctx.facts (structured state) + ctx.awareness
// (notes). state.init wires onto ctx.facts; the context provider reads it back.
function makeCtx({ current = {} } = {}) {
  const ctx = {
    passports: { findByIdentity: vi.fn() },
    facts: { record: vi.fn(), current: vi.fn(async () => current) },
    awareness: { record: vi.fn() },
    context: undefined,
    logger: { child() { return this }, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }
  return ctx
}

describe('crm plugin — context registration', () => {
  it('registers a "crm" provider that returns the passport\'s current facts as key/value rows', async () => {
    const providers = new Map()
    const ctx = makeCtx({ current: { subscription: 'active', plan_tier: 'pro' } })
    ctx.context = { register: vi.fn((name, fn) => providers.set(name, fn)) }

    await crm({ auth: { secret: 's' } }).register(express(), ctx)

    expect(ctx.context.register).toHaveBeenCalledWith('crm', expect.any(Function))
    const result = await providers.get('crm')('p-1')
    expect(result).toEqual([
      { key: 'subscription', value: 'active' },
      { key: 'plan_tier', value: 'pro' },
    ])
    expect(ctx.facts.current).toHaveBeenCalledWith('p-1')
  })

  it('does not throw when context is absent (plugin works without registry)', async () => {
    const ctx = makeCtx()
    await expect(crm({ auth: { secret: 's' } }).register(express(), ctx)).resolves.not.toThrow()
  })
})
