import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import { crm } from '../src/index.js'

describe('crm plugin — context registration', () => {
  it('registers a "crm" provider that returns records for a passport', async () => {
    const sampleRows = [
      { id: 1, source: 'booking', kind: 'reservation', external_id: 'r1', status: 'confirmed',
        starts_at: new Date('2026-06-12T14:00:00Z'), data: { room: 'suite' },
        passport_id: 'p-1', created_at: new Date(), updated_at: new Date() },
    ]

    // Minimal stand-ins — the plugin shouldn't reach into anything we don't provide
    const providers = new Map()
    const context = {
      register: vi.fn((name, fn) => providers.set(name, fn)),
    }

    // db is only touched if our provider is invoked; stub returns sampleRows.
    // The plugin calls records.init({ db }), so the records data layer runs
    // against this stub. Simpler than mocking the module: spy through db().
    // Knex chain: where().orderBy().limit().offset() — also supports andWhere
    function chain(result) {
      const c = {
        orderBy() { return c },
        limit() { return c },
        offset() { return Promise.resolve(result) },
        andWhere() { return c },
      }
      return c
    }
    const where = vi.fn(() => chain(sampleRows))
    const db = vi.fn(() => ({ where }))

    const ctx = {
      db,
      passports: { findByIdentity: vi.fn() },
      awareness: { record: vi.fn() },
      context,
      logger: { child: () => ctx.logger, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }

    await crm({ auth: { secret: 's' } }).register(express(), ctx)

    expect(context.register).toHaveBeenCalledWith('crm', expect.any(Function))
    const provider = providers.get('crm')
    const result = await provider('p-1', { limit: 10 })

    // Provider returns a compact shape — no id/created_at/passport_id fields
    expect(result).toEqual([{
      source: 'booking',
      kind: 'reservation',
      external_id: 'r1',
      status: 'confirmed',
      starts_at: sampleRows[0].starts_at,
      data: { room: 'suite' },
    }])
  })

  it('does not throw when context is absent (plugin works without registry)', async () => {
    const ctx = {
      db: vi.fn(() => ({
        where: () => {
          const c = { orderBy() { return c }, limit() { return c }, offset() { return Promise.resolve([]) }, andWhere() { return c } }
          return c
        },
      })),
      passports: { findByIdentity: vi.fn() },
      awareness: { record: vi.fn() },
      // context: undefined  ← intentionally missing
      logger: { child() { return this }, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }
    await expect(crm({ auth: { secret: 's' } }).register(express(), ctx)).resolves.not.toThrow()
  })
})
