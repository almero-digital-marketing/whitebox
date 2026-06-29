# Instance-side relay client

> **Companion to** [`whitebox-connect-gateway.md`](whitebox-connect-gateway.md)
> (the hosted service) and [`whitebox-connect.md`](whitebox-connect.md) (the whole
> layer). This is the **self-hosted** transport that the `insights-*` adapters call
> to reach the gateway's `/v1/relay/{platform}/{operation}`.
>
> **Status:** design / not started. Code below is the intended shape, not committed.

---

## 1. Where it sits

It mirrors the **existing** `adnetworks` structure exactly — a shared kernel + per-platform
provider repos + a channel plugin:

| outbound (exists) | inbound (this layer) |
|---|---|
| `server-plugin-conversions` (channel) | `server-plugin-insights` (channel) |
| `whitebox-pro-adnetworks` (kernel) | `whitebox-pro-insights` (kernel — **the relay client lives here**) |
| `whitebox-pro-adnetworks-{meta,google,tiktok}` (providers) | `whitebox-pro-insights-{meta,google,tiktok}` (providers) |

The call chain, and the **one** place the gateway is known:

```
server-plugin-insights (channel)         schedules + upserts whitebox_ad_insights
   └─ source: connect() | csv() | meta()  picks managed / manual / BYO
        └─ adapter: whitebox-pro-insights-meta   shapes request + normalizes rows  (platform-aware, gateway-blind)
             └─ transport.call(op, body)         the seam
                  ├─ relayTransport → RelayClient ──► whitebox.pro   ◄── ONLY knower of the gateway
                  └─ directTransport ─────────────► platform API     (BYO creds)
```

Swapping `connect()` for `meta()` (BYO) changes only which transport the adapter
gets. The adapter and the channel are identical either way.

---

## 2. Design properties

- **Sole knower of the gateway.** Only `RelayClient` holds the base URL + instance
  key and speaks the gateway envelope. Adapters/channel never import it directly.
- **One relay call = one meter event.** The client makes single calls; the
  *adapter* owns pagination (paging shape is platform-specific) → N pages = N
  metered calls = accurate usage.
- **Typed, actionable errors.** The gateway's error codes map to typed errors the
  channel can act on per-account: `reconnect_required` → flag for re-consent in the
  UI; `entitlement` → plan/quota notice; transient → retry.
- **Idempotent + safe to retry.** Relay reads are idempotent; retries carry a
  stable `Idempotency-Key` so the gateway meters a retried call **once** (§6); the
  channel upsert is keyed so re-pulling a window just re-upserts.
- **Streaming, bounded memory.** `pull` is an async iterator → rows flow to upsert
  without buffering a whole account.
- **Resilient sync.** A failure on one account never aborts the others.

---

## 3. The relay client (`whitebox-pro-insights/src/relay-client.js`)

```js
// Instance-side transport to the whitebox.pro metered gateway. Thin: one method
// makes one authenticated, metered relay call and maps the gateway's error
// envelope to typed, actionable errors. No platform knowledge — the per-platform
// insights adapter shapes the request body and normalizes the response.
import { randomUUID } from 'node:crypto'

export class RelayError extends Error {
  constructor(message, { code, status, retryable, retryAfter, account, platform } = {}) {
    super(message)
    this.name = 'RelayError'
    this.code = code              // see §4
    this.status = status
    this.retryable = !!retryable
    this.retryAfter = retryAfter  // seconds, when the gateway supplied Retry-After
    this.account = account        // annotated by the channel/adapter for UI surfacing
    this.platform = platform
  }
}

const RETRYABLE = new Set(['rate_limited', 'upstream_unavailable', 'unknown'])

export function createRelayClient({
  baseUrl,                       // https://whitebox.pro
  instanceKey,                   // bearer; OR pass `fetch` bound to an mTLS agent (§7)
  fetch = globalThis.fetch,
  timeoutMs = 30_000,
  maxRetries = 4,
  baseBackoffMs = 500,
  maxBackoffMs = 20_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  logger = console,
} = {}) {
  const root = baseUrl.replace(/\/+$/, '')

  async function once(path, { method = 'POST', body, idem, signal } = {}) {
    const ctrl = new AbortController()
    const onAbort = () => ctrl.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    let res
    try {
      res = await fetch(root + path, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${instanceKey}`,
          ...(idem ? { 'idempotency-key': idem } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
    } catch (e) {
      // network error / timeout / abort → treat as a retryable upstream blip
      throw new RelayError(`relay ${path}: ${e.message}`, { code: 'upstream_unavailable', retryable: true })
    } finally {
      clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
    }

    if (res.ok) return res.status === 204 ? null : res.json()

    // gateway error envelope: { error: { code, message } } (+ Retry-After header)
    const env = await res.json().catch(() => ({}))
    const code = env?.error?.code || classifyStatus(res.status)
    throw new RelayError(env?.error?.message || `relay ${path} → ${res.status}`, {
      code,
      status: res.status,
      retryable: RETRYABLE.has(code),
      retryAfter: parseRetryAfter(res.headers.get('retry-after')),
    })
  }

  async function withRetry(path, opts, ctx) {
    const idem = opts.method === 'GET' ? undefined : randomUUID() // stable across this call's retries
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(path, { ...opts, idem })
      } catch (e) {
        const err = e instanceof RelayError ? e : new RelayError(e.message, { code: 'unknown', retryable: true })
        if (ctx) { err.account = ctx.account; err.platform = ctx.platform } // for UI surfacing
        if (!err.retryable || attempt >= maxRetries) throw err
        const wait = err.retryAfter != null
          ? err.retryAfter * 1000
          : Math.min(maxBackoffMs, baseBackoffMs * 2 ** attempt) * (0.5 + random()) // expo + jitter
        logger?.warn?.(`relay retry ${attempt + 1}/${maxRetries} in ${Math.round(wait)}ms (${err.code})`)
        await sleep(wait)
      }
    }
  }

  return {
    // which (platform, account) pairs this instance may pull
    listAccounts: (signal) => withRetry('/v1/accounts', { method: 'GET', signal }),

    // one metered relay call. platform+operation pick the upstream; body is the
    // per-platform request the adapter shaped; ctx only annotates errors.
    relay: (platform, operation, body, ctx, signal) =>
      withRetry(`/v1/relay/${platform}/${operation}`, { method: 'POST', body, signal }, ctx),
  }
}

