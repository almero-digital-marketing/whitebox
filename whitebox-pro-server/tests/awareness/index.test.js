import { describe, it, expect, vi } from 'vitest'
import * as awareness from '../../src/awareness/index.js'

// awareness is now an init + module-singleton module. Re-init fully resets its
// composed store/memory/query state, so per-test isolation holds.
function createAwareness(deps) {
  awareness.init(deps)
  return awareness
}

function makeDeps({ enabled, redactPii, webhooksConfig, insertedExposure } = {}) {
  const exposures = []
  let nextId = 1

  const db = (table) => ({
    insert: data => ({
      returning: async () => {
        const row = { id: nextId++, ...data }
        exposures.push(row)
        return [row]
      },
    }),
    where: (cond) => ({
      first: async () => exposures.find(e => Object.entries(cond).every(([k, v]) => e[k] === v)) || null,
      del: async () => {
        const before = exposures.length
        for (let i = exposures.length - 1; i >= 0; i--) {
          if (Object.entries(cond).every(([k, v]) => exposures[i][k] === v)) {
            exposures.splice(i, 1)
          }
        }
        return before - exposures.length
      },
    }),
  })
  db.migrate = { latest: vi.fn(async () => {}) }
  db.raw = (sql, params) => {
    // Simulate gcOrphanChunks: orphan chunk count is just 0 for these tests
    if (sql.includes('DELETE FROM') && sql.includes('NOT IN')) {
      return { rowCount: 0 }
    }
    return { __raw: sql, __params: params, rowCount: 0 }
  }

  const events = { publish: vi.fn(async () => {}) }
  const webhooks = { send: vi.fn(async () => {}) }
  const ai = { embed: vi.fn(async texts => texts.map(() => [0.1])) }
  const queue = {
    createQueue: vi.fn(() => ({ add: vi.fn(async () => {}) })),
    createWorker: vi.fn(() => ({ on: vi.fn() })),
  }
  const logger = { child: () => logger, debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }
  const config = {
    awareness: {
      enabled,
      pii: { redact: redactPii },
      webhooks: webhooksConfig,
    },
  }

  return { db, queue, ai, events, webhooks, config, logger, exposures }
}

