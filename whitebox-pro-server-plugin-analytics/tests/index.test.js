import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import { analytics } from '../src/index.js'

const SECRET = 'test-secret-123'

function makeApp({ awarenessOverrides = {}, context = null } = {}) {
  const awareness = {
    recall: vi.fn(async () => [{ id: 1, chunk_text: 'hit', similarity: 0.9 }]),
    population: vi.fn(async () => ({ count: 2, passports: [] })),
    timeline: vi.fn(async () => [{ id: 1, ts: new Date(), text: 'event' }]),
    forget: vi.fn(async () => 5),
    // synthesis lives in the awareness core now; the plugin just delegates
    ask: vi.fn(async () => ({ answer: 'Synthesized answer with citations.', evidence: [{ id: 1 }], context: {} })),
    askPopulation: vi.fn(async () => ({ answer: 'Across the base, customers care about pricing.', evidence: [{ chunk_text: 'pricing', passport_count: 12 }], cohort: { count: 12 } })),
    ...awarenessOverrides,
  }
  const app = express()
  // No body parser in test — we set req.body directly
  const logger = { child: () => logger, warn: vi.fn(), error: vi.fn(), info: vi.fn() }
  const ctx = {
    awareness,
    context,
    logger,
  }
  analytics({ auth: { secret: SECRET } }).register(app, ctx)
  return { app, awareness, context }
}

async function request(app, method, path, { auth, body } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const req = {
      method,
      url: path,
      headers: {
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        'content-type': 'application/json',
      },
      get(name) { return this.headers[name.toLowerCase()] },
      body: body || {},
      id: 'test-req',
      log: { error: () => {}, warn: () => {} },
    }
    const res = {
      _status: 200,
      _body: null,
      _ended: false,
      statusCode: 200,
      headers: {},
      setHeader() {},
      getHeader() {},
      removeHeader() {},
      writeHead() {},
      end(chunk) { this._ended = true; if (chunk) chunks.push(chunk); resolve({ status: this._status, body: this._body }) },
      status(s) { this._status = s; this.statusCode = s; return this },
      json(b) { this._body = b; this.end(JSON.stringify(b)); return this },
      send(b) { this.end(b); return this },
    }
    app(req, res, err => err ? reject(err) : resolve({ status: res._status, body: res._body }))
  })
}

describe('analytics.recall', () => {

  it('requires auth', async () => {
    const { app } = makeApp()
    const { status } = await request(app, 'POST', '/analytics/recall', {
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab', query: 'pricing' },
    })
    expect(status).toBe(401)
  })

  it('returns 400 on missing fields', async () => {
    const { app } = makeApp()
    const { status } = await request(app, 'POST', '/analytics/recall', {
      auth: SECRET,
      body: { passport_id: 'not-a-uuid' },
    })
    expect(status).toBe(400)
  })

  it('returns hits from awareness.recall', async () => {
    const { app, awareness } = makeApp()
    const { status, body } = await request(app, 'POST', '/analytics/recall', {
      auth: SECRET,
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab', query: 'pricing', limit: 5 },
    })
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body).toMatchObject({ limit: 5, offset: 0, has_more: false })
    expect(awareness.recall).toHaveBeenCalledWith({
      passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab',
      query: 'pricing',
      limit: 6,    // page limit 5 + 1 extra row to detect has_more
      offset: 0,
      min_similarity: 0,
    })
  })

  it('returns 500 on awareness error', async () => {
    const { app } = makeApp({
      awarenessOverrides: { recall: vi.fn(async () => { throw new Error('db down') }) },
    })
    const { status } = await request(app, 'POST', '/analytics/recall', {
      auth: SECRET,
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab', query: 'pricing' },
    })
    expect(status).toBe(500)
  })
})

