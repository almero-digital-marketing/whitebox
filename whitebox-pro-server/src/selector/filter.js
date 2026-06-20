import * as facts from '../facts/index.js'
import * as metric from './metric.js'

// Boolean evaluation of a selector's `filter` tree → an array of passport ids.
// A leaf clause (e.g. `fact`) resolves to the set of passports that match; the
// combinators compose sets. See docs/selector.md §5.
//
//   filter = clause | { all: [filter…] } | { any: [filter…] } | { not: filter }
//   clause = { fact: { <key>: { <op>: <value> } } }     // metric/channel come later

const intersect = (a, b) => { const s = new Set(b); return a.filter(x => s.has(x)) }
const difference = (a, b) => { const s = new Set(b); return a.filter(x => !s.has(x)) }
const intersectAll = sets => (sets.length ? sets.reduce(intersect) : [])
const unionAll = sets => [...new Set(sets.flat())]

export async function evaluate(node, ctx) {
  if (!node) return ctx.universe()                 // empty filter ⇒ everyone in scope
  if (node.all) return evalAll(node.all, ctx)
  if (node.any) return unionAll(await Promise.all(node.any.map(c => evaluate(c, ctx))))
  if (node.not) return difference(await ctx.universe(), await evaluate(node.not, ctx))
  if (node.fact) return evalFact(node.fact, ctx)
  if (node.metric) return metric.evaluate(ctx.db, node.metric, { at: ctx.at, scope: ctx.scope })
  throw new Error(`selector.filter: unknown clause ${JSON.stringify(node)}`)
}

// `all` with a positive anchor: intersect the positives, then subtract each
// `not` — so a negated clause never needs the full population. Only a *pure*-
// negative `all` (no positives) falls back to the universe (§5 — flagged as a
// full scan by ctx.universe).
async function evalAll(children, ctx) {
  const positives = children.filter(c => !c.not)
  const negatives = children.filter(c => c.not)
  let set = positives.length
    ? intersectAll(await Promise.all(positives.map(c => evaluate(c, ctx))))
    : await ctx.universe()
  for (const neg of negatives) set = difference(set, await evaluate(neg.not, ctx))
  return set
}

async function evalFact(factObj, ctx) {
  const entries = Object.entries(factObj)
  if (entries.length !== 1) throw new Error('selector.filter: a `fact` clause takes exactly one key')
  const [key, predicate] = entries[0]
  return facts.matches(key, predicate, { at: ctx.at, scope: ctx.scope })
}
