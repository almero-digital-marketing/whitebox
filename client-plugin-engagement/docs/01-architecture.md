# 01 · Architecture

## Three trackers, one state machine

```
                          engagementPlugin(options)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  index.js   buffer · batch · flush · transport · emit · manual section()   │
 │     ├──▶ text.js     sequential reading  ─┐                                 │
 │     ├──▶ image.js    parallel dwell       ├─ each wraps ─▶ tracker.js       │
 │     └──▶ video.js    watch intervals (own state machine, not tracker.js)   │
 │                                                                            │
 │  tracker.js   generic per-element state machine (visibility · gates ·      │
 │               accrue · fire). text + image share it; video is bespoke.     │
 │     ├─ gates: activity.js (core) · velocity.js · (pointer.js for focus)    │
 │     └─ scanner.js + whitebox-pro-client/orchestrator  ── discover opted-in els │
 └──────────────────────────────────────────────────────────────────────────┘
```

The three trackers are **independent** — each has its own `IntersectionObserver` and its own element
set. They never interfere; disable any with `text:false` / `image:false` / `video:false`.

## The generic state machine — `tracker.js`

Per opted-in element it holds a small state record and, on a 250 ms tick:

```
element visible (≥ minRatio inside rootMargin) ?  AND  all gates open ?
   → accrue elapsed time into accumulated_ms
   → accumulated_ms ≥ requiredMs(el)  → fire a READ (onRead), stop observing
   → element removed early & accumulated ≥ minPartialRatio·required → fire a PARTIAL
```

The domain trackers inject the parts that differ:

| hook | text | image |
|---|---|---|
| `requiredMs(el)` | length-based (`chars / cps`) | fixed (`requiredMs`, 3 s) |
| `gates` | activity **+** velocity | activity only |
| `buildPayload(el, state)` | text/kind/level/length | src/alt/dims |
| `sequential` | **true** (one focus at a time) | false (parallel) |

Everything about *reading order* (focus, the reading line, above-the-fold, end-of-document, pointer
attention) lives in the tracker's `sequential` path — see [02 · Reading model](02-reading-model.md).

## Discovery — scanner + orchestrator

`scanner.js` defines what counts as opted-in (default selectors `[data-wb-text]`, `[data-wb-image]`,
`[data-wb-video]`) and how to read an element's stable id (the attribute value). The shared
`whitebox-pro-client/orchestrator` handles the lifecycle:

- initial scan on `start()`,
- a `MutationObserver` to pick up elements added later,
- re-scan on `history.pushState` (SPA navigation),
- de-dup (a `WeakSet`) so nothing is observed twice.

So you never register elements manually — mark them up and they're tracked, even if they arrive after
load.

## Video is its own machine — `video.js`

Viewport-dwell doesn't describe video, so `video.js` does **not** use `tracker.js`. It listens to
`play/pause/timeupdate/seeking/ended` + PiP/fullscreen + visibility, and maintains the **disjoint
intervals actually watched**, emitting one event per watch session. See
[05 · Images & video](05-images-and-video.md).

## Lifecycle

```
plugin.install(core)
  → build text/image/video trackers (per options; false = skip)
  → core.queue(() => tracker.start())          // after the SDK is ready
  → tracker.start(): attach gates, create IO, begin ticking
  → on read/partial: onRead → enqueue(event) + emitter.emit(...)
  → enqueue: buffer → flush at batchSize or flushIntervalMs
  → flush: transport.send('engagement.batch') | POST /engagement/events
  → pagehide / visibility hidden: sendBeacon flush
plugin stop(): stop all trackers, clear the flush timer
```

## SSR / environment safety

Everything guards on `window` and `IntersectionObserver`. On the server (SSR) or in a test without a
DOM, `start()` is a no-op and nothing throws — the plugin simply produces no events.