function classifyStatus(s) {
  if (s === 401) return 'auth'
  if (s === 403) return 'entitlement'
  if (s === 429) return 'rate_limited'
  if (s >= 500) return 'upstream_unavailable'
  return 'unknown'
}
function parseRetryAfter(h) {
  if (!h) return undefined
  const n = Number(h)
  if (!Number.isNaN(n)) return n           // delta-seconds form
  const d = Date.parse(h)                  // HTTP-date form
  return Number.isNaN(d) ? undefined : Math.max(0, (d - Date.now()) / 1000)
}
```

---

## 4. Error model — the seam between gateway codes and channel action

| `code` | gateway status | retryable | channel action |
|---|---|---|---|
| `reconnect_required` | 401 (+ body code) | **no** | flag the account → UI shows "reconnect"; stop pulling it |
| `auth` | 401 (bare) | **no** | bad instance key → config error, surface to operator |
| `entitlement` | 403 | **no** | plan/quota issue → surface; don't retry |
| `rate_limited` | 429 | yes (honor `Retry-After`) | transparent backoff |
| `upstream_unavailable` | 5xx / network | yes (expo+jitter) | backoff; after `maxRetries`, leave last-synced, next run retries |
| `unknown` | other | yes (conservative) | backoff |

The envelope `code` always wins over the status-derived class, so a 401 with body
`{error:{code:"reconnect_required"}}` is a reconnect, while a bare 401 is `auth`.

---

## 5. The seam in use

**Transport** — two impls, one shape; the adapter sees only `.call()`:

```js
// whitebox-pro-insights/src/transport.js
export const relayTransport = (relay, platform) => ({
  call: (operation, body, ctx, signal) => relay.relay(platform, operation, body, ctx, signal),
})
// directTransport(platform, creds) → calls the platform API directly for BYO; same .call() shape.
```

**Adapter** (`whitebox-pro-insights-meta`) — platform-aware, gateway-blind, owns paging + normalize:

```js
export function meta(/* opts: direct-mode creds only */) {
  return {
    platform: 'meta',
    async *pull(transport, account, { since, until }, signal) {
      let after = null
      do {
        const page = await transport.call('insights.query', {
          account_id: account.accountId,
          level: 'campaign',
          time_range: { since, until },
          fields: ['campaign_id', 'campaign_name', 'spend', 'impressions', 'clicks' /* +tracking template → utm */],
          after,
        }, { account: account.accountId, platform: 'meta' }, signal)
        for (const row of page.data) yield normalize(row, account)   // → canonical ad_insights row
        after = page?.paging?.next ? page.paging.cursors.after : null // adapter owns paging shape
      } while (after)
    },
  }
}
```

**Source** (`connect()`) — wires the relay client + discovery + adapter selection:

```js
import { createRelayClient } from 'whitebox-pro-insights/relay-client'
import { relayTransport } from 'whitebox-pro-insights/transport'
import { meta } from 'whitebox-pro-insights-meta'
import { google } from 'whitebox-pro-insights-google'
import { tiktok } from 'whitebox-pro-insights-tiktok'

