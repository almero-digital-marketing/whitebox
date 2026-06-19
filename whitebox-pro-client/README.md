# @whitebox/client

Browser client library for [whitebox-pro-server](../whitebox-pro-server). Sits on customer websites, manages passport/session identity, ships engagement events, submits contact forms, and tracks conversions.

## Install

```bash
npm install @whitebox/client
```

`socket.io-client` ships as a dependency — whitebox-pro-server uses Socket.IO and the client must match.

## Quick start

```js
import whitebox from '@whitebox/client'
import mail from '@whitebox/client/mail'

const wb = whitebox({ url: 'https://api.example.com' })
  .use(mail())

await wb.ready

document.querySelector('#contact').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  await wb.mail.submit({
    from: fd.get('email'),
    subject: fd.get('subject'),
    body: fd.get('body'),
    files: fd.getAll('attachments'),
  })
})
```

## Architecture

```
@whitebox/client
├── core              - passport/session identity, transport, emitter, storage
├── /mail             - POST /mail/inbox (contact form)
├── /engagement       - text + image + video trackers + manual section helper
│   ├── scanner.js, tracker.js, orchestrator.js, activity.js, velocity.js  (shared building blocks)
│   ├── text.js       (paragraphs + headings; length-based required time + velocity gate)
│   ├── image.js      (images; fixed required time, no velocity gate)
│   └── video.js      (videos; tracks watched intervals via playback events)
├── /voip             - phone-number pool tracking (aggressive release)
├── /conversions      - POST /conversions/events (ad-network CAPI feed)
└── /consent          - opt-in management
```

Each plugin is a separate entry point. Pay only for what you use.

## API

### `whitebox(opts) → wb`

| Option | Default | Description |
|---|---|---|
| `url` | required | Whitebox server base URL |
| `transport` | `true` | Open a Socket.IO connection on init. Set `false` for HTTP-only sites (e.g. just contact forms) |
| `autoResolveSession` | `true` | POST `/sessions/resolve` on init to mint a session and link passport |
| `config` | `{}` | Per-plugin configuration object. Each key is a plugin name; the value is passed into that plugin's `install()`. See [Centralised config](#centralised-config) |
| `logger` | `console` | Where warnings/errors go |

### Centralised config

Instead of (or alongside) passing options to each `.use(plugin(opts))`, you can declare config once at init:

```js
const wb = whitebox({
  url: 'https://api.example.com',
  config: {
    engagement: {
      batchSize: 20,
      flushIntervalMs: 3000,
      text: {
        selector: '.article-paragraph, .article-heading',  // custom CSS selector
        excludeSelector: '.article--no-track',
        idAttribute: 'data-section-id',
        cps: 25,
        capRequiredMs: 20000,
      },
    },
    consent: {
      required: ['analytics', 'marketing'],
    },
  },
})
  .use(engagement())   // picks up engagement config from whitebox.config
  .use(consent())
```

Plugins read their slot via `core.config`. `.use(plugin(localOpts))` opts deep-merge **over** the whitebox config. So you can declare defaults centrally and override per-`.use()` if needed.

This pattern is useful when:
- Config is fetched from your backend on page load (e.g. per-tenant settings)
- A/B tests change the selector or reading speed dynamically
- You want a single source of truth that's easy to audit

Returns an instance with:

- `wb.ready` — Promise that resolves when init completes
- `wb.passportId`, `wb.sessionId` — current ids (or `null` before ready)
- `wb.use(plugin)` — register a plugin (returns `wb` for chaining)
- `wb.on(event, fn)`, `wb.off(event, fn)` — subscribe to events
- `wb.forget()` — clear local state (GDPR client-side; pair with server-side delete)
- `wb.destroy()` — tear down

### `mail` plugin

```js
import mail from '@whitebox/client/mail'
wb.use(mail())

await wb.mail.submit({
  from: 'user@example.com',     // required
  subject: 'Hello',             // required
  body: 'Long message...',      // optional
  files: [file1, file2],        // optional File[]
  to: 'sales@example.com',      // optional
  data: { source: 'footer' },   // optional jsonb passthrough
})
```

