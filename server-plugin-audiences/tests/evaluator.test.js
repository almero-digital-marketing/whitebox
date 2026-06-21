import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as evaluator from '../src/evaluator.js'

const selectRule = { id: 'churn', name: 'Churn', select: { about: 'cancel', judge: { criteria: 'at risk', confidence: 0.7 } } }
const funnelRule = { id: 'winback', name: 'Win-back', funnel: { steps: [{ select: {} }] }, slot: 'gap:2→3', status: 'dropped' }
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

let selector, ai, db, captured
beforeEach(() => {
  captured = {}
  selector = {
    resolve: vi.fn(async (sel, opts) => { captured.resolve = { sel, opts }; return captured.resolveResult ?? { passports: [] } }),
    preview: vi.fn(async (sel) => { captured.preview = { sel }; return captured.previewResult }),
    funnel: vi.fn(async (spec, opts) => { captured.funnel = { spec, opts }; return captured.funnelResult ?? { report: [], steps: {}, gaps: {} } }),
    funnelSlot: vi.fn((result, slot, opts) => { captured.slot = { result, slot, opts }; return captured.slotIds ?? [] }),
  }
  ai = { object: vi.fn(async (_s, user) => { captured.draft = user; return { name: 'X', select: { about: 'x' } } }) }
  db = vi.fn(() => ({ distinct: () => ({ orderBy: async () => [{ key: 'plan_tier' }] }) }))
  evaluator.init({ selector, ai, db, logger })
})

describe('audiences evaluator — select source', () => {
  it('resolveCohort → the people cohort with why/score/matched_at', async () => {
    captured.resolveResult = { passports: [{ id: 'a', why: 'cancelling', score: 0.9, matched_at: '2026-05-01' }] }
    const cohort = await evaluator.resolveCohort(selectRule)
    expect(captured.resolve.opts).toMatchObject({ projection: 'people' })
    expect(cohort).toEqual([{ id: 'a', qualified: true, score: 0.9, reason: 'cancelling', evidence: { matched_at: '2026-05-01' } }])
  })

  it('evaluate(passport) is a scoped resolve — membership in/out', async () => {
    captured.resolveResult = { passports: [{ id: 'p1', why: 'w', score: 0.8 }] }
    expect(await evaluator.evaluate(selectRule, 'p1')).toMatchObject({ qualified: true, score: 0.8, reason: 'w' })
    expect(captured.resolve.opts).toEqual({ projection: 'people', scope: ['p1'] })
    captured.resolveResult = { passports: [] }
    expect(await evaluator.evaluate(selectRule, 'p1')).toMatchObject({ qualified: false, score: 0 })
  })

  it('preview maps the engine preview', async () => {
    captured.previewResult = { filter: { survivors: 120 }, fullScan: false, confirmRequired: false, judge: { sample: 20, projectedMatches: 84, reasons: ['r'] } }
    expect(await evaluator.preview(selectRule)).toEqual({ candidate_pool: 120, est_matches: 84, sampled: 20, full_scan: false, confirm_required: false, sample_reasons: ['r'] })
  })
})

describe('audiences evaluator — funnel source', () => {
  it('resolveCohort runs the funnel and pulls the slot cohort', async () => {
    captured.slotIds = ['p2', 'p7']
    const cohort = await evaluator.resolveCohort(funnelRule)
    expect(captured.funnel.spec).toEqual(funnelRule.funnel)
    expect(captured.slot).toMatchObject({ slot: 'gap:2→3', opts: { status: 'dropped' } })
    expect(cohort).toEqual([
      { id: 'p2', qualified: true, score: 1, reason: 'funnel gap:2→3', evidence: { slot: 'gap:2→3', status: 'dropped' } },
      { id: 'p7', qualified: true, score: 1, reason: 'funnel gap:2→3', evidence: { slot: 'gap:2→3', status: 'dropped' } },
    ])
  })

  it('evaluate(passport) is population-only for a funnel — not a per-passport match', async () => {
    const v = await evaluator.evaluate(funnelRule, 'p1')
    expect(v.qualified).toBe(false)
    expect(selector.resolve).not.toHaveBeenCalled()
  })

  it('preview reports the slot cohort size', async () => {
    captured.slotIds = ['p2', 'p7', 'p9']
    expect(await evaluator.preview(funnelRule)).toMatchObject({ candidate_pool: 3, est_matches: 3, source: 'gap:2→3' })
  })
})

describe('audiences evaluator — discovery + authoring', () => {
  it('availableFacts reads distinct keys from core facts', async () => {
    expect(await evaluator.availableFacts()).toEqual([{ key: 'plan_tier' }])
    expect(db).toHaveBeenCalledWith('whitebox_facts')
  })
  it('draftRule asks the LLM for a selector-shaped rule', async () => {
    expect(await evaluator.draftRule('about to churn')).toEqual({ name: 'X', select: { about: 'x' } })
    expect(captured.draft).toBe('about to churn')
  })
})
