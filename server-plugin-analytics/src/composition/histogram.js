// Pure histogram binning — turn an array of numbers into labelled buckets.
// No DB, no I/O. Auto-bins to "nice" round widths unless an explicit `bins`
// edge-array is supplied. Integer data over a small range gets one bucket per
// value (1, 2, 3 …) so a "visits" or "bookings" distribution reads cleanly.
//
// Why this lives outside the fact predicate: a histogram needs the RAW values to
// bin them — a single range predicate can't produce a distribution. So the
// distribution path reads raw numeric values (store.factValues / store.eventCounts)
// and bins them here. (Historically this also dodged a core comparator bug where a
// numeric STRING like "1820" parsed as the YEAR 1820; that's since fixed in core —
// facts/operators.cmp now orders numeric strings numerically — but JS-side binning
// is the right approach regardless.)

// Round a positive span to a friendly 1/2/5×10ⁿ step.
const niceNum = (x) => {
  if (!(x > 0)) return 1
  const exp = Math.floor(Math.log10(x))
  const f = x / 10 ** exp
  const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10
  return nf * 10 ** exp
}

// Compact number for an axis label: 1.2k for thousands, plain otherwise.
const fmt = (n) => {
  if (Math.abs(n) >= 1000) return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
  return String(Number.isInteger(n) ? n : Number(n.toFixed(2)))
}

// Choose bin edges from the data: nice round widths anchored to a round low
// edge. Integer data extends one past the max so the top value gets its own
// half-open bucket; when the width lands on 1, each integer is its own bucket
// and we label it with the single value (perValue) instead of a range.
function autoEdges(values, maxBins) {
  const min = Math.min(...values), max = Math.max(...values)
  const integer = values.every(Number.isInteger)
  if (min === max) return { edges: [min, min + 1], perValue: true }
  let step = niceNum((max - min) / maxBins)
  if (integer) step = Math.max(1, Math.round(step))
  const lo = Math.floor(min / step) * step
  const top = integer ? max + 1 : max   // integer: push past max so it isn't merged into the last bucket
  const n = Math.max(1, Math.ceil((top - lo) / step) || 1)
  const edges = Array.from({ length: n + 1 }, (_, i) => Number((lo + i * step).toFixed(6)))
  return { edges, perValue: integer && step === 1 }
}

// Count values into half-open buckets [edges[i], edges[i+1]); the final bucket
// is closed so the maximum value lands in it.
function bucketize(values, edges) {
  const counts = new Array(edges.length - 1).fill(0)
  const last = edges.length - 1
  for (const v of values) {
    if (v < edges[0] || v > edges[last]) continue
    let i = last - 1
    for (let k = 0; k < last; k++) { if (v < edges[k + 1]) { i = k; break } }
    counts[i]++
  }
  return counts
}

// values: number[]  → { series: [{ bucket, value }] }
//   bins:    optional explicit edge array (ascending) — overrides auto-binning
//   maxBins: target bucket count for auto mode (default 8)
export function buildHistogram(values, { bins, maxBins = 8 } = {}) {
  const nums = (values || []).filter(Number.isFinite)
  if (!nums.length) return { series: [] }
  let edges, perValue = false
  if (Array.isArray(bins) && bins.length >= 2) {
    edges = [...bins].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  }
  // No explicit bins, or they were non-numeric (e.g. an AI-emitted string edge) and
  // filtered down below two — fall back to auto-binning instead of `new Array(-1)`.
  if (!Array.isArray(edges) || edges.length < 2) {
    ({ edges, perValue } = autoEdges(nums, maxBins))
  }
  const counts = bucketize(nums, edges)
  // lo/hi = the numeric edges of each half-open bucket [lo, hi). Carried through so a
  // chart selection can turn a bin into a fact-range segment ({ fact: { key: { gte: lo,
  // lt: hi } } }) — which resolves correctly now that the core comparator orders
  // numeric-string fact values numerically.
  const series = counts.map((value, i) => ({
    bucket: perValue ? fmt(edges[i]) : `${fmt(edges[i])}–${fmt(edges[i + 1])}`,
    value,
    lo: edges[i],
    hi: edges[i + 1],
  }))
  return { series }
}
