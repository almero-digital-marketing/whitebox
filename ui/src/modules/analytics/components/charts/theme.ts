// Shared chart theming + helpers. Tokens and the data palette are read from CSS
// variables so charts track the Noir theme (the chrome stays B&W; only the data viz
// is coloured, using PrimeVue's ramp — the same source its chart demos use).

export function css(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

// One read of the theme: neutral tokens (C) + the categorical data palette.
export function readTheme() {
  const C = {
    muted: css('--muted', '#71717a'),
    border: css('--border', '#e4e4e7'),
    grid: css('--panel-2', '#f4f4f5'),
    panel: css('--panel', '#ffffff'),
  }
  const PALETTE = [
    css('--p-indigo-500', '#6366f1'), css('--p-teal-500', '#14b8a6'),
    css('--p-orange-500', '#f97316'), css('--p-pink-500', '#ec4899'),
    css('--p-purple-500', '#a855f7'), css('--p-cyan-500', '#06b6d4'),
    css('--p-amber-500', '#f59e0b'), css('--p-emerald-500', '#10b981'),
    css('--p-rose-500', '#f43f5e'), css('--p-sky-500', '#0ea5e9'),
  ]
  return { C, PALETTE }
}

// Compact number format for axis/tooltip values (1.2k, 3.4M).
export const nfmt = (n: number) =>
  (Math.abs(n) >= 1000 ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : String(n))

// Shared legend styling for the multi-series charts.
export const legendBase = (C: { muted: string }) =>
  ({ top: 0, type: 'scroll', icon: 'roundRect', itemHeight: 8, itemWidth: 12, itemGap: 14, textStyle: { color: C.muted, fontSize: 11 } })

// Align named series onto a shared bucket axis (union, first-appearance order; missing
// buckets → 0) so ECharts can draw them side by side / overlaid / as a grid.
export function alignSeries(ser: { name: string; points: { bucket: string; value: number }[] }[]) {
  const axis: string[] = []
  const seen = new Set<string>()
  for (const s of ser) for (const p of s.points) if (!seen.has(p.bucket)) { seen.add(p.bucket); axis.push(p.bucket) }
  const series = ser.map((s) => {
    const m = new Map(s.points.map((p) => [p.bucket, p.value]))
    return { name: s.name, values: axis.map((b) => m.get(b) ?? 0) }
  })
  return { axis, series }
}
