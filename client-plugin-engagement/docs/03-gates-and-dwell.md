# 03 · Gates & dwell

[02 · Reading model](02-reading-model.md) decided *which* block has focus. This is about *when* its
time actually accrues, and *how much* is enough.

## Gates — time only accrues when they're all open

A focused/visible block accrues dwell only while **every** gate is open.

### Activity gate (`activity.js`, from the core)

"Is the person actually present?" Open iff:

- the tab is **visible** (`document.visibilityState !== 'hidden'`), **and**
- the window is **focused**, **and**
- there was some interaction within `idleAfterMs` (default 30 s).

**On touch devices this is visibility-only.** A phone shows one thing at a time — if the page is
foregrounded you're looking at it, so "no input for 30 s" is a false negative for a still reader. So on
a coarse-pointer device the plugin defaults `idleAfterMs` to **`Infinity`** (the idle clock is off; the
gate rides on visibility + focus, which already cover app-switch and screen-lock). An explicit
`idleAfterMs` still wins. (Video uses `idleAfterMs:Infinity` everywhere — active playback *is*
engagement.)

### Velocity gate (`velocity.js`) — text only

"Are they settled enough to be reading, or skimming past?" Open iff the scroll speed is at or below a
threshold (or the page has been still for `scrollQuietMs`). Images **don't** use this — slow scrolling
past an image still counts as a look.

The threshold can be a flat number **or scale with the element's font size** — big headings tolerate
faster scrolling than body text:

```js
// flat:
scrollVelocityMax: 0.4,                              // px/ms (≈400 px/s)
// linear in font size:
scrollVelocityFactor: 0.003,                         // max = factor × fontSize(px)
// arbitrary curve (the demo): a power law through (16px→0.05) and (20px→0.5)
scrollVelocityForFontSize: px => 0.05 * (px / 16) ** 10.32,
```

`scrollQuietMs` (default 250; demo 100) is how long after you stop scrolling the gate re-opens. The
gate is evaluated **per element**, so at one scroll speed a heading can be counting while a paragraph
waits — that's the font-size scaling at work.

## Dwell — how much time is "read"

For text, the required dwell **scales with length**:

```
required_ms = clamp( text.length / cps × 1000,  minRequiredMs,  capRequiredMs )
```

| param | default | meaning |
|---|---|---|
| `cps` | `30` | assumed reading speed (chars/sec). ~30 ≈ 300 wpm. **Lower = slower = more dwell.** |
| `minRequiredMs` | `1500` | floor — even a short line needs ~1.5 s |
| `capRequiredMs` | `30 000` | ceiling — a huge block can't demand more than this |

Examples at `cps:30`: a 90-char line → 3 s; a 200-char paragraph → 6.7 s; a 330-char paragraph → 11 s.

> **Tuning intuition:** `cps` is your main dwell lever. The required dwell must be *achievable* in the
> time a block stays in the reading band as you read — too low and everything counts on load, too high
> and nothing ever completes. See [07 · Tuning](07-tuning-and-recipes.md).

Images use a **fixed** dwell (`requiredMs`, default 3 s). Video doesn't use dwell at all — it counts
played seconds ([05](05-images-and-video.md)).

## Full read vs partial read

```
accumulated_ms ≥ required_ms                          → READ      (partial:false)
left/unmounted early, accumulated ≥ minPartialRatio·required → PARTIAL (partial:true)
left early, below that                                → nothing
```

`minPartialRatio` defaults to `0.5` — get halfway and leaving still records a partial (with the real
`ms_spent`). Partials are how a 10-second visit still produces data: an in-progress read is flushed via
`sendBeacon` on unload ([06](06-events-and-transport.md)).

## Desktop vs mobile, summarized

| | desktop (fine pointer) | mobile (coarse pointer) |
|---|---|---|
| activity gate | visible + focused + active within `idleAfterMs` (30 s) | visible + focused (**idle off**) |
| pointer attention | **on** (mouse-rest moves focus) | inert (no hover) → scroll-driven sequential |
| velocity tuning | wheel/trackpad speeds | touch flick/momentum (tune separately) |

The plugin auto-detects `pointer: coarse` and flips the idle gate; the velocity *values* you should
still tune by feel on a device — see [07 · Tuning](07-tuning-and-recipes.md).
