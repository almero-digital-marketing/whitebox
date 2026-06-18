# Engagement plugin — documentation

How the plugin decides what someone genuinely read/watched, and every knob for tuning it.

## Read in order

1. **[01 · Architecture](01-architecture.md)** — three independent trackers over one generic state
   machine, plus the scanner/orchestrator that discovers opted-in elements.
2. **[02 · Reading model](02-reading-model.md)** — the heart: the reading band, sequential per-kind
   queues, reading-line release, above-the-fold, end-of-document, and pointer attention.
3. **[03 · Gates & dwell](03-gates-and-dwell.md)** — when time actually accrues (activity + velocity
   gates), the dwell formula, full vs partial reads, and the desktop↔mobile differences.
4. **[04 · Options](04-options.md)** — every option for the plugin and each tracker, with defaults.
5. **[05 · Images & video](05-images-and-video.md)** — image viewport-dwell and video
   watch-interval tracking.
6. **[06 · Events & transport](06-events-and-transport.md)** — event payloads, batching, `sendBeacon`,
   and how events become awareness exposures on the server.
7. **[07 · Tuning & recipes](07-tuning-and-recipes.md)** — practical tuning, ready presets, and a
   troubleshooting guide for the symptoms you'll actually hit.

## 30-second mental model

- You opt elements in with `data-wb-text` / `data-wb-image` / `data-wb-video`.
- A per-element **state machine** accrues time while the element is *visible in the reading zone* **and**
  the **gates** are open (you're present and not fast-scrolling).
- When accrued time reaches a length-based **threshold**, it fires a **read**; leaving early fires a
  **partial**.
- **Text** is *sequential*: one focused block at a time, top-to-bottom, per kind — modelling reading.
- **Image/video** are *parallel* and independent.
- Events are emitted locally (`wb.on(...)`) and streamed to the server.

## Conventions

- Modules are small and composable: a generic `tracker.js` (the state machine) + domain trackers
  (`text/image/video`) + gates (`activity`, `velocity`) + `pointer` + `scanner`.
- Everything is opt-in and SSR-safe (no-ops without `window`/`IntersectionObserver`).
- Defaults target *genuine reading*; the demo overrides a few for feel — both are documented.