describe('analytics.population', () => {

  it('requires auth', async () => {
    const { app } = makeApp()
    const { status } = await request(app, 'POST', '/analytics/population', {
      body: { query: 'spring promotion' },
    })
    expect(status).toBe(401)
  })

  it('returns cohort count and passport list', async () => {
    const { app, awareness } = makeApp({
      awarenessOverrides: {
        population: vi.fn(async () => ({
          count: 3,
          passports: [
            { passport_id: 'p1', hits: [{ chunk_text: 'a', similarity: 0.9 }] },
            { passport_id: 'p2', hits: [] },
            { passport_id: 'p3', hits: [] },
          ],
        })),
      },
    })
    const { status, body } = await request(app, 'POST', '/analytics/population', {
      auth: SECRET,
      body: { query: 'spring promotion', similarity: 0.8 },
    })
    expect(status).toBe(200)
    expect(body.total).toBe(3)               // cohort size
    expect(body.data).toHaveLength(3)        // paginated passport drilldown
    expect(body).toMatchObject({ limit: 50, offset: 0, has_more: false })
    expect(awareness.population).toHaveBeenCalledWith(expect.objectContaining({
      query: 'spring promotion',
      similarity: 0.8,
    }))
  })

  it('returns 400 on missing query', async () => {
    const { app } = makeApp()
    const { status } = await request(app, 'POST', '/analytics/population', {
      auth: SECRET,
      body: {},
    })
    expect(status).toBe(400)
  })
})

describe('analytics.timeline', () => {

  it('returns rows for the passport', async () => {
    const { app, awareness } = makeApp()
    const { status, body } = await request(app, 'GET', '/analytics/timeline/a1b2c3d4-5678-4abc-89de-1234567890ab', {
      auth: SECRET,
    })
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body).toMatchObject({ limit: 50, offset: 0, has_more: false })
    expect(awareness.timeline).toHaveBeenCalledWith(expect.objectContaining({
      passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab',
      limit: 51, offset: 0,
    }))
  })

  it('passes filters from query string', async () => {
    const { app, awareness } = makeApp()
    await request(app, 'GET',
      '/analytics/timeline/a1b2c3d4-5678-4abc-89de-1234567890ab?channels=mail,voip&directions=exposure&from=2024-01-01',
      { auth: SECRET }
    )
    const call = awareness.timeline.mock.calls[0][0]
    expect(call.channels).toEqual(['mail', 'voip'])
    expect(call.directions).toEqual(['exposure'])
    expect(call.from).toBeInstanceOf(Date)
  })
})