Sends as `multipart/form-data` if files are present, otherwise JSON.

### `engagement` plugin

```js
import engagement from '@whitebox/client/engagement'
wb.use(engagement({
  batchSize: 10,
  flushIntervalMs: 5000,

  text: {                                      // text tracking
    selector: '[data-wb-text]',                // CSS selector (default)
    excludeSelector: '[data-wb-notext]',       // CSS opt-out (self or ancestor)
    idAttribute: 'data-wb-text',               // stable-id attribute
    cps: 30,                                   // reading speed (chars/sec)
    capRequiredMs: 30000,                      // never demand more than 30s
  },

  image: {                                     // image tracking
    selector: '[data-wb-image]',               // CSS selector (default)
    excludeSelector: '[data-wb-noimage]',      // CSS opt-out
    idAttribute: 'data-wb-image',              // stable-id attribute
    requiredMs: 3000,                          // viewport-time to register as engaged
  },

  video: {                                     // video tracking
    selector: 'video[data-wb-video]',          // CSS selector (default)
    excludeSelector: '[data-wb-novideo]',
    idAttribute: 'data-wb-video',
    flushAfterPausedMs: 30000,                 // long pause → end of watch session
    minViewportRatio: 0.5,                     // ≥50% of video in viewport
    countMuted: true,                          // muted playback still counts
  },
}))

// Manual triggers (in addition to the automatic trackers)
wb.engagement.section({ id: 'pricing', text: section.innerText, dwell_ms: 12000 })

// Listen for engagement events (optional — events also flow to the server)
wb.on('engagement.text',  ({ id, kind, ms_spent, partial }) => { /* ... */ })
wb.on('engagement.image', ({ id, src, ms_spent, partial }) => { /* ... */ })
wb.on('engagement.video', ({ id, src, total_watched_s, completion_pct, partial }) => { /* ... */ })
```

**Text tracking** is pure opt-in. By default, mark any element with `data-wb-text` to track it. Nothing is auto-detected — if it doesn't match the selector, it isn't observed. The selector is configurable, so you can use your own attribute, class, or any CSS expression.

- Default: `<p data-wb-text>`, `<h1 data-wb-text>`…`<h6 data-wb-text>`, or any element with the attribute is eligible
- Custom selector via config (`config.engagement.text.selector` or `.use(engagement({ text: { selector: '...' } }))`)
- An optional value becomes a stable id (`data-wb-text="pricing-cta"`); without one, the id is a hash of the textContent
- Custom id attribute via `idAttribute: 'data-section-id'`
- `data-wb-notext` on an element or any ancestor excludes it (also customisable via `excludeSelector`)
- Only counts elements in the **middle 60% of the viewport** (excludes top/bottom 20%)
- Requires the tab to be visible, focused, and not idle (>30s of no input)
- Requires scroll velocity to be stable (not skimming)
- Fires `engagement.text` events when the user spent enough time on the element (`text_length / cps` seconds, capped at 30s)
- Survives SPA navigation via MutationObserver + `pushState`/`popstate` hooks

Disable entirely with `text: false`. Example markup:

```html
<!-- Tracked: paragraph with explicit stable id -->
<p data-wb-text="enterprise-sso">The Enterprise tier includes SSO, audit logs...</p>

<!-- Tracked: heading without explicit id (hash-derived) -->
<h2 data-wb-text>Pricing</h2>

<!-- Untracked: no attribute -->
<p>This paragraph is ignored.</p>

<!-- Tracked nothing inside, even with opt-in -->
<footer data-wb-notext>
  <p data-wb-text>Skipped because the footer opts out.</p>
</footer>

<!-- Tracked: any element, not just p/h -->
<div data-wb-text="value-prop">Opt-in non-standard tag.</div>
```

**Image tracking** mirrors text but with two key differences:

- **Fixed required time** (default 3000 ms) regardless of image size or content
- **No velocity gate** — the user can scroll slowly past an image and it still counts as engaged

