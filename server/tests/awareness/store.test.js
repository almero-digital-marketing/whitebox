import { describe, it, expect, vi } from 'vitest'
import * as store from '../../src/awareness/store.js'

// store is now an init + module-singleton module. init({ db }) per test rebinds
// the module-level db to that test's mock, giving each test fresh state.
function createStore({ db }) {
  store.init({ db })
  return store
}

// Chainable + awaitable mock — accumulates filters; materializes on await or first/del.
// Also supports basic JOIN via a separate `join()` recognizer used by recallChunks.
function makeDb() {
  const stores = {
    whitebox_awareness_exposures: [],
    whitebox_awareness_chunks: [],
    whitebox_sessions: [],
  }
  const calls = []
  const rawCalls = []
  let nextId = 1

  function tableFromAlias(alias) {
    // 'whitebox_awareness_chunks as c' → real table
    return alias.split(' ')[0]
  }

  function chain(spec) {
    const filters = []
    let limitN = null
    const joinSpecs = []

    const c = {
      where: (...args) => {
        if (args.length === 1 && typeof args[0] === 'object') {
          const cond = args[0]
          filters.push(r => Object.entries(cond).every(([k, v]) => valueAt(r, k) === v))
        } else if (args.length === 2) {
          filters.push(r => valueAt(r, args[0]) === args[1])
        } else if (args.length === 3) {
          const [col, op, val] = args
          filters.push(r => {
            if (op === '>=') return valueAt(r, col) >= val
            if (op === '<=') return valueAt(r, col) <= val
            if (op === '=') return valueAt(r, col) === val
            return false
          })
        }
        return c
      },
      whereIn: (col, vals) => {
        filters.push(r => vals.includes(valueAt(r, col)))
        return c
      },
      orderBy: () => c,
      orderByRaw: (sql, params) => {
        calls.push({ op: 'orderByRaw', sql, params })
        return c
      },
      select: () => c,
      limit: (n) => { limitN = n; return c },
      first: async () => materialize()[0] || null,
      del: async () => {
        const rows = stores[spec.table]
        let removed = 0
        for (let i = rows.length - 1; i >= 0; i--) {
          if (filters.every(f => f(rows[i]))) { rows.splice(i, 1); removed++ }
        }
        return removed
      },
      insert: (data) => {
        const arr = Array.isArray(data) ? data : [data]
        const inserted = arr.map(d => ({ id: nextId++, ...d }))
        stores[spec.table].push(...inserted)
        return {
          returning: async () => inserted,
          onConflict: () => ({
            ignore: async () => inserted,
            merge: () => ({ returning: async () => inserted }),
          }),
        }
      },
      join: (otherAlias, leftCol, rightCol) => {
        joinSpecs.push({ otherAlias, leftCol, rightCol, kind: 'inner' })
        return c
      },
      leftJoin: (otherAlias, leftCol, rightCol) => {
        joinSpecs.push({ otherAlias, leftCol, rightCol, kind: 'left' })
        return c
      },
      then: (resolve, reject) => {
        try { resolve(materialize()) }
        catch (err) { reject(err) }
      },
    }

    function valueAt(row, col) {
      // Strip alias prefix if present: 'e.passport_id' → 'passport_id'
      const bare = col.includes('.') ? col.split('.')[1] : col
      return row[bare]
    }

    function materialize() {
      let rows = stores[spec.table]

      for (const j of joinSpecs) {
        const otherTable = tableFromAlias(j.otherAlias)
        const otherRows = stores[otherTable] || []
        // Resolve which column belongs to the joining table vs existing rows
        const otherAliasShort = j.otherAlias.split(/\s+as\s+/i).pop()
        const leftAlias = j.leftCol.split('.')[0]
        const leftBare = j.leftCol.split('.')[1]
        const rightBare = j.rightCol.split('.')[1]
        const otherCol = leftAlias === otherAliasShort ? leftBare : rightBare
        const baseCol = leftAlias === otherAliasShort ? rightBare : leftBare

        const joined = []
        for (const a of rows) {
          let matched = false
          for (const b of otherRows) {
            if (a[baseCol] === b[otherCol]) {
              joined.push({ ...a, ...b })
              matched = true
            }
          }
          if (!matched && j.kind === 'left') {
            joined.push({ ...a })  // preserve row, joined fields undefined
          }
        }
        rows = joined
      }

      let result = rows.filter(r => filters.every(f => f(r)))
      if (limitN != null) result = result.slice(0, limitN)
      return result
    }

    return c
  }

  const db = (tableAlias) => {
    const table = tableFromAlias(tableAlias)
    if (!stores[table]) stores[table] = []
    return chain({ table, alias: tableAlias })
  }

  db.raw = (sql, params) => {
    rawCalls.push({ sql, params })

    // Simulate gcOrphanChunks
    if (sql.includes('DELETE FROM') && sql.includes('NOT IN')) {
      const referenced = new Set(
        stores.whitebox_awareness_exposures
          .map(e => e.content_hash)
          .filter(Boolean)
      )
      const before = stores.whitebox_awareness_chunks.length
      stores.whitebox_awareness_chunks = stores.whitebox_awareness_chunks
        .filter(c => referenced.has(c.content_hash))
      return { rowCount: before - stores.whitebox_awareness_chunks.length }
    }

    // Simulate recallChunks: collapse each content_hash to its most-recent
    // exposure for the passport, then one row per chunk of those hashes.
    if (sql.includes('DISTINCT ON (content_hash)')) {
      const passportId = params[1]
      // params tail is now [..., limit, offset] (LIMIT ? OFFSET ?)
      const offset = params[params.length - 1] || 0
      const limit = params[params.length - 2]

      const byHash = new Map()  // content_hash → most-recent exposure
      for (const e of stores.whitebox_awareness_exposures) {
        if (e.passport_id !== passportId) continue
        const prev = byHash.get(e.content_hash)
        if (!prev || (e.ts ?? 0) > (prev.ts ?? 0)) byHash.set(e.content_hash, e)
      }

      const rows = []
      for (const c of stores.whitebox_awareness_chunks) {
        const e = byHash.get(c.content_hash)
        if (!e) continue
        const s = stores.whitebox_sessions.find(s => s.id === e.session_id) || {}
        rows.push({
          id: c.id,
          content_hash: c.content_hash,
          chunk_text: c.chunk_text,
          ts: e.ts,
          passport_id: e.passport_id,
          channel: e.channel,
          direction: e.direction,
          source: e.source ?? null,
          content_id: e.content_id ?? null,
          content_url: e.content_url ?? null,
          utm_source: s.utm_source ?? null,
          utm_medium: s.utm_medium ?? null,
          utm_campaign: s.utm_campaign ?? null,
          utm_term: s.utm_term ?? null,
          utm_content: s.utm_content ?? null,
          referrer: s.referrer ?? null,
          similarity: 0.9,
        })
      }
      return { rows: limit != null ? rows.slice(offset, offset + limit) : rows.slice(offset) }
    }

    // Simulate population CTE: find matching chunks + join exposures + leftJoin sessions
    if (sql.includes('WITH matches AS')) {
      const rows = stores.whitebox_awareness_chunks.map(c => ({
        ...c,
        similarity: 0.9,  // mock similarity
      }))
      const joined = []
      for (const m of rows) {
        for (const e of stores.whitebox_awareness_exposures) {
          if (e.content_hash !== m.content_hash) continue
          const s = stores.whitebox_sessions.find(s => s.id === e.session_id) || {}
          joined.push({
            passport_id: e.passport_id,
            chunk_text: m.chunk_text,
            similarity: m.similarity,
            ts: e.ts,
            channel: e.channel,
            direction: e.direction,
            source: e.source,
            utm_source: s.utm_source ?? null,
            utm_medium: s.utm_medium ?? null,
            utm_campaign: s.utm_campaign ?? null,
            utm_term: s.utm_term ?? null,
            utm_content: s.utm_content ?? null,
            referrer: s.referrer ?? null,
          })
        }
      }
      const seen = new Set()
      const unique = joined.filter(r => {
        const k = `${r.passport_id}|${r.chunk_text}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      return { rows: unique }
    }

    return { __raw: sql, __params: params, rowCount: 0 }
  }

  db.store = stores
  db.calls = calls
  db.rawCalls = rawCalls
  return db
}

describe('awareness.store — exposures', () => {

  it('insertExposure returns row with id', async () => {
    const db = makeDb()
    const store = createStore({ db })
    const row = await store.insertExposure({
      passport_id: 'p1', ts: new Date(), channel: 'web',
      direction: 'exposure', text: 'hello', content_hash: 'h1',
    })
    expect(row.id).toBeDefined()
    expect(row.passport_id).toBe('p1')
    expect(db.store.whitebox_awareness_exposures).toHaveLength(1)
  })

  it('findExposure by id', async () => {
    const db = makeDb()
    const store = createStore({ db })
    const inserted = await store.insertExposure({ passport_id: 'p1', text: 'hi', channel: 'web', direction: 'exposure', content_hash: 'h1' })
    const found = await store.findExposure(inserted.id)
    expect(found?.text).toBe('hi')
  })

  it('deletePassport removes all exposures for that passport', async () => {
    const db = makeDb()
    const store = createStore({ db })
    await store.insertExposure({ passport_id: 'p1', text: 'a', channel: 'web', direction: 'exposure', content_hash: 'h1' })
    await store.insertExposure({ passport_id: 'p1', text: 'b', channel: 'web', direction: 'exposure', content_hash: 'h2' })
    await store.insertExposure({ passport_id: 'p2', text: 'c', channel: 'web', direction: 'exposure', content_hash: 'h3' })

    const deleted = await store.deletePassport('p1')
    expect(deleted).toBe(2)
    expect(db.store.whitebox_awareness_exposures).toHaveLength(1)
    expect(db.store.whitebox_awareness_exposures[0].passport_id).toBe('p2')
  })

  it('timeline filters by passport and channel', async () => {
    const db = makeDb()
    const store = createStore({ db })
    await store.insertExposure({ passport_id: 'p1', ts: new Date(), channel: 'mail', direction: 'exposure', text: 'a', content_hash: 'h1' })
    await store.insertExposure({ passport_id: 'p1', ts: new Date(), channel: 'voip', direction: 'conversation', text: 'b', content_hash: 'h2' })
    await store.insertExposure({ passport_id: 'p2', ts: new Date(), channel: 'web', direction: 'exposure', text: 'c', content_hash: 'h3' })

    const rows = await store.timeline({ passport_id: 'p1', channels: ['mail'] })
    expect(rows).toHaveLength(1)
    expect(rows[0].channel).toBe('mail')
  })
})

describe('awareness.store — chunks (shared by content_hash)', () => {

  it('insertChunks writes one row per chunk with shared content_hash', async () => {
    const db = makeDb()
    const store = createStore({ db })
    await store.insertChunks('hash-A', [
      { text: 'first', embedding: [0.1, 0.2] },
      { text: 'second', embedding: [0.3, 0.4] },
    ])
    const chunks = db.store.whitebox_awareness_chunks
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({
      content_hash: 'hash-A',
      chunk_index: 0,
      chunk_text: 'first',
      embedding: '[0.1,0.2]',
    })
    expect(chunks[1]).toMatchObject({
      chunk_index: 1,
      chunk_text: 'second',
    })
  })

  it('insertChunks is no-op on empty input', async () => {
    const db = makeDb()
    const store = createStore({ db })
    await store.insertChunks('hash-A', [])
    expect(db.store.whitebox_awareness_chunks).toHaveLength(0)
  })

  it('hasChunks returns true when any chunk exists for the hash', async () => {
    const db = makeDb()
    const store = createStore({ db })
    expect(await store.hasChunks('hash-A')).toBe(false)
    await store.insertChunks('hash-A', [{ text: 'x', embedding: [0.1] }])
    expect(await store.hasChunks('hash-A')).toBe(true)
    expect(await store.hasChunks('hash-B')).toBe(false)
  })

  it('hasChunks returns false for null/undefined hash', async () => {
    const db = makeDb()
    const store = createStore({ db })
    expect(await store.hasChunks(null)).toBe(false)
    expect(await store.hasChunks(undefined)).toBe(false)
  })
})

describe('awareness.store — gcOrphanChunks', () => {

  it('deletes chunks whose content_hash has no exposure', async () => {
    const db = makeDb()
    const store = createStore({ db })

    // Two exposures, one content_hash each
    await store.insertExposure({ passport_id: 'p1', ts: new Date(), channel: 'web', direction: 'exposure', text: 'a', content_hash: 'h1' })
    await store.insertExposure({ passport_id: 'p2', ts: new Date(), channel: 'web', direction: 'exposure', text: 'b', content_hash: 'h2' })

    // Chunks for both, plus an orphan hash
    await store.insertChunks('h1', [{ text: 'x', embedding: [0.1] }])
    await store.insertChunks('h2', [{ text: 'y', embedding: [0.2] }])
    await store.insertChunks('h3', [{ text: 'z', embedding: [0.3] }])  // orphan
    expect(db.store.whitebox_awareness_chunks).toHaveLength(3)

    const gc = await store.gcOrphanChunks()
    expect(gc).toBe(1)
    expect(db.store.whitebox_awareness_chunks).toHaveLength(2)
    expect(db.store.whitebox_awareness_chunks.map(c => c.content_hash).sort()).toEqual(['h1', 'h2'])
  })

  it('preserves chunks still referenced by another passport', async () => {
    const db = makeDb()
    const store = createStore({ db })

    // Alice and Bob both received the same email
    await store.insertExposure({ passport_id: 'alice', ts: new Date(), channel: 'mail', direction: 'exposure', text: 'newsletter', content_hash: 'shared' })
    await store.insertExposure({ passport_id: 'bob', ts: new Date(), channel: 'mail', direction: 'exposure', text: 'newsletter', content_hash: 'shared' })
    await store.insertChunks('shared', [{ text: 'newsletter content', embedding: [0.1] }])

    // Alice asks to be forgotten
    await store.deletePassport('alice')
    const gc = await store.gcOrphanChunks()
    expect(gc).toBe(0)  // bob still references this hash
    expect(db.store.whitebox_awareness_chunks).toHaveLength(1)

    // Bob also leaves
    await store.deletePassport('bob')
    const gc2 = await store.gcOrphanChunks()
    expect(gc2).toBe(1)
    expect(db.store.whitebox_awareness_chunks).toHaveLength(0)
  })
})

describe('awareness.store — query shape', () => {

  it('recallChunks joins exposures via content_hash and filters by passport', async () => {
    const db = makeDb()
    const store = createStore({ db })

    await store.insertExposure({ passport_id: 'p1', ts: new Date(), channel: 'web', direction: 'exposure', text: 'a', content_hash: 'h1' })
    await store.insertExposure({ passport_id: 'p2', ts: new Date(), channel: 'web', direction: 'exposure', text: 'b', content_hash: 'h2' })
    await store.insertChunks('h1', [{ text: 'first', embedding: [0.1] }])
    await store.insertChunks('h2', [{ text: 'second', embedding: [0.2] }])

    const hits = await store.recallChunks({ passport_id: 'p1', embedding: [0.5], limit: 10 })
    expect(hits).toHaveLength(1)
    expect(hits[0].chunk_text).toBe('first')

    // Recall issues a single vector-distance-ordered raw query
    const recallRaw = db.rawCalls.find(c => c.sql.includes('DISTINCT ON (content_hash)'))
    expect(recallRaw.sql).toContain('<=>')
  })

  it('recallChunks returns each chunk once even when the passport saw it multiple times', async () => {
    // Regression: a chunk⋈exposure join without dedup would emit the same chunk
    // once per exposure, crowding the top-K. Alice opened the same email 3×.
    const db = makeDb()
    const store = createStore({ db })

    await store.insertExposure({ passport_id: 'alice', ts: new Date('2026-01-01'), channel: 'mail', direction: 'exposure', text: 'promo', content_hash: 'shared' })
    await store.insertExposure({ passport_id: 'alice', ts: new Date('2026-01-05'), channel: 'mail', direction: 'exposure', text: 'promo', content_hash: 'shared' })
    await store.insertExposure({ passport_id: 'alice', ts: new Date('2026-01-09'), channel: 'mail', direction: 'exposure', text: 'promo', content_hash: 'shared' })
    await store.insertChunks('shared', [{ text: 'promo content', embedding: [0.1] }])

    const hits = await store.recallChunks({ passport_id: 'alice', embedding: [0.5], limit: 10 })
    expect(hits).toHaveLength(1)                       // not 3
    expect(hits[0].chunk_text).toBe('promo content')
    // Carries the most-recent exposure's timestamp
    expect(new Date(hits[0].ts).toISOString()).toBe(new Date('2026-01-09').toISOString())
  })

  it('recallChunks dedupes per chunk across a multi-chunk document seen twice', async () => {
    const db = makeDb()
    const store = createStore({ db })

    await store.insertExposure({ passport_id: 'p1', ts: new Date('2026-02-01'), channel: 'web', direction: 'exposure', text: 'doc', content_hash: 'doc-hash' })
    await store.insertExposure({ passport_id: 'p1', ts: new Date('2026-02-02'), channel: 'web', direction: 'exposure', text: 'doc', content_hash: 'doc-hash' })
    await store.insertChunks('doc-hash', [
      { text: 'chunk one', embedding: [0.1] },
      { text: 'chunk two', embedding: [0.2] },
    ])

    const hits = await store.recallChunks({ passport_id: 'p1', embedding: [0.5], limit: 10 })
    expect(hits).toHaveLength(2)                       // 2 chunks, not 4
    expect(hits.map(h => h.chunk_text).sort()).toEqual(['chunk one', 'chunk two'])
  })

  it('recallChunks LEFT JOINs sessions and projects UTM fields', async () => {
    const db = makeDb()
    const store = createStore({ db })

    db.store.whitebox_sessions.push({
      id: 42,
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'spring-2025',
    })
    await store.insertExposure({
      passport_id: 'p1', session_id: 42, ts: new Date(),
      channel: 'web', direction: 'exposure', text: 'pricing', content_hash: 'h1',
    })
    await store.insertChunks('h1', [{ text: 'pricing info', embedding: [0.1] }])

    const hits = await store.recallChunks({ passport_id: 'p1', embedding: [0.5], limit: 10 })
    expect(hits).toHaveLength(1)
    expect(hits[0].utm_source).toBe('google')
    expect(hits[0].utm_campaign).toBe('spring-2025')
    expect(hits[0].channel).toBe('web')
  })

  it('recallChunks returns null UTMs when no session linked', async () => {
    const db = makeDb()
    const store = createStore({ db })

    await store.insertExposure({
      passport_id: 'p1', session_id: null, ts: new Date(),
      channel: 'mail', direction: 'exposure', text: 'mail', content_hash: 'h2',
    })
    await store.insertChunks('h2', [{ text: 'mail content', embedding: [0.1] }])

    const hits = await store.recallChunks({ passport_id: 'p1', embedding: [0.5], limit: 10 })
    expect(hits).toHaveLength(1)
    expect(hits[0].utm_source).toBeFalsy()
  })

  it('timeline LEFT JOINs sessions and projects UTM fields', async () => {
    const db = makeDb()
    const store = createStore({ db })

    db.store.whitebox_sessions.push({
      id: 7,
      utm_source: 'linkedin',
      utm_campaign: 'b2b-2025',
    })
    await store.insertExposure({
      passport_id: 'p1', session_id: 7, ts: new Date(),
      channel: 'web', direction: 'exposure', text: 'about', content_hash: 'h3',
    })

    const rows = await store.timeline({ passport_id: 'p1' })
    expect(rows).toHaveLength(1)
    expect(rows[0].utm_source).toBe('linkedin')
    expect(rows[0].utm_campaign).toBe('b2b-2025')
  })

  it('populationChunks resolves chunks → passports via CTE', async () => {
    const db = makeDb()
    const store = createStore({ db })

    // Both alice and bob received the same shared content
    await store.insertExposure({ passport_id: 'alice', ts: new Date(), channel: 'mail', direction: 'exposure', text: 'x', content_hash: 'shared' })
    await store.insertExposure({ passport_id: 'bob', ts: new Date(), channel: 'mail', direction: 'exposure', text: 'x', content_hash: 'shared' })
    await store.insertChunks('shared', [{ text: 'matching content', embedding: [0.1] }])

    const result = await store.populationChunks({ embedding: [0.5], similarity: 0.5, limit: 100 })
    const passports = new Set(result.map(r => r.passport_id))
    expect(passports.has('alice')).toBe(true)
    expect(passports.has('bob')).toBe(true)
  })

  it('populationChunks includes UTM context per match', async () => {
    const db = makeDb()
    const store = createStore({ db })

    db.store.whitebox_sessions.push(
      { id: 1, utm_source: 'google', utm_campaign: 'spring' },
      { id: 2, utm_source: 'linkedin', utm_campaign: 'b2b' }
    )
    await store.insertExposure({ passport_id: 'alice', session_id: 1, ts: new Date(), channel: 'web', direction: 'exposure', text: 'x', content_hash: 'h' })
    await store.insertExposure({ passport_id: 'bob', session_id: 2, ts: new Date(), channel: 'web', direction: 'exposure', text: 'x', content_hash: 'h' })
    await store.insertChunks('h', [{ text: 'pricing info', embedding: [0.1] }])

    const result = await store.populationChunks({ embedding: [0.5], similarity: 0.5, limit: 100 })
    const alice = result.find(r => r.passport_id === 'alice')
    const bob = result.find(r => r.passport_id === 'bob')
    expect(alice?.utm_source).toBe('google')
    expect(bob?.utm_source).toBe('linkedin')
  })
})
