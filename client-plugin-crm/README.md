# CRM Client Plugin

> Report low-trust, client-observed facts about the current passport from the browser (UI events your app witnessed) — recorded as `source: 'client'` evidence, never authoritative state.

## What it is

Report **client-observed facts** about the current passport from the browser — things your app witnessed in the UI:

```js
import whitebox from 'whitebox-pro-client'
import crmPlugin from 'whitebox-pro-client-plugin-crm'

const wb = whitebox({
  url: 'https://api.example.com',
  plugins: [crmPlugin({ /* consent: 'marketing' */ })],
})

wb.crm.observe({ kind: 'onboarding_step', body: 'completed step 3' })
wb.crm.observe({ kind: 'cart', body: 'added 2 items to cart', meta: { count: 2 } })
```

## What this is (and isn't)

These are **low-trust observations**, not authoritative state. WhiteBox is a semantic memory, not a system of record — observations are recorded as evidence tagged `source: 'client'` and weighed as *self-reported* by `ask` and the audiences evaluator. They don't need to be precise.

**Authoritative state** (subscription status, plan tier, CRM stage, billing) must come from your backend via the server-side `/crm/records` webhook — **never the browser.** A browser can't be trusted to assert "subscription: active", because that would feed answers and ad-audience membership.

## How it sends

Mirrors the engagement plugin:

- **Socket-primary** — `transport.send('crm.observe', …)`; the server takes identity from the authenticated connection (the client can't report for another passport over the socket).
- **HTTP fallback** — `POST /crm/observe` with the current `passport_id` when the socket is down.
- **`sendBeacon`** on `pagehide` / tab-hide so buffered observations aren't lost on unload.
- Buffered + flushed by `batchSize` / `flushIntervalMs`.

## Options

| option | default | meaning |
|---|---|---|
| `consent` | — (no gate) | consent category to gate on (e.g. `'marketing'`). When set, `observe()` drops unless that category is granted. **Set this for compliance.** |
| `batchSize` | `10` | flush when this many observations are buffered |
| `flushIntervalMs` | `3000` | flush a non-full buffer after this long |

## API

`wb.crm.observe({ kind, body, id?, ts?, meta? })` — record one observation (`kind` + `body` required; `id` auto-generated if omitted).
`wb.crm.flush()` — force-send the buffer.

Server side: enable `whitebox-pro-server-plugin-crm`, which records observations into awareness as `channel:'crm', direction:'observation', source:'client'`.