Default selector is `[data-wb-image]`. Disable with `image: false`. Example markup:

```html
<!-- Tracked: img with stable id -->
<img src="/hero.png" alt="Enterprise hero" data-wb-image="hero-banner">

<!-- Tracked: img without explicit id (src-hashed) -->
<img src="/chart.png" data-wb-image>

<!-- Tracked: opt-in on a wrapper; src/alt extracted from child <img> -->
<figure data-wb-image="pricing-chart">
  <img src="/pricing-chart.svg" alt="Tier comparison chart">
</figure>

<!-- Untracked: no attribute -->
<img src="/logo.svg">

<!-- Opt-out region -->
<aside data-wb-noimage>
  <img src="/sidebar-ad.png" data-wb-image>
</aside>
```

The emitted event shape:

```js
{
  type: 'engagement.image',
  ts: '...',
  id: 'hero-banner' | 'wb:<hash>',
  kind: 'image',
  src: 'https://cdn.example.com/hero.png',
  alt: 'Enterprise hero',
  width: 1920,        // naturalWidth if available
  height: 1080,
  ms_spent: 3247,
  url: 'https://example.com/...',
  partial: false,
}
```

**Video tracking** observes actual playback — not viewport time. The library listens to `<video>` element events and maintains the set of seconds the user actually played, accounting for scrubbing, pausing, and resuming. The server slices the cached transcript (Whisper + frame Vision) to embed **only the portion the user watched**.

Default selector is `video[data-wb-video]`. Disable with `video: false`. Markup:

```html
<!-- Tracked: video with stable id -->
<video src="/intro.mp4" data-wb-video="intro" controls></video>

<!-- Tracked: video without explicit id (src-hashed) -->
<video src="/demo.mp4" data-wb-video controls></video>

<!-- Untracked: no attribute -->
<video src="/ad.mp4"></video>

<!-- Opt-out region -->
<aside data-wb-novideo>
  <video src="/sidebar.mp4" data-wb-video></video>
</aside>
```

One event is emitted per **watch session**. A session ends when:
- video reaches its end (`ended`)
- user pauses for ≥30s without resuming (`flushAfterPausedMs`)
- element scrolls out of viewport while paused
- page hides / unloads (sendBeacon)
- element is removed from the DOM (SPA navigation)

Each event carries the disjoint intervals actually watched, accounting for seek-forward, seek-back, and pause-resume. The server slices the transcript to those intervals before embedding.

```js
{
  type: 'engagement.video',
  ts: '...',
  id: 'intro' | 'wb:<hash>',
  kind: 'video',
  src: 'https://cdn.example.com/intro.mp4',
  duration_s: 240,
  intervals: [
    { start_s: 0, end_s: 47.8 },
    { start_s: 120, end_s: 240 }
  ],
  total_watched_s: 167.8,
  completion_pct: 70.0,
  ms_spent: 167800,
  url: 'https://example.com/page',
  muted: false,
  partial: false   // true if session was cut short by pagehide
}
```

PiP (`enterpictureinpicture`) and fullscreen are treated as visible — the viewport gate is bypassed in those modes. The activity gate (tab focus) still applies. Idle-detection is disabled for video (active playback IS engagement).

Buffers events; flushes on threshold or interval. Final flush on `pagehide` via `navigator.sendBeacon`.

The live path uses the Socket.IO connection (`engagement.batch` event). HTTP fallback via `POST /engagement/events` works automatically when the socket isn't connected.

### `voip` plugin

Phone-number tracking. Each `[data-wb-phone="<tag>"]` element on the page belongs to a logical CTA (e.g. `sales`, `support`). When elements with a given tag become visible, the plugin requests a trackable number from the server-side pool, swaps it into the DOM, and emits `voip.click` if the user clicks the link. When the user shows signs of leaving (tab hidden, blur, idle, viewport exit, pagehide), the number is released immediately so it can be reused by another visitor.

