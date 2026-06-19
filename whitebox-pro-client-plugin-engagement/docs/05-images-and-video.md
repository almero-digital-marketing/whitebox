# 05 · Images & video

Both are **independent** of text and of each other — separate trackers, parallel, no reading order.

## Images

Opt in with `data-wb-image`. An image counts as engaged when it has been **≥ `requiredMs` (default 3 s)
in the viewport** with the activity gate open. Unlike text:

- **parallel** — every visible image accrues at once (no single focus),
- **no velocity gate** — slowly scrolling past an image still counts as a look,
- **fixed dwell** — `requiredMs`, not length-based.

### Event

```js
wb.on('engagement.image', e => { /* … */ })
// { id, kind:'image', src, alt, width, height, ms_spent, url, partial }
```

`src`/`alt`/`width`/`height` come from the `<img>` (or a child `<img>` of a tagged wrapper). **`alt`
is meaningful**: the server uses it as the image's description instead of calling a vision model, so
good `alt` text is cheaper *and* more accurate.

A partial fires if the image leaves the viewport after ≥ `minPartialRatio` of `requiredMs`.

## Video

Opt in with `data-wb-video`. Video is **not** viewport-dwell — "the player was on screen" says nothing
about watching. So `video.js` is its own state machine that tracks **what was actually played**.

### What it measures

It listens to `play / pause / timeupdate / seeking / seeked / ended`, Picture-in-Picture, fullscreen,
and page visibility, and maintains the **disjoint intervals of media time actually played** while the
video was effectively visible and the page active. Re-watching a section doesn't double-count;
scrubbing forward doesn't fabricate watched time.

A **watch session** ends — and an event fires — when:

- the video reaches `ended`,
- it's been paused for `flushAfterPausedMs` (default 30 s) without resuming,
- it scrolls out of the viewport while paused,
- the page hides / unloads (flushed via the plugin), or
- the element is removed (SPA navigation).

"Effectively visible" includes **PiP and fullscreen** — watching in a floating player still counts.
`countMuted` (default `true`) counts muted playback.

### Event

```js
wb.on('engagement.video', e => { /* … */ })
// {
//   id, kind:'video', src, duration_s,
//   intervals: [ { start_s, end_s }, … ],   // the disjoint watched ranges
//   total_watched_s, completion_pct,         // % of duration actually watched
//   ms_spent, url, muted, partial
// }
```

`completion_pct` is `total_watched_s / duration_s` — real coverage, not furthest-point-reached.

### Server note

The first time anyone watches a given video, the server may transcribe the watched portion (Whisper +
frame vision) so the content becomes part of awareness — this calls a model. Identical content is
embedded once and shared across viewers ([06](06-events-and-transport.md)). Set `video:false` to skip.

## Why the asymmetry

| | text | image | video |
|---|---|---|---|
| model | sequential reading | parallel dwell | played intervals |
| order | top-to-bottom, per kind | none | none |
| dwell | length-based | fixed 3 s | n/a (counts seconds) |
| velocity gate | yes | no | no |

Each measures what "engaged" actually means for that medium — and because they're separate trackers,
tuning one never affects the others.