describe('analytics.forget', () => {

  it('calls awareness.forget and returns deletion count', async () => {
    const { app, awareness } = makeApp()
    const { status, body } = await request(app, 'DELETE', '/analytics/passport/a1b2c3d4-5678-4abc-89de-1234567890ab', {
      auth: SECRET,
    })
    expect(status).toBe(200)
    expect(body.deleted).toBe(5)
    expect(awareness.forget).toHaveBeenCalledWith({ passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab' })
  })
})

describe('analytics.context', () => {

  it('requires auth', async () => {
    const { app } = makeApp()
    const { status } = await request(app, 'GET', '/analytics/context/a1b2c3d4-5678-4abc-89de-1234567890ab')
    expect(status).toBe(401)
  })

  it('returns providers list and collected blob with default paging', async () => {
    const context = {
      names: vi.fn(() => ['crm', 'billing']),
      collect: vi.fn(async () => ({
        crm: [{ kind: 'reservation', external_id: 'r1' }],
        billing: { plan: 'pro' },
      })),
    }
    const { app } = makeApp({ context })
    const { status, body } = await request(app, 'GET',
      '/analytics/context/a1b2c3d4-5678-4abc-89de-1234567890ab', { auth: SECRET })

    expect(status).toBe(200)
    expect(body.providers).toEqual(['crm', 'billing'])
    expect(body.limit).toBe(20)
    expect(body.offset).toBe(0)
    expect(body.context.crm).toHaveLength(1)
    expect(body.context.billing).toEqual({ plan: 'pro' })
    expect(context.collect).toHaveBeenCalledWith(
      'a1b2c3d4-5678-4abc-89de-1234567890ab',
      { providers: undefined, limit: 20, offset: 0 }
    )
  })

  it('filters by provider= query param', async () => {
    const context = {
      names: () => ['crm', 'billing'],
      collect: vi.fn(async (_pid, opts) => {
        // Mimic the registry's filtering: only return entries for requested names
        const out = {}
        for (const n of opts.providers || ['crm', 'billing']) out[n] = []
        return out
      }),
    }
    const { app } = makeApp({ context })
    const { status, body } = await request(app, 'GET',
      '/analytics/context/a1b2c3d4-5678-4abc-89de-1234567890ab?provider=crm',
      { auth: SECRET })
    expect(status).toBe(200)
    expect(body.providers).toEqual(['crm'])
    expect(context.collect).toHaveBeenCalledWith(
      'a1b2c3d4-5678-4abc-89de-1234567890ab',
      expect.objectContaining({ providers: ['crm'] })
    )
  })

  it('400s when an unknown provider is requested', async () => {
    const context = {
      names: () => ['crm'],
      collect: vi.fn(async () => ({})),
    }
    const { app } = makeApp({ context })
    const { status, body } = await request(app, 'GET',
      '/analytics/context/a1b2c3d4-5678-4abc-89de-1234567890ab?provider=crm,nope',
      { auth: SECRET })
    expect(status).toBe(400)
    expect(body.unknown).toEqual(['nope'])
    expect(body.available).toEqual(['crm'])
    expect(context.collect).not.toHaveBeenCalled()
  })

  it('passes limit/offset through to the registry', async () => {
    const context = {
      names: () => ['crm'],
      collect: vi.fn(async () => ({ crm: [] })),
    }
    const { app } = makeApp({ context })
    await request(app, 'GET',
      '/analytics/context/a1b2c3d4-5678-4abc-89de-1234567890ab?limit=10&offset=20',
      { auth: SECRET })
    expect(context.collect).toHaveBeenCalledWith(
      'a1b2c3d4-5678-4abc-89de-1234567890ab',
      expect.objectContaining({ limit: 10, offset: 20 })
    )
  })

  it('clamps limit to 200', async () => {
    const context = {
      names: () => ['crm'],
      collect: vi.fn(async () => ({ crm: [] })),
    }
    const { app } = makeApp({ context })
    const { body } = await request(app, 'GET',
      '/analytics/context/a1b2c3d4-5678-4abc-89de-1234567890ab?limit=999',
      { auth: SECRET })
    expect(body.limit).toBe(200)
    expect(context.collect).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ limit: 200, offset: 0 })
    )
  })

  it('reports has_more=true when a provider returns a full page', async () => {
    const context = {
      names: () => ['crm'],
      collect: vi.fn(async () => ({
        crm: Array.from({ length: 5 }, (_, i) => ({ kind: 'reservation', external_id: `r${i}` })),
      })),
    }
    const { app } = makeApp({ context })
    const { body } = await request(app, 'GET',
      '/analytics/context/a1b2c3d4-5678-4abc-89de-1234567890ab?limit=5',
      { auth: SECRET })
    expect(body.has_more).toEqual({ crm: true })
  })

  it('reports has_more=false when a provider returns a short page', async () => {
    const context = {
      names: () => ['crm'],
      collect: vi.fn(async () => ({ crm: [{ kind: 'reservation' }] })),
    }
    const { app } = makeApp({ context })
    const { body } = await request(app, 'GET',
      '/analytics/context/a1b2c3d4-5678-4abc-89de-1234567890ab?limit=5',
      { auth: SECRET })
    expect(body.has_more).toEqual({ crm: false })
  })

  it('returns empty shape when no context registry is wired', async () => {
    const { app } = makeApp()  // no context
    const { status, body } = await request(app, 'GET',
      '/analytics/context/a1b2c3d4-5678-4abc-89de-1234567890ab', { auth: SECRET })
    expect(status).toBe(200)
    expect(body).toEqual({ providers: [], limit: 20, offset: 0, has_more: {}, context: {} })
  })
})