```js
import voip from '@whitebox/client/voip'

const wb = whitebox({
  url: '...',
  config: {
    voip: {
      selector: '[data-wb-phone]',
      excludeSelector: '[data-wb-nophone]',
      releaseDelayMs: 2000,    // viewport-leave grace period (flap protection)
      maxHoldMs: 60_000,       // release after this long without a click
      idleAfterMs: 30_000,     // user input idle threshold
      requestBackoffMs: 5_000, // wait this long after `voip.unavailable`
    },
  },
}).use(voip())

// Listen for assignments / unavailable / ring events
wb.on('voip.number',      ({ tag, number, formatted }) => { /* ... */ })
wb.on('voip.unavailable', ({ tag }) => { /* show original number / generic CTA */ })
wb.on('voip.click',       ({ tag, number }) => { /* fire conversion pixel? */ })
wb.on('voip.ring',        ({ tag, caller, number }) => { /* show "we got your call" toast */ })

// Manual API (rarely needed)
wb.voip.request('sales')      // explicit request even if no element is visible
wb.voip.release('sales')      // explicit release
wb.voip.current('sales')      // → { number, formatted, state } | null
```

**Markup:**

```html
<!-- Hero CTA -->
<a data-wb-phone="sales" href="tel:+15551111111">+1 (555) 111-1111</a>

<!-- Sticky footer with the same tag — both swap to the same number -->
<a data-wb-phone="sales" href="tel:+15551111111">Call sales</a>

<!-- Different tag = different pool -->
<a data-wb-phone="support" href="tel:+15552222222">Support: +1 (555) 222-2222</a>

<!-- Opt-out region -->
<aside data-wb-nophone>
  <a data-wb-phone="sales" href="tel:+15551111111">Not tracked</a>
</aside>
```

**Aggressive release** — any of these triggers an immediate `voip.hang`:
- Element scrolls out of viewport (after a 2 s grace period for flap protection)
- Tab becomes hidden (`visibilitychange`)
- Window loses focus (`blur`)
- User input idle for `idleAfterMs`
- Number held for `maxHoldMs` without a click
- Element removed from the DOM (SPA navigation)
- Page hides/unloads (sendBeacon fallback)

**Click locks the tag** — once the user clicks a phone link, the tag enters the `clicked` state and skips all auto-release triggers until pagehide or explicit `release()`. The server extends the hold to `CLICKED_HOLD_TIMEOUT` (5 min in production) so the actual call has time to reach Asterisk.

**One number per tag, shared across elements** — if your page has 3 visible elements with `data-wb-phone="sales"`, they all show the same number. Use different tag values if you want per-placement attribution.

### `conversions` plugin

```js
import conversions from '@whitebox/client/conversions'
wb.use(conversions())

const { event_id } = await wb.conversions.track('lead', { value: 0, meta: { src: 'contact-form' } })

// Pass the same event_id to the browser pixel for dedup:
fbq('track', 'Lead', {}, { eventID: event_id })
```

### `consent` plugin

```js
import consent from '@whitebox/client/consent'
wb.use(consent({ required: ['analytics', 'marketing'] }))

wb.consent.grant('analytics')
wb.consent.has('marketing')      // false
wb.consent.allGranted()          // false until all required granted
```

Pure client-side gate. Server-side enforcement is separate.

## Bundle budgets

```
dist/index.js          ≤ 8 KB gz   (core)
dist/mail.js           ≤ 3 KB gz
dist/engagement.js     ≤ 8 KB gz   (text + image + video trackers + shared)
dist/voip.js           ≤ 4 KB gz   (phone-number pool tracking)
dist/conversions.js    ≤ 3 KB gz
dist/consent.js        ≤ 2 KB gz
```

CI enforces these via `npm run size`.

## Development

```bash
npm install
npm run dev    # tsup --watch
npm test       # vitest
npm run build  # produces dist/
npm run size   # bundle-size check
```

Tests run under `happy-dom` — no real browser needed.

## Compatibility

- Evergreen browsers (last 2 versions of Chrome, Firefox, Safari, Edge)
- Node 18+ (for build tooling)
- Targets `es2020`

No IE11. No Node-in-browser polyfills. Modern only.
