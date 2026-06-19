<div align="center">

# whitebox-pro-client-plugin-engagement

**Measure what a person actually read, watched, and listened to — not just what loaded.**

A browser plugin for the WhiteBox client SDK. It watches reading, image dwell, and video playback,
decides when something was *genuinely* engaged with (settled attention, not a scroll-past), and streams
those events to WhiteBox — where they become part of the person's cross-channel memory.

</div>

---

## What it does

Drop a `data-wb-text` / `data-wb-image` / `data-wb-video` / `data-wb-link` attribute on the things you
care about, and the plugin tells you — per element, per person — *that they read it, for how long, and
how much.*

- **Text** — paragraph/heading reading, modelled on how people actually read: top-to-bottom, one block
  at a time, with dwell proportional to length. Pointer-aware on desktop, visibility-driven on mobile.
- **Image** — viewport dwell (≥3s by default).
- **Video** — the *disjoint intervals actually played* and completion %, not just "played".
- **Link** — a click on a `data-wb-link` anchor: a **strong intent signal**, recorded as an active
  expression (not passive reading). The label comes from the link's text, or from the attribute value
  when the visible text is generic — `<a data-wb-link="dental implant pricing">Learn more</a>` records
  interest in *"dental implant pricing"*, not *"Learn more"*.

It distinguishes a **read** from a **skim**: a block only counts once it has held settled attention in
the reading zone — fast scrolling, idle tabs, and background pages don't accrue.

## Install

```bash
npm i whitebox-pro-client-plugin-engagement
```

```js
import whitebox from 'whitebox-pro-client'
import engagement from 'whitebox-pro-client-plugin-engagement'

const wb = whitebox({
  url: 'https://your-whitebox-pro-server',
  plugins: [ engagement() ],     // defaults are sensible; tune per docs/04-options.md
})
```

Then mark up your content:

```html
<h1  data-wb-text="title">Reading, watching, listening</h1>
<p   data-wb-text="intro">Scroll down and pause to read…</p>
<img data-wb-image="hero" alt="…" src="…">
<video data-wb-video="demo" controls src="…"></video>
<a   data-wb-link="implant pricing" href="/implants">Learn more</a>
```

That's it — opted-in elements are discovered automatically (including ones added later, SPA routes
included).

## See it run

A complete, runnable fixture lives in **[`examples/engagement/`](../examples/engagement)** — a static
page wired to a real server with a live per-element timer overlay so you can *watch* what's tracked and
when. One command:

```bash
cd examples/engagement && node serve.mjs   # → http://localhost:5173
```

## Listen to engagement

```js
wb.on('engagement.text',  e => console.log('read', e.id, e.ms_spent, 'ms', e.partial ? '(partial)' : ''))
wb.on('engagement.image', e => console.log('viewed', e.id, e.ms_spent, 'ms'))
wb.on('engagement.video', e => console.log('watched', e.id, e.completion_pct, '%', e.intervals))
wb.on('engagement.link',  e => console.log('clicked', e.text, '→', e.href))
wb.on('engagement.progress', p => {/* live dwell tick — drives a UI timer */})
```

Events are also **batched and streamed to the server** automatically (socket-primary, HTTP fallback,
`sendBeacon` on unload). See [docs/06](docs/06-events-and-transport.md).

## The reading model in one picture

Text uses a moving **reading band** and a single **focus** that walks top-to-bottom:

```
  0% ┌─────────────────────────┐ ← top of viewport
     │  RELEASED                │  a block scrolled up here lets go of focus
 25% ├─────────────────────────┤ ← reading line
     │   ACTIVE reading band    │  the one focused block accrues dwell here
 70% ├─────────────────────────┤ ← band bottom
     │  ARRIVING (not yet)      │  must rise into the band before it can take focus
100% └─────────────────────────┘ ← bottom of viewport
```

Headings and paragraphs run as **independent** top-to-bottom queues; above-the-fold and
end-of-document blocks are handled specially; on desktop, **resting your mouse on a block** moves focus
there. Full model: [docs/02-reading-model.md](docs/02-reading-model.md).

## Config at a glance

```js
engagement({
  flushIntervalMs: 2000,
  batchSize: 5,
  text: {
    cps: 30,                       // reading speed → dwell per char
    minRatio: 0.35,
    rootMargin: '0% 0% -30% 0%',   // the reading band
    readingLineRatio: 0.25,
    scrollVelocityForFontSize: px => 0.05 * (px / 16) ** 10.32,  // settle-to-read
  },
  image: { requiredMs: 3000 },
  video: true,                     // or false to disable a tracker
})
```

Every knob, with defaults and what it does: [docs/04-options.md](docs/04-options.md). Mobile/desktop
differences are automatic — [docs/03](docs/03-gates-and-dwell.md).

## Documentation

| | |
|---|---|
| [01 · Architecture](docs/01-architecture.md) | trackers, the generic state machine, scanner/orchestrator |
| [02 · Reading model](docs/02-reading-model.md) | the band, sequential per-kind queues, reading-line release, above-the-fold, end-of-document, pointer attention |
| [03 · Gates & dwell](docs/03-gates-and-dwell.md) | activity + velocity gates, the dwell formula, full vs partial, desktop vs mobile |
| [04 · Options](docs/04-options.md) | full reference — plugin, text, image, video |
| [05 · Images & video](docs/05-images-and-video.md) | image dwell, video watch-interval tracking |
| [06 · Events & transport](docs/06-events-and-transport.md) | event payloads, batching, beacon, and what the server does with them |
| [07 · Tuning & recipes](docs/07-tuning-and-recipes.md) | practical tuning, presets, and a troubleshooting guide |

## Status & footprint

No dependencies; tree-shakeable (`sideEffects:false`). Trackers are independent — disable any with
`text:false` / `image:false` / `video:false`. SSR-safe (everything no-ops without `window`). Backed by
67 tests (`npm test`).
