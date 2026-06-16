import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import analyticsPlugin from '../src/index.js'

const SECRET = 'test-secret-123'

function makeApp({ awarenessOverrides = {}, openaiOverrides = {}, context = null } = {}) {
  const awareness = {
    recall: vi.fn(async () => [{ id: 1, chunk_text: 'hit', similarity: 0.9 }]),
    population: vi.fn(async () => ({ count: 2, passports: [] })),
    timeline: vi.fn(async () => [{ id: 1, ts: new Date(), text: 'event' }]),
    forget: vi.fn(async () => 5),
    ...awarenessOverrides,
  }
  const openai = {
    prompt: vi.fn(async () => 'Synthesized answer with citations.'),
    ...openaiOverrides,
  }
  const app = express()
  // No body parser in test — we set req.body directly
  const logger = { child: () => logger, warn: vi.fn(), error: vi.fn(), info: vi.fn() }
  const ctx = {
    config: { analytics: { auth: { secret: SECRET } } },
    awareness,
    openai,
    context,
    logger,
  }
  analyticsPlugin.register(app, ctx)
  return { app, awareness, openai, context }
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
    expect(body.hits).toHaveLength(1)
    expect(awareness.recall).toHaveBeenCalledWith({
      passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab',
      query: 'pricing',
      limit: 5,
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
    expect(body.count).toBe(3)
    expect(body.passports).toHaveLength(3)
    expect(awareness.population).toHaveBeenCalledWith({
      query: 'spring promotion',
      similarity: 0.8,
    })
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
    expect(body).toHaveLength(1)
    expect(awareness.timeline).toHaveBeenCalledWith(expect.objectContaining({
      passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab',
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
    expect(body.page).toBe(1)
    expect(body.page_size).toBe(20)
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

  it('translates page + page_size into limit/offset', async () => {
    const context = {
      names: () => ['crm'],
      collect: vi.fn(async () => ({ crm: [] })),
    }
    const { app } = makeApp({ context })
    await request(app, 'GET',
      '/analytics/context/a1b2c3d4-5678-4abc-89de-1234567890ab?page=3&page_size=10',
      { auth: SECRET })
    expect(context.collect).toHaveBeenCalledWith(
      'a1b2c3d4-5678-4abc-89de-1234567890ab',
      expect.objectContaining({ limit: 10, offset: 20 })
    )
  })

  it('clamps page_size to 200', async () => {
    const context = {
      names: () => ['crm'],
      collect: vi.fn(async () => ({ crm: [] })),
    }
    const { app } = makeApp({ context })
    const { body } = await request(app, 'GET',
      '/analytics/context/a1b2c3d4-5678-4abc-89de-1234567890ab?page_size=999',
      { auth: SECRET })
    expect(body.page_size).toBe(200)
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
      '/analytics/context/a1b2c3d4-5678-4abc-89de-1234567890ab?page_size=5',
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
      '/analytics/context/a1b2c3d4-5678-4abc-89de-1234567890ab?page_size=5',
      { auth: SECRET })
    expect(body.has_more).toEqual({ crm: false })
  })

  it('returns empty shape when no context registry is wired', async () => {
    const { app } = makeApp()  // no context
    const { status, body } = await request(app, 'GET',
      '/analytics/context/a1b2c3d4-5678-4abc-89de-1234567890ab', { auth: SECRET })
    expect(status).toBe(200)
    expect(body).toEqual({ providers: [], page: 1, page_size: 20, context: {} })
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

  it('returns synthesized answer + evidence on success', async () => {
    const hits = [
      {
        id: 1,
        chunk_text: 'Enterprise tier includes SSO.',
        ts: new Date('2024-11-12T14:23:01Z'),
        channel: 'web',
        direction: 'exposure',
        utm_source: 'google',
        utm_campaign: 'spring-2025',
        similarity: 0.92,
      },
    ]
    const { app, openai } = makeApp({
      awarenessOverrides: { recall: vi.fn(async () => hits) },
      openaiOverrides: { prompt: vi.fn(async () => 'On 2024-11-12, the user (arrived via google/spring-2025) read about Enterprise SSO.') },
    })

    const { status, body } = await request(app, 'POST', '/analytics/ask', {
      auth: SECRET,
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab', question: 'What does this user know about SSO?' },
    })

    expect(status).toBe(200)
    expect(body.answer).toContain('Enterprise SSO')
    expect(body.evidence).toHaveLength(1)
    expect(openai.prompt).toHaveBeenCalledOnce()
    const [system, user] = openai.prompt.mock.calls[0]
    expect(system).toContain('UTM attribution')
    expect(user).toContain('Enterprise tier includes SSO')
    expect(user).toContain('arrived via: google')
    expect(user).toContain('What does this user know about SSO?')
  })

  it('formats evidence with timestamps, channel/direction, and UTM tags', async () => {
    const hits = [
      {
        id: 1,
        chunk_text: 'Subject: Welcome\n\nHello Alice',
        ts: new Date('2024-11-10T09:01:44Z'),
        channel: 'mail',
        direction: 'exposure',
        utm_source: 'newsletter',
        utm_medium: 'email',
        utm_campaign: 'weekly-digest',
      },
      {
        id: 2,
        chunk_text: 'Refunds within 30 days',
        ts: new Date('2024-11-08T11:42:18Z'),
        channel: 'web',
        direction: 'exposure',
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
      },
    ]
    const { app, openai } = makeApp({
      awarenessOverrides: { recall: vi.fn(async () => hits) },
    })

    await request(app, 'POST', '/analytics/ask', {
      auth: SECRET,
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab', question: 'Has this user seen our refund policy?' },
    })

    const userPrompt = openai.prompt.mock.calls[0][1]
    expect(userPrompt).toContain('mail/exposure')
    expect(userPrompt).toContain('[arrived via: newsletter / email / weekly-digest]')
    expect(userPrompt).toContain('web/exposure\nRefunds within 30 days')  // no UTM tag when null
    expect(userPrompt).toMatch(/\n---\n/)  // separator between hits
  })

  it('returns "no relevant content" when recall is empty', async () => {
    const { app, openai } = makeApp({
      awarenessOverrides: { recall: vi.fn(async () => []) },
    })
    const { status, body } = await request(app, 'POST', '/analytics/ask', {
      auth: SECRET,
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab', question: 'anything?' },
    })
    expect(status).toBe(200)
    expect(body.answer).toMatch(/no relevant content/i)
    expect(body.evidence).toEqual([])
    expect(openai.prompt).not.toHaveBeenCalled()  // no LLM call when there's nothing to ground
  })

  it('returns 500 when openai fails', async () => {
    const { app } = makeApp({
      openaiOverrides: { prompt: vi.fn(async () => { throw new Error('openai down') }) },
    })
    const { status } = await request(app, 'POST', '/analytics/ask', {
      auth: SECRET,
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab', question: 'x' },
    })
    expect(status).toBe(500)
  })

  it('includes structured context from registered providers in the prompt', async () => {
    const context = {
      collect: vi.fn(async () => ({
        crm: [
          { source: 'booking', kind: 'reservation', external_id: 'r1', status: 'confirmed', starts_at: '2026-06-12T14:00:00Z', data: { room: 'suite' } },
        ],
      })),
    }
    const { app, openai } = makeApp({ context })

    const { status, body } = await request(app, 'POST', '/analytics/ask', {
      auth: SECRET,
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab', question: 'When does this customer check in?' },
    })

    expect(status).toBe(200)
    expect(context.collect).toHaveBeenCalledWith(
      'a1b2c3d4-5678-4abc-89de-1234567890ab',
      expect.objectContaining({ question: 'When does this customer check in?' })
    )
    const userPrompt = openai.prompt.mock.calls[0][1]
    expect(userPrompt).toContain('Structured context:')
    expect(userPrompt).toContain('crm:')
    expect(userPrompt).toContain('reservation')
    expect(userPrompt).toContain('2026-06-12')
    // Response surfaces the raw context blob for the caller
    expect(body.context).toEqual({ crm: expect.any(Array) })
  })

  it('answers from structured context alone when recall is empty', async () => {
    const context = {
      collect: vi.fn(async () => ({
        crm: [{ source: 'stripe', kind: 'subscription', external_id: 'sub_1', status: 'active' }],
      })),
    }
    const { app, openai } = makeApp({
      awarenessOverrides: { recall: vi.fn(async () => []) },
      context,
    })

    const { status, body } = await request(app, 'POST', '/analytics/ask', {
      auth: SECRET,
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab', question: 'Active subscription?' },
    })

    expect(status).toBe(200)
    expect(openai.prompt).toHaveBeenCalledOnce()  // structured context is enough — LLM is invoked
    expect(body.evidence).toEqual([])
    expect(body.context.crm).toHaveLength(1)
  })

  it('still short-circuits when BOTH structured context and recall are empty', async () => {
    const context = { collect: vi.fn(async () => ({ crm: [] })) }
    const { app, openai } = makeApp({
      awarenessOverrides: { recall: vi.fn(async () => []) },
      context,
    })
    const { status, body } = await request(app, 'POST', '/analytics/ask', {
      auth: SECRET,
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab', question: 'anything?' },
    })
    expect(status).toBe(200)
    expect(body.answer).toMatch(/no relevant content/i)
    expect(openai.prompt).not.toHaveBeenCalled()
  })

  it('passes limit through to awareness.recall', async () => {
    const { app, awareness } = makeApp()
    await request(app, 'POST', '/analytics/ask', {
      auth: SECRET,
      body: { passport_id: 'a1b2c3d4-5678-4abc-89de-1234567890ab', question: 'x', limit: 25 },
    })
    expect(awareness.recall).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }))
  })
})
