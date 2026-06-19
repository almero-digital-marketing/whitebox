# 06 · Events & transport

## Local events

Every read also emits on the client emitter, so your app can react in real time:

```js
wb.on('engagement.text',  e => …)
wb.on('engagement.image', e => …)
wb.on('engagement.video', e => …)
wb.on('engagement.progress', p => …)   // live dwell tick — drives a UI timer
```

### Payloads

```js
// engagement.text
{ id, kind:'paragraph'|'heading', level, text, length_chars, ms_spent, url, partial }
// engagement.image
{ id, kind:'image', src, alt, width, height, ms_spent, url, partial }
// engagement.video
{ id, kind:'video', src, duration_s, intervals:[{start_s,end_s}], total_watched_s, completion_pct, ms_spent, url, muted, partial }
// engagement.progress  (fires every tick for the accruing element + once on pause)
{ kind:'text'|'image', id, ms_spent, required_ms, ratio, reading, url }
```

`engagement.progress` is the live signal the demo uses to render a per-element timer badge: `ratio`
(0..1) and `reading` (true while accruing, false when it pauses/freezes).

### Manual sections

For content that isn't a DOM element you can tag (e.g. a virtualized list, or server-rendered region),
emit a read yourself:

```js
wb.engagement.section({ id, url, text, dwell_ms, meta })   // → engagement.section
```

## Transport — how events reach the server

Reads are **buffered**, then flushed:

```
enqueue(event)
  → buffer.length ≥ batchSize        → flush now
  → else (re)arm a flushIntervalMs timer
flush():
  → socket connected?  transport.send('engagement.batch', { events })   ← primary
  → else               POST /engagement/events { events }                ← fallback (needs passport_id)
pagehide / visibilitychange→hidden:
  → navigator.sendBeacon → POST /engagement/events                       ← never lose an in-flight read
```

- **Socket-primary** keeps it cheap and live; the HTTP path is the fallback when the socket is down.
- The **beacon on unload** is why a 10-second visit still produces data — the in-progress (partial)
  read is flushed as the page goes away.
- Batching is controlled by `batchSize` / `flushIntervalMs` ([04](04-options.md)).

## What the server does with them

On the WhiteBox server the engagement endpoint records each event as an **awareness exposure**:

- `channel: 'web'`, `direction: 'exposure'`, `source: 'section' | 'image' | 'video'`,
- the `text` (or `alt` / transcript) becomes embedded content, keyed by a **content hash**,
- **identical content is embedded once and shared** across every person who saw it — the same paragraph
  on ten pages is one embedding, attributed to ten passports at query time.

So a read here becomes part of the person's queryable, cross-channel memory — the same store that holds
their emails and calls. Engagement events are what let `/analytics/ask` answer *"which paragraphs did
this customer actually read?"* rather than just *"did they visit the page?"*.

> Server-side detail (the exposures/chunks schema, content-hash sharing, recall) lives in the
> **whitebox-pro-server** awareness docs — this plugin only produces the events.

## Identity

The HTTP fallback needs a `passport_id` (the socket path carries it on the handshake). The SDK resolves
a passport at startup (`/sessions/resolve`) — minting one for a new anonymous visitor — so engagement
always attaches to *someone*, even before they identify.
