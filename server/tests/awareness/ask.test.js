import { describe, it, expect, vi } from 'vitest'
import * as ask from '../../src/awareness/ask.js'

// Wire the core ask primitive with mocked ai / recall / context.
function setup({
  recall = async () => [],
  population = async () => ({ count: 0, passports: [] }),
  populationStats = async () => ({ customers: 5, exposures: 20, breakdown: [{ channel: 'web', direction: 'exposure', exposures: 20, customers: 5 }] }),
  sampleContent = async () => [],
  collect = null,
  prompt = async () => 'ANSWER',
  object = async () => ({}),
} = {}) {
  const ai = { prompt: vi.fn(prompt), object: vi.fn(object) }
  const context = collect ? { collect: vi.fn(collect) } : null
  const populationFn = vi.fn(population)
  const populationStatsFn = vi.fn(populationStats)
  const sampleContentFn = vi.fn(sampleContent)
  ask.init({ ai, context, recall: vi.fn(recall), population: populationFn, populationStats: populationStatsFn, sampleContent: sampleContentFn })
  return { ai, context, population: populationFn, populationStats: populationStatsFn, sampleContent: sampleContentFn }
}

const PID = 'a1b2c3d4-5678-4abc-89de-1234567890ab'

describe('awareness.ask', () => {
  it('formats evidence and synthesizes a grounded answer', async () => {
    const hits = [{
      chunk_text: 'Enterprise tier includes SSO.',
      ts: new Date('2024-11-12T14:23:01Z'),
      channel: 'web', direction: 'exposure',
      utm_source: 'google', utm_campaign: 'spring-2025',
    }]
    const { ai } = setup({ recall: async () => hits, prompt: async () => 'On 2024-11-12 they read about Enterprise SSO.' })

    const out = await ask.ask({ passport_id: PID, question: 'What does this user know about SSO?' })

    expect(out.answer).toContain('Enterprise SSO')
    expect(out.evidence).toHaveLength(1)
    expect(ai.prompt).toHaveBeenCalledOnce()
    const [system, user] = ai.prompt.mock.calls[0]
    expect(system).toContain('UTM attribution')                      // the default policy prompt
    expect(user).toContain('Enterprise tier includes SSO')
    expect(user).toContain('arrived via: google')
    expect(user).toContain('What does this user know about SSO?')
  })

  it('formats evidence with channel/direction, UTM tags, and a separator', async () => {
    const hits = [
      { chunk_text: 'Subject: Welcome', ts: new Date('2024-11-10T09:01:44Z'), channel: 'mail', direction: 'exposure', utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'weekly-digest' },
      { chunk_text: 'Refunds within 30 days', ts: new Date('2024-11-08T11:42:18Z'), channel: 'web', direction: 'exposure' },
    ]
    const { ai } = setup({ recall: async () => hits })
    await ask.ask({ passport_id: PID, question: 'refund policy?' })

    const user = ai.prompt.mock.calls[0][1]
    expect(user).toContain('mail/exposure')
    expect(user).toContain('[arrived via: newsletter / email / weekly-digest]')
    expect(user).toContain('web/exposure\nRefunds within 30 days')   // no UTM tag when absent
    expect(user).toMatch(/\n---\n/)                                   // separator between hits
  })

  it('short-circuits (no LLM) when recall and context are both empty', async () => {
    const { ai } = setup({ recall: async () => [] })
    const out = await ask.ask({ passport_id: PID, question: 'anything?' })
    expect(out.answer).toMatch(/no relevant content/i)
    expect(out.evidence).toEqual([])
    expect(ai.prompt).not.toHaveBeenCalled()
  })

  it('answers from structured context alone when recall is empty', async () => {
    const { ai, context } = setup({
      recall: async () => [],
      collect: async () => ({ crm: [{ kind: 'subscription', status: 'active' }] }),
    })
    const out = await ask.ask({ passport_id: PID, question: 'Active subscription?' })

    expect(context.collect).toHaveBeenCalled()
    expect(ai.prompt).toHaveBeenCalledOnce()                         // structured context is enough to invoke the LLM
    const user = ai.prompt.mock.calls[0][1]
    expect(user).toContain('Structured context:')
    expect(user).toContain('active')
    expect(out.evidence).toEqual([])
    expect(out.context.crm).toHaveLength(1)
  })

  it('uses `instruction` to override the default system prompt', async () => {
    const { ai } = setup({ recall: async () => [{ chunk_text: 'x', ts: new Date(), channel: 'web', direction: 'exposure' }] })
    await ask.ask({ passport_id: PID, question: 'q', instruction: 'CUSTOM SYSTEM PROMPT' })
    expect(ai.prompt.mock.calls[0][0]).toBe('CUSTOM SYSTEM PROMPT')
  })

  it('uses structured output (ai.object) when a `schema` is given', async () => {
    const schema = { __zod: true }   // opaque token — the mock just echoes a verdict
    const { ai } = setup({
      recall: async () => [{ chunk_text: 'x', ts: new Date(), channel: 'web', direction: 'exposure' }],
      object: async () => ({ match: true, score: 0.8, reason: 'read it twice' }),
    })
    const out = await ask.ask({ passport_id: PID, question: 'q', instruction: 'classify', schema })

    expect(ai.object).toHaveBeenCalledOnce()
    expect(ai.prompt).not.toHaveBeenCalled()
    expect(ai.object.mock.calls[0][2]).toBe(schema)                  // schema passed through
    expect(out).toMatchObject({ match: true, score: 0.8 })
    expect(out.evidence).toHaveLength(1)                             // verdict merged with evidence/context
  })
})