describe('awareness factory', () => {

  it('record inserts exposure and enqueues embedding', async () => {
    const deps = makeDeps()
    const aw = createAwareness(deps)

    const out = await aw.record({
      passport_id: 'p1',
      ts: new Date(),
      channel: 'mail',
      direction: 'exposure',
      source: 'email',
      text: 'Hello world',
    })

    expect(out).toBeTruthy()
    expect(out.passport_id).toBe('p1')
    expect(deps.exposures).toHaveLength(1)
  })

  it('record returns null when disabled', async () => {
    const deps = makeDeps({ enabled: false })
    const aw = createAwareness(deps)

    const out = await aw.record({
      passport_id: 'p1',
      ts: new Date(),
      channel: 'mail',
      direction: 'exposure',
      text: 'Hello',
    })
    expect(out).toBeNull()
    expect(deps.exposures).toHaveLength(0)
  })

  it('record rejects missing required fields', async () => {
    const deps = makeDeps()
    const aw = createAwareness(deps)

    // missing channel
    const out = await aw.record({
      passport_id: 'p1',
      ts: new Date(),
      direction: 'exposure',
      text: 'Hello',
    })
    expect(out).toBeNull()
    expect(deps.exposures).toHaveLength(0)
  })

  it('record redacts PII by default', async () => {
    const deps = makeDeps()
    const aw = createAwareness(deps)

    await aw.record({
      passport_id: 'p1',
      ts: new Date(),
      channel: 'mail',
      direction: 'exposure',
      text: 'Card 4111111111111111 expires soon',
    })
    expect(deps.exposures[0].text).toContain('[REDACTED-CC]')
    expect(deps.exposures[0].text).not.toContain('4111111111111111')
  })

  it('record can disable PII redaction via config', async () => {
    const deps = makeDeps({ redactPii: false })
    const aw = createAwareness(deps)

    await aw.record({
      passport_id: 'p1',
      ts: new Date(),
      channel: 'mail',
      direction: 'exposure',
      text: 'Card 4111111111111111 expires soon',
    })
    expect(deps.exposures[0].text).toContain('4111111111111111')
  })

  it('record computes content_hash from text (after PII redaction)', async () => {
    const deps = makeDeps()
    const aw = createAwareness(deps)

    await aw.record({
      passport_id: 'p1', ts: new Date(),
      channel: 'mail', direction: 'exposure', text: 'Hello world',
    })
    await aw.record({
      passport_id: 'p2', ts: new Date(),
      channel: 'mail', direction: 'exposure', text: 'Hello world',
    })
    await aw.record({
      passport_id: 'p3', ts: new Date(),
      channel: 'mail', direction: 'exposure', text: 'Different content',
    })

    // Same text → same hash; different text → different hash
    expect(deps.exposures[0].content_hash).toBe(deps.exposures[1].content_hash)
    expect(deps.exposures[0].content_hash).not.toBe(deps.exposures[2].content_hash)
    expect(deps.exposures[0].content_hash).toMatch(/^[0-9a-f]{64}$/)  // sha256 hex
  })

  it('content_hash hashes redacted text (not raw)', async () => {
    const deps = makeDeps()
    const aw = createAwareness(deps)

    // Two different CCs that redact to the same string
    await aw.record({
      passport_id: 'p1', ts: new Date(),
      channel: 'mail', direction: 'exposure', text: 'Card 4111111111111111',
    })
    await aw.record({
      passport_id: 'p2', ts: new Date(),
      channel: 'mail', direction: 'exposure', text: 'Card 4222222222222222',
    })

    // Both redact to "Card [REDACTED-CC]" → same hash
    expect(deps.exposures[0].content_hash).toBe(deps.exposures[1].content_hash)
  })

  it('record fires awareness.recorded notify event', async () => {
    const deps = makeDeps()
    const aw = createAwareness(deps)

    await aw.record({
      passport_id: 'p1',
      ts: new Date(),
      channel: 'mail',
      direction: 'exposure',
      source: 'email',
      content_id: 'outbox:7',
      text: 'Hello',
    })

    // notify uses events.publish internally
    expect(deps.events.publish).toHaveBeenCalledWith(
      'awareness.recorded',
      expect.objectContaining({
        type: 'awareness.recorded',
        data: expect.objectContaining({ passport_id: 'p1', channel: 'mail' }),
      })
    )
  })

  it('forget deletes exposures and notifies', async () => {
    const deps = makeDeps()
    const aw = createAwareness(deps)

    await aw.record({ passport_id: 'p1', ts: new Date(), channel: 'web', direction: 'exposure', text: 'a' })
    await aw.record({ passport_id: 'p1', ts: new Date(), channel: 'mail', direction: 'expression', text: 'b' })
    await aw.record({ passport_id: 'p2', ts: new Date(), channel: 'web', direction: 'exposure', text: 'c' })

    const deleted = await aw.forget({ passport_id: 'p1' })
    expect(deleted).toBe(2)
    expect(deps.events.publish).toHaveBeenCalledWith(
      'awareness.forgotten',
      expect.objectContaining({
        data: expect.objectContaining({ passport_id: 'p1', deleted_count: 2 }),
      })
    )
  })

  it('forget runs orphan-chunk GC and reports count', async () => {
    const deps = makeDeps()
    // Override raw to simulate 3 orphan chunks deleted
    deps.db.raw = (sql) => {
      if (sql.includes('DELETE FROM') && sql.includes('NOT IN')) return { rowCount: 3 }
      return { rowCount: 0 }
    }
    const aw = createAwareness(deps)

    await aw.record({ passport_id: 'p1', ts: new Date(), channel: 'web', direction: 'exposure', text: 'a' })
    await aw.forget({ passport_id: 'p1' })

    expect(deps.events.publish).toHaveBeenCalledWith(
      'awareness.forgotten',
      expect.objectContaining({
        data: expect.objectContaining({ orphan_chunks_deleted: 3 }),
      })
    )
  })

  it('forget returns 0 when disabled', async () => {
    const deps = makeDeps({ enabled: false })
    const aw = createAwareness(deps)
    const deleted = await aw.forget({ passport_id: 'p1' })
    expect(deleted).toBe(0)
  })

  it('recall/population/timeline return empty when disabled', async () => {
    const deps = makeDeps({ enabled: false })
    const aw = createAwareness(deps)
    expect(await aw.recall({ passport_id: 'p1', query: 'x' })).toEqual([])
    expect(await aw.population({ query: 'x' })).toEqual({ count: 0, passports: [] })
    expect(await aw.timeline({ passport_id: 'p1' })).toEqual([])
  })

  it('migrate calls knex migrate.latest with awareness table name', async () => {
    const deps = makeDeps()
    const aw = createAwareness(deps)
    await aw.migrate()
    expect(deps.db.migrate.latest).toHaveBeenCalledWith(expect.objectContaining({
      tableName: 'whitebox_awareness_migrations',
    }))
  })
})