const ADAPTERS = { meta, google, tiktok }

export function connect({ baseUrl = 'https://whitebox.pro', instanceKey, ...relayOpts } = {}) {
  const relay = createRelayClient({ baseUrl, instanceKey, ...relayOpts })
  return {
    name: 'connect',
    eligible: !!instanceKey,                          // channel skips a source with no creds (existing convention)
    accounts: (signal) => relay.listAccounts(signal), // [{ platform, accountId, name }]
    pull(account, window, signal) {
      const make = ADAPTERS[account.platform]
      if (!make) throw new Error(`no insights adapter for ${account.platform}`)
      return make().pull(relayTransport(relay, account.platform), account, window, signal)
    },
  }
}
```

**Channel pull loop** (`server-plugin-insights`) — instance-scheduled; resilient per-account:

```js
async function sync(source, { since, until }, signal) {
  if (!source.eligible) return
  for (const acc of await source.accounts(signal)) {
    try {
      for await (const row of source.pull(acc, { since, until }, signal)) {
        await store.upsertInsight(row)                // ON CONFLICT (source,account_id,level,entity_id,date)
      }
      await store.markSynced(acc, until)
    } catch (e) {
      if (e.code === 'reconnect_required') await store.flagReconnect(acc)   // → UI "reconnect account"
      else if (e.code === 'entitlement')   await store.flagEntitlement(acc) // → plan/quota notice
      else logger.warn(`insights sync ${acc.platform}/${acc.accountId}: ${e.message}`) // leave last-synced; retry next run
      // other accounts keep going
    }
  }
}
```

---

## 6. Idempotency & metering correctness

Client retries must not double-bill. Each logical `relay()` call generates **one**
`Idempotency-Key` reused across its internal retries; the gateway dedups meter
events by `(tenant, idempotency-key)` within a short window, so a retried call is
metered once. Distinct pages get distinct keys (they *are* distinct billable
calls). `GET /v1/accounts` is unmetered → no key.

---

## 7. Auth: bearer vs mTLS

Default is `Authorization: Bearer <instanceKey>`. For mTLS (the gateway doc's
stronger option), don't put the cert in this module — pass a `fetch` already bound
to a client-cert agent/dispatcher; the client stays transport-mechanism-agnostic
and the bearer header becomes a no-op the gateway ignores under mTLS.

---

## 8. What it deliberately does NOT do (thin at the edge too)

- **Normalization** → the adapter (`normalize`).
- **Pagination policy** → the adapter (platform-specific).
- **Scheduling / cadence** → the channel + instance.
- **Storage / the ROAS join / any PII** → the channel + instance.
- **Caching** → optional, in the gateway.
- **Platform knowledge** → the adapter names the `operation` and shapes the `body`.

If something wants to live in the relay client, the default answer is "push it to
the adapter or the channel" unless it's literally about talking to the gateway.

---

## 9. Testing

The client is pure transport → fully unit-testable by injecting `fetch`, `sleep`,
and `random`:

- **error mapping:** fake a 401-`reconnect_required` → asserts `RelayError.code`,
  `retryable=false`, no retry. Bare 401 → `auth`. 403 → `entitlement`. 429 with
  `Retry-After: 2` → retried after ~2s.
- **backoff:** fake 503 thrice then 200 → asserts attempts, jittered delays (seed
  `random`), success on the 4th.
- **idempotency:** assert the same `idempotency-key` across a call's retries, and a
  fresh one per page.
- **abort:** trip the `signal` mid-flight → rejects promptly, no retry.
- **metering accuracy** is a gateway-side test (count = relay calls); the client
  contract is "one logical call, one key."

---

## 10. Open questions

- **Account discovery cadence:** call `listAccounts()` every sync vs cache with a
  TTL (accounts change rarely). Lean cache-with-TTL + refresh on `reconnect_required`.
- **Window strategy:** the channel owns it, but the client/adapter should support
  incremental `since = last_synced - lookback` to catch late-attributed conversions
  (platforms restate recent days). Pick a lookback (e.g. 7d) at the channel.
- **Partial-page failure:** if page 3 of 5 fails after pages 1–2 upserted, the keyed
  upsert makes a full re-pull safe — confirm the adapter restarts the account from
  the first page rather than resuming mid-cursor (simpler + idempotent).
- **Per-tenant client-side rate hint:** the gateway enforces quotas, but the client
  could read a `X-RateLimit-Remaining` hint to self-pace and avoid 429 churn.
