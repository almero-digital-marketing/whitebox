import { describe, it, expect } from 'vitest'
import { answer } from '../../src/query/ask.js'

// The synthesis layer over QUERY(knowledge). resolve + ai are injected, so these
// tests are pure — no engine, no LLM.
const ev = (content, extra = {}) => ({ channel: 'web', direction: 'expression', content, observed_at: '2026-05-01T00:00:00Z', ...extra })

function harness({ evidence = [], capture = {} } = {}) {
  const resolve = async (sel, opts) => { capture.sel = sel; capture.opts = opts; return { evidence } }
  const ai = { prompt: async (system, user) => { capture.system = system; capture.user = user; return 'ANSWER' } }
  return { resolve, ai, capture }
}

describe('query /ask (synthesis layer)', () => {
  it('defaults about to the question and retrieves knowledge', async () => {
    const { resolve, ai, capture } = harness({ evidence: [ev('asked about pricing')] })
    const res = await answer({ question: 'what do they think of pricing?' }, { resolve, ai })
    expect(capture.sel.about).toBe('what do they think of pricing?')   // about ← question
    expect(capture.opts.projection).toBe('knowledge')
    expect(res).toEqual({ answer: 'ANSWER', evidence: [ev('asked about pricing')] })
  })

  it('keeps an explicit about over the question', async () => {
    const { resolve, ai, capture } = harness({ evidence: [ev('x')] })
    await answer({ question: 'summarize them', selector: { about: 'pricing, plans' } }, { resolve, ai })
    expect(capture.sel.about).toBe('pricing, plans')
  })

  it('threads scope/passport/asOf/limit through to the engine', async () => {
    const { resolve, ai, capture } = harness({ evidence: [ev('x')] })
    await answer({ question: 'q', scope: 'passport', passport: 'p1', asOf: '2026-03-31', limit: 4 }, { resolve, ai })
    expect(capture.opts).toMatchObject({ projection: 'knowledge', scope: 'passport', passport: 'p1', asOf: '2026-03-31', limit: 4 })
  })

  it('short-circuits on empty evidence — no LLM call, honest answer', async () => {
    const capture = {}
    const resolve = async () => ({ evidence: [] })
    let called = false
    const ai = { prompt: async () => { called = true; return 'should not happen' } }
    const res = await answer({ question: 'q' }, { resolve, ai })
    expect(called).toBe(false)
    expect(res.evidence).toEqual([])
    expect(res.answer).toMatch(/don't have any relevant content/i)
  })

  it('formats evidence as [channel/direction @ date] lines in the prompt', async () => {
    const { resolve, ai, capture } = harness({ evidence: [ev('they asked about whitening', { channel: 'voip', direction: 'conversation' })] })
    await answer({ question: 'q' }, { resolve, ai })
    expect(capture.user).toContain('[voip/conversation @ 2026-05-01] they asked about whitening')
  })

  it('requires a question', async () => {
    const { resolve, ai } = harness()
    await expect(answer({ }, { resolve, ai })).rejects.toThrow(/needs a `question`/)
  })
})