describe('awareness.askPopulation', () => {
  // population() returns { count, passports: [{ passport_id, hits: [...] }] }
  const cohort = (...passports) => ({
    count: passports.length,
    passports: passports.map((hits, i) => ({ passport_id: `p${i}`, hits })),
  })

  it('synthesizes a population-level answer from cohort evidence, grounded in base stats', async () => {
    const { ai, population } = setup({
      population: async () => cohort(
        [{ chunk_text: 'How is pricing structured?', similarity: 0.9, ts: new Date('2026-05-01T10:00:00Z'), channel: 'mail', direction: 'expression' }],
        [{ chunk_text: 'How is pricing structured?', similarity: 0.85, ts: new Date('2026-05-02T10:00:00Z'), channel: 'mail', direction: 'expression' }],
      ),
      prompt: async () => 'Many customers are asking about pricing.',
    })

    const out = await ask.askPopulation({ question: 'What are customers asking about?' })

    expect(population).toHaveBeenCalledWith(expect.objectContaining({ query: 'What are customers asking about?' }))
    expect(out.answer).toContain('pricing')
    expect(out.cohort.count).toBe(2)
    expect(out.stats.customers).toBe(5)
    const [system, user] = ai.prompt.mock.calls[0]
    expect(system).toContain('customer base as a whole')             // population policy prompt
    expect(user).toContain('Customer base: 5 customers')             // base aggregates always included
    expect(user).toContain('Cohort size: 2 distinct customers')
    expect(user).toContain('matches the question')                   // cohort-evidence label
  })

  it('collapses shared content into one evidence row carrying its customer reach', async () => {
    const { ai } = setup({
      population: async () => cohort(
        [{ chunk_text: 'Refund policy', similarity: 0.8, channel: 'web', direction: 'exposure' }],
        [{ chunk_text: 'Refund policy', similarity: 0.7, channel: 'web', direction: 'exposure' }],
        [{ chunk_text: 'Refund policy', similarity: 0.6, channel: 'web', direction: 'exposure' }],
      ),
    })
    const out = await ask.askPopulation({ question: 'refunds?' })

    // one distinct chunk → one evidence row, reaching 3 customers
    expect(out.evidence).toHaveLength(1)
    expect(out.evidence[0].passport_count).toBe(3)
    const user = ai.prompt.mock.calls[0][1]
    expect(user).toContain('seen by 3 customers')
  })

  it('falls back to a base-wide sample (still calls the LLM) when the question maps to no cohort', async () => {
    const { ai, sampleContent } = setup({
      population: async () => ({ count: 0, passports: [] }),          // nothing matched the question
      sampleContent: async () => [
        { chunk_text: 'Loving the new dashboard', customers: 4, channel: 'web', direction: 'expression', ts: new Date('2026-06-01T00:00:00Z') },
      ],
      prompt: async () => 'Across the base, customers are engaging with the dashboard.',
    })

    const out = await ask.askPopulation({ question: "what's going on with everyone?" })

    expect(sampleContent).toHaveBeenCalled()                          // overview path engaged
    expect(ai.prompt).toHaveBeenCalledOnce()                          // NOT short-circuited
    expect(out.cohort.count).toBe(0)
    expect(out.evidence[0].passport_count).toBe(4)
    const user = ai.prompt.mock.calls[0][1]
    expect(user).toContain('Base-wide content sample')               // labeled as not-filtered
    expect(user).toContain('Customer base: 5 customers')
  })

  it('short-circuits (no LLM) only when the base itself is empty', async () => {
    const { ai, sampleContent } = setup({
      populationStats: async () => ({ customers: 0, exposures: 0, breakdown: [] }),
      population: async () => ({ count: 0, passports: [] }),
    })
    const out = await ask.askPopulation({ question: 'anything?' })
    expect(out.answer).toMatch(/no customers in the base/i)
    expect(out.cohort.count).toBe(0)
    expect(out.evidence).toEqual([])
    expect(ai.prompt).not.toHaveBeenCalled()
    expect(sampleContent).not.toHaveBeenCalled()
  })

  it('uses structured output (ai.object) when a `schema` is given — even with no cohort', async () => {
    const schema = { __zod: true }
    const { ai, sampleContent } = setup({
      population: async () => ({ count: 0, passports: [] }),
      sampleContent: async () => [{ chunk_text: 'x', customers: 2, channel: 'web', direction: 'exposure' }],
      object: async () => ({ theme: 'dashboard', size: 2 }),
    })
    const out = await ask.askPopulation({ question: 'themes?', schema })

    expect(sampleContent).toHaveBeenCalled()
    expect(ai.object).toHaveBeenCalledOnce()
    expect(ai.prompt).not.toHaveBeenCalled()
    expect(ai.object.mock.calls[0][2]).toBe(schema)
    expect(out).toMatchObject({ theme: 'dashboard', cohort: { count: 0 } })
    expect(out.stats.customers).toBe(5)
  })

  it('threads scope + window to BOTH grounding stats and recall (and the sample fallback)', async () => {
    const { population, populationStats, sampleContent } = setup({
      population: async () => ({ count: 0, passports: [] }),   // no cohort → overview fallback runs too
      sampleContent: async () => [{ chunk_text: 'x', customers: 1, channel: 'web', direction: 'exposure' }],
    })
    await ask.askPopulation({ question: 'what are active customers complaining about?', scope: ['p1', 'p2'], last: '30d' })

    // the grounding aggregates match the cohort/window, not the whole base
    expect(populationStats).toHaveBeenCalledWith(expect.objectContaining({ scope: ['p1', 'p2'], last: '30d' }))
    expect(population).toHaveBeenCalledWith(expect.objectContaining({ scope: ['p1', 'p2'], last: '30d' }))
    expect(sampleContent).toHaveBeenCalledWith(expect.objectContaining({ scope: ['p1', 'p2'], last: '30d' }))
  })

  it('defaults (no scope/window) preserve whole-base behavior', async () => {
    const { population, populationStats } = setup()
    await ask.askPopulation({ question: 'anything?' })
    expect(populationStats).toHaveBeenCalledWith(expect.objectContaining({ scope: undefined, last: undefined }))
    expect(population).toHaveBeenCalledWith(expect.objectContaining({ scope: undefined, last: undefined }))
  })
})