describe('analytics.ask', () => {

  it('requires auth', async () => {
    const { app } = makeApp()
    const { status } = await request(app, 'POST', '/analytics/ask', {
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab', question: 'What does this user know?' },
    })
    expect(status).toBe(401)
  })

  it('returns 400 on missing fields', async () => {
    const { app } = makeApp()
    const { status } = await request(app, 'POST', '/analytics/ask', {
      auth: SECRET,
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab' },
    })
    expect(status).toBe(400)
  })

  it('returns 400 on invalid UUID', async () => {
    const { app } = makeApp()
    const { status } = await request(app, 'POST', '/analytics/ask', {
      auth: SECRET,
      body: { passport_id: 'not-a-uuid', question: 'x' },
    })
    expect(status).toBe(400)
  })

  // Synthesis behaviour (recall + context + prompt policy) is the awareness
  // core's job now — covered in whitebox-pro-server/tests/awareness/ask.test.js.
  // Here we only verify the route delegates + handles transport.
  it('delegates to awareness.ask and returns its result', async () => {
    const result = { answer: 'Grounded answer.', evidence: [{ id: 1 }], context: { crm: [] } }
    const { app, awareness } = makeApp({ awarenessOverrides: { ask: vi.fn(async () => result) } })

    const { status, body } = await request(app, 'POST', '/analytics/ask', {
      auth: SECRET,
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab', question: 'What does this user know?', limit: 25 },
    })

    expect(status).toBe(200)
    expect(body).toEqual(result)
    expect(awareness.ask).toHaveBeenCalledWith(expect.objectContaining({
      passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab',
      question: 'What does this user know?',
      limit: 25,
    }))
  })

  it('returns 500 when awareness.ask throws', async () => {
    const { app } = makeApp({ awarenessOverrides: { ask: vi.fn(async () => { throw new Error('ask down') }) } })
    const { status } = await request(app, 'POST', '/analytics/ask', {
      auth: SECRET,
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab', question: 'x' },
    })
    expect(status).toBe(500)
  })
})

describe('analytics.ask-population', () => {

  it('requires auth', async () => {
    const { app } = makeApp()
    const { status } = await request(app, 'POST', '/analytics/ask-population', {
      body: { question: 'What do customers care about?' },
    })
    expect(status).toBe(401)
  })

  it('returns 400 on missing question', async () => {
    const { app } = makeApp()
    const { status } = await request(app, 'POST', '/analytics/ask-population', {
      auth: SECRET,
      body: { similarity: 0.7 },
    })
    expect(status).toBe(400)
  })

  it('delegates to awareness.askPopulation (no passport_id) and returns its result', async () => {
    const result = { answer: 'Customers care about SSO.', evidence: [{ chunk_text: 'SSO', passport_count: 9 }], cohort: { count: 9 } }
    const { app, awareness } = makeApp({ awarenessOverrides: { askPopulation: vi.fn(async () => result) } })

    const { status, body } = await request(app, 'POST', '/analytics/ask-population', {
      auth: SECRET,
      body: { question: 'What do customers care about?', similarity: 0.65 },
    })

    expect(status).toBe(200)
    expect(body).toEqual(result)
    expect(awareness.askPopulation).toHaveBeenCalledWith(expect.objectContaining({
      question: 'What do customers care about?',
      similarity: 0.65,
    }))
  })

  it('returns 500 when awareness.askPopulation throws', async () => {
    const { app } = makeApp({ awarenessOverrides: { askPopulation: vi.fn(async () => { throw new Error('down') }) } })
    const { status } = await request(app, 'POST', '/analytics/ask-population', {
      auth: SECRET,
      body: { question: 'x' },
    })
    expect(status).toBe(500)
  })
})
