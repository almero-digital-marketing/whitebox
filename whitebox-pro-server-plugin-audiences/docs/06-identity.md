# 06 · Identity

Different networks need different identifiers. Rather than hardcode them, the **adapters are the source
of truth** and the client is a **dumb collector** told what to grab.

## Two halves of every adapter

- **`identitySpec`** — the browser signals to *collect* (server → client).
- **`acceptedKeys`** — the keys it *sends* (consumed server-side).

## The flow

```
adapters declare identitySpec ──compose union──▶ identity manifest
                                                      │ (served on /sessions/resolve)
 CLIENT capture shim: generic collector  ◀────────────┘
   reads cookie / url-param per the manifest, gated on marketing consent
                                                      │ POST collected signals
                                                      ▼
 POST /audiences/identity → store on passport (whitebox_audience_identities)
                                                      │ at send time
                                                      ▼
 adapter.sendEvent: picks its acceptedKeys (+ server-resolved hashed PII / IP / UA)
```

## The manifest (declarative, never code)

`identity.manifest(adapters)` returns the union of eligible adapters' specs:

```json
{ "collect": [
  { "key":"fbp", "from":"cookie", "name":"_fbp" },
  { "key":"fbc", "from":"cookie", "name":"_fbc", "fallback":{ "from":"url","name":"fbclid","transform":"build_fbc" } },
  { "key":"ttclid", "from":"url", "name":"ttclid" },
  { "key":"ttp", "from":"cookie", "name":"_ttp" },
  { "key":"ga_client_id", "from":"cookie", "name":"_ga", "transform":"ga_cid" },
  { "key":"gclid", "from":"url", "name":"gclid" }
] }
```

> **Security:** the manifest references `from` (cookie/url/navigator) and **named** transforms
> (`build_fbc`, `ga_cid`) that the client *implements*. The server never ships executable code to the
> client.

It's surfaced on the `/sessions/resolve` response (via `ctx.sessions.onResolve`), so the client gets it
in the round trip it already makes. (If your core build doesn't expose `onResolve`, serve it from
`GET /audiences/networks/:net/identity-manifest` and have the shim fetch it.)

## The client capture shim (companion package)

A small browser plugin — `whitebox-pro-client-plugin-ads-capture` (scaffold separately) — that:

1. reads the manifest from the session-resolve response,
2. **only if `marketing` consent is granted** (and re-runs on `consent:granted`),
3. for each entry, reads the cookie / URL param, applies the named transform,
4. `POST /audiences/identity { passport_id, signals }`.

Named transforms it must implement:
- **`ga_cid`** — `_ga` cookie `GA1.1.<X>.<Y>` → `client_id` `<X>.<Y>`.
- **`build_fbc`** — when `_fbc` is absent but `fbclid` is in the URL: `fb.1.<timestamp>.<fbclid>`.

## What's collected where, and why

| key | who needs it | source |
|---|---|---|
| `_fbp`, `_fbc` / `fbclid` | Meta | cookie / URL |
| `ttclid`, `_ttp` | TikTok | URL / cookie |
| `ga_client_id`, `gclid` | Google/GA4 | `_ga` cookie / URL |
| hashed email / phone | all | **server-side** from passport identities |
| client IP, user agent | Meta/TikTok | **server-side** from the request |

Cookies + landing-URL params **must** come from the client — your server never sees the customer's
landing page. Hashed PII + IP + UA are resolved server-side and are deliberately **not** in the
manifest.

## Hashing

`identity.resolve(passport)` pulls email/phone from `passports.identities()` and SHA-256 hashes them
(email lowercased/trimmed; phone reduced to E.164 digits — prefix the country code upstream).
**Awareness chunk text is PII-redacted**, so match keys never come from awareness content — only from
passport identities.

## Lifecycle / TTL

Click IDs expire (`gclid` ~90 days; `fbclid`→`fbc` has a window). The capture shim re-collects on each
visit (`updated_at` refresh), so stale signals age out naturally. Re-collecting on `consent:granted`
ensures you backfill the moment a user consents.
