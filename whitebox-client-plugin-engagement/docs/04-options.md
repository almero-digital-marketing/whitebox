# 04 · Options

Pass options to `engagement(options)`. Each tracker takes its own block; set a tracker to `false` to
disable it. Defaults shown are the **SDK defaults** — the demo overrides a few for feel (noted).

```js
engagement({
  flushIntervalMs: 5000,
  batchSize: 10,
  text:  { /* … */ },   // or false
  image: { /* … */ },   // or false
  video: { /* … */ },   // or false
})
```

## Plugin-level

| option | default | meaning |
|---|---|---|
| `flushIntervalMs` | `5000` | max time a buffered event waits before being sent |
| `batchSize` | `10` | flush immediately once this many events are buffered |
| `text` / `image` / `video` | `{}` | per-tracker options, or `false` to disable |

## `text`

### Reading model ([02](02-reading-model.md))
| option | default | demo | meaning |
|---|---|---|---|
| `sequential` | `true` | — | one focused block at a time (vs parallel) |
| `rootMargin` | `'-20% 0% -20% 0%'` | `'0% 0% -30% 0%'` | the reading band edges |
| `minRatio` | `0.5` | `0.35` | fraction of a block that must be in the band |
| `readingLineRatio` | `0.25` | — | block releases focus when its middle passes above this |
| `endOfDocument` | `true` | — | count the document's last screen (bottom band) |
| `pointerAttention` | `true` | — | mouse-rest moves focus (desktop only) |
| `pointerDwellMs` | `500` | — | how long the mouse must rest before it counts |

### Dwell ([03](03-gates-and-dwell.md))
| option | default | meaning |
|---|---|---|
| `cps` | `30` | reading speed (chars/sec); lower = more dwell |
| `minRequiredMs` | `1500` | dwell floor |
| `capRequiredMs` | `30000` | dwell ceiling |
| `minPartialRatio` | `0.5` | fraction of required dwell to record a partial |
| `tickMs` | `250` | accrual tick interval |

### Velocity gate ([03](03-gates-and-dwell.md))
| option | default | meaning |
|---|---|---|
| `scrollVelocityForFontSize` | — | `px => maxVelocity` curve (takes precedence) |
| `scrollVelocityFactor` | — | linear: `max = factor × fontSize(px)` |
| `scrollVelocityMax` | `1.0` | flat fallback, px/ms (≈1000 px/s) |
| `scrollQuietMs` | `250` | how long after scrolling stops the gate re-opens |

### Activity gate
| option | default | meaning |
|---|---|---|
| `idleAfterMs` | `30000` (fine) / `Infinity` (coarse pointer) | idle timeout; auto-off on touch |

### Discovery
| option | default | meaning |
|---|---|---|
| `selector` | `'[data-wb-text]'` | what counts as opted-in text |
| `excludeSelector` | (built-in) | elements to skip |
| `idAttribute` | `'data-wb-text'` | attribute whose value is the stable id |
| `minLength` | `3` | ignore shorter text nodes |

## `image`

| option | default | meaning |
|---|---|---|
| `requiredMs` | `3000` | viewport dwell to count as engaged |
| `minRatio` | `0.5` | fraction in the band |
| `rootMargin` | `'-20% 0% -20% 0%'` | the dwell band |
| `minPartialRatio` | `0.5` | partial threshold |
| `idleAfterMs` | (as above) | activity gate idle timeout |
| `selector` / `idAttribute` | `'[data-wb-image]'` | discovery |

Images are **parallel** (no `sequential`) and **don't** use the velocity gate.

## `video`

| option | default | meaning |
|---|---|---|
| `flushAfterPausedMs` | `30000` | end a watch session after this much paused-without-resume |
| `minViewportRatio` | `0.5` | how much of the player must be visible to count playback |
| `rootMargin` | `'0% 0% 0% 0%'` | full viewport |
| `countMuted` | `true` | count muted playback as watched |
| `selector` / `idAttribute` | `'[data-wb-video]'` | discovery |

> The first time a video is watched, the server may transcribe the watched portion (Whisper + frame
> vision), which calls a model. Set `video:false` to skip video entirely.

## Quick presets

```js
// Desktop, faithful reading (the demo)
text: {
  cps: 20, minRatio: 0.35, rootMargin: '0% 0% -30% 0%', readingLineRatio: 0.25,
  scrollVelocityForFontSize: px => 0.05 * (px / 16) ** 10.32, scrollQuietMs: 100,
}

// Mobile (auto idle-off; tune velocity by feel on a device)
text: {
  minRatio: 0.30, scrollQuietMs: 150,
  scrollVelocityForFontSize: px => 0.15 * (px / 16) ** 8,
}
```

See [07 · Tuning](07-tuning-and-recipes.md) for how to arrive at numbers like these.
