# 07 · Tuning & recipes

Tracking attention is a feel thing. This is how to arrive at numbers that match real reading, plus a
troubleshooting table for the symptoms you'll actually see.

## The method

1. **Run the demo** ([`examples/engagement`](../../examples/engagement)) — it shows a live per-element
   timer, so you can *watch* what's tracked and when instead of guessing.
2. **Tune one lever at a time**, in this order: dwell (`cps`) → band (`rootMargin`/`minRatio`) →
   velocity gate → reading line. They interact; changing several at once hides which mattered.
3. **Read a page for real** and watch: does each block you actually read fire, roughly when you finish
   it? Nothing on load, nothing while skimming?

## The levers, ranked by impact

| lever | raises / lowers | use when |
|---|---|---|
| **`cps`** | dwell per block | reads fire too early (lower cps) / take forever (raise cps) |
| **`rootMargin`** | size/position of the reading band | reads start too eagerly (shrink) / blocks never qualify (widen) |
| **`minRatio`** | how much of a block must be in the band | tall blocks never reach threshold (lower it) |
| **`scrollVelocity…`** | how settled you must be | timer runs while scrolling (tighten) / pauses on tiny nudges (loosen) |
| **`readingLineRatio`** | when a passed block releases focus | a read block sticks at the top blocking the next (raise toward 0.3) |

> **The core tension:** required dwell must be *achievable* within the time a block stays in the band as
> you read it. Too little dwell or too eager a band → everything counts on load. Too much dwell or too
> tight a band → nothing ever completes. The demo's job is to let you feel that balance.

## Presets

```js
// Desktop — faithful reading (≈200 wpm)
text: {
  cps: 20, minRatio: 0.35, rootMargin: '0% 0% -30% 0%', readingLineRatio: 0.25,
  scrollVelocityForFontSize: px => 0.05 * (px / 16) ** 10.32,   // settle to read; big headings lenient
  scrollQuietMs: 100,
}

// Desktop — snappier (≈300 wpm)
text: { cps: 30, minRatio: 0.4, rootMargin: '-10% 0% -25% 0%', scrollVelocityMax: 0.2, scrollQuietMs: 100 }

// Mobile — visibility-driven (idle gate auto-off on coarse pointer)
text: {
  minRatio: 0.30, scrollQuietMs: 150,
  scrollVelocityForFontSize: px => 0.15 * (px / 16) ** 8,        // PROVISIONAL — tune on a device
}
```

### Font-size-scaled velocity, explained

`scrollVelocityForFontSize: px => A * (px / 16) ** B` lets big text tolerate faster scrolling (you can
scan a heading mid-scroll, but a paragraph at that speed waits). Pick two anchor points and solve:
`B = ln(max₂/max₁) / ln(size₂/size₁)`. The demo's `0.05 * (px/16) ** 10.32` passes through
(16px → 0.05) and (20px → 0.5).

## Troubleshooting

| symptom | cause | fix |
|---|---|---|
| **Almost everything fires on page load** | dwell too low / band too eager / velocity gate disabled | raise `cps`; use a real `rootMargin` band; ensure the velocity gate isn't wide open (`scrollVelocityMax` not huge) |
| **First block fires, then nothing** | dwell can't complete before a block leaves a narrow band, and (sequential) downstream blocks never get their turn | widen the band so a block accrues over its whole on-screen time, or lower `cps` so dwell fits |
| **A block "sticks" active at the very top, blocking the one below** | a read block keeps focus while scrolled to the top | that's what `readingLineRatio` releases — ensure it's set (default 0.25); it keys off **document** position so above-the-fold still counts |
| **Mid-page refresh → nothing tracks** | top-of-viewport blocks looked "fresh" and held focus | fixed by the document-position above-the-fold rule — make sure you're on a current build (`readingLineRatio` set) |
| **The last paragraph never tracks** | it sits in the bottom band at max scroll and can't be scrolled up | `endOfDocument: true` (default) counts the last screen; don't disable it |
| **Several blocks fire at once on a pause** | parallel accrual | `sequential: true` (text default) makes them fire one-by-one, top-to-bottom |
| **Timer keeps running while I scroll** | velocity threshold too high | lower `scrollVelocityMax` / the curve; `0.02`–`0.05` px/ms is "only when nearly stationary" |
| **Timer won't start / pauses on tiny nudges** | velocity threshold too tight or `scrollQuietMs` too high | raise the threshold a touch; drop `scrollQuietMs` to ~100 ms |
| **Still readers get zeroed out on mobile** | input-idle gate firing | the plugin auto-sets `idleAfterMs:Infinity` on coarse pointer — verify the device reports `pointer: coarse`, or set it explicitly |
| **Tall paragraphs never qualify** | they can't reach `minRatio` of themselves inside a shrunk band | lower `minRatio` (e.g. 0.35) or widen `rootMargin` |

## A note on the demo's numbers vs the SDK defaults

The SDK ships conservative central-band defaults (`rootMargin:'-20%…'`, `minRatio:0.5`, `cps:30`). The
demo overrides several (`0% 0% -30%`, `0.35`, lower `cps`, a velocity curve, `scrollQuietMs:100`)
because it was tuned by feel for a specific page. **Treat the demo as a worked example, not gospel** —
your content's block sizes, column width, and audience reading speed all shift the sweet spot. Start
from a preset, then trust the live timer.
