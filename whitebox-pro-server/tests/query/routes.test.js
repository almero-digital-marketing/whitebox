import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { mountRoutes } from '../../src/query/routes.js'
import createAuth from '../../src/auth.js'

const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} }
const SECRET = 'test-secret'

// A stubbed engine — these tests cover the HTTP surface (validation, auth, error
// mapping, pass-through), not the selector internals (those have their own suites).
let calls = []
let resolveImpl = async (sel, opts) => ({ count: 0, passports: [], echo: { sel, opts } })
let previewImpl = async (sel, opts) => ({ filter: { survivors: 0 }, echo: { sel, opts } })
const selector = {
  resolve: (...a) => { calls.push(['resolve', ...a]); return resolveImpl(...a) },
  preview: (...a) => { calls.push(['preview', ...a]); return previewImpl(...a) },
}
const ai = { prompt: async () => 'synthesized answer' }

let base
let server
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  const requireAuth = createAuth({ secret: SECRET, logger })
  mountRoutes(app, { requireAuth, selector, ai, logger })
  await new Promise(r => { server = app.listen(0, r) })
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise(r => server.close(r)))

const post = (path, body, token = SECRET) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

describe('query REST surface', () => {
  beforeAll(() => { calls = [] })

  it('401s without a bearer token', async () => {
    const res = await post('/query', { selector: {} }, null)
    expect(res.status).toBe(401)
  })

  it('POST /query passes selector + opts to resolve and returns the result', async () => {
    calls = []
    resolveImpl = async () => ({ count: 2, passports: [{ id: 'a' }, { id: 'b' }] })
    const res = await post('/query', { selector: { about: 'churn' }, projection: 'people' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ count: 2, passports: [{ id: 'a' }, { id: 'b' }] })
    const [, sel, opts] = calls.find(c => c[0] === 'resolve')
    expect(sel).toEqual({ about: 'churn' })
    expect(opts).toMatchObject({ projection: 'people' })
  })

  it('defaults a missing selector to {} (whole-base query)', async () => {
    calls = []
    resolveImpl = async () => ({ count: 0, passports: [] })
    await post('/query', { projection: 'people' })
    const [, sel] = calls.find(c => c[0] === 'resolve')
    expect(sel).toEqual({})
  })

  it('POST /preview routes to preview', async () => {
    previewImpl = async () => ({ filter: { survivors: 7 }, confirmRequired: false })
    const res = await post('/preview', { selector: { about: 'x' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ filter: { survivors: 7 } })
  })

  it('400s on a bad projection (zod)', async () => {
    const res = await post('/query', { selector: {}, projection: 'nonsense' })
    expect(res.status).toBe(400)
  })

  it('maps a selector engine error to 400 with its message', async () => {
    resolveImpl = async () => { throw new Error('selector: knowledge over a passport needs `about` to rank evidence') }
    const res = await post('/query', { selector: {}, projection: 'knowledge', scope: 'passport', passport: 'p1' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/needs `about`/)
  })

  it('maps a non-selector (infra) error to 500', async () => {
    resolveImpl = async () => { throw new Error('connection terminated unexpectedly') }
    const res = await post('/query', { selector: {}, projection: 'people' })
    expect(res.status).toBe(500)
  })

  it('POST /ask retrieves knowledge then synthesizes an answer', async () => {
    calls = []
    resolveImpl = async () => ({ evidence: [{ channel: 'web', direction: 'expression', content: 'asked about pricing', observed_at: '2026-05-01T00:00:00Z' }] })
    const res = await post('/ask', { question: 'what about pricing?' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ answer: 'synthesized answer' })
    expect(body.evidence).toHaveLength(1)
    const [, sel, opts] = calls.find(c => c[0] === 'resolve')
    expect(sel.about).toBe('what about pricing?')   // about defaults to the question
    expect(opts.projection).toBe('knowledge')
  })

  it('POST /ask 400s without a question', async () => {
    const res = await post('/ask', { selector: { about: 'x' } })
    expect(res.status).toBe(400)
  })

  it('POST /ask 401s without a token', async () => {
    const res = await post('/ask', { question: 'q' }, null)
    expect(res.status).toBe(401)
  })
})
