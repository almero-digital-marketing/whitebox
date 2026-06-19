# whitebox-server-plugin-shortener

Branded short links on **their own host** that hide a passport behind an opaque
code. A personalized link, when clicked, **hard-binds** the visitor's session to
that customer — stitching any anonymous browsing history onto them via the core
passport merge. The passport id never appears in a URL: only the code, then a
single-use claim token in the redirect.

## Topology — same server, second vhost

One whitebox-server, one port. The short host (`go.clinic.com`) is a second
vhost in the reverse proxy pointing at this server; `baseUrl`'s hostname gates
the bare `/:code` redirect, and management/claim live under `/shortener/*` on the
normal API host. The proxy must forward the public `Host` (or set
`X-Forwarded-Host` + `trust proxy`) so `req.hostname` is the public host.

## Config

```js
import { shortener } from 'whitebox-server-plugin-shortener'

shortener({
  baseUrl: 'https://go.clinic.com',                 // builds short_url AND gates /:code
  auth: { secret: process.env.WB_SHORTENER_TOKEN }, // Bearer for POST /shortener/links
  // codeLength: 8, defaultTtlSec: 30d, identityTtlSec: 24h, claimTtlSec: 180,
})
```

## Endpoints

| Method | Path | Host | Auth | |
|---|---|---|---|---|
| `GET`  | `/:code` | short | public | resolve → `302` (+ single-use token when bindable) |
| `POST` | `/shortener/links` | API | Bearer | create a link |
| `POST` | `/shortener/claim` | API | public | redeem a token → `{ bound, passport_id, data }` |
| `GET`  | `/shortener/links/:code` | API | Bearer | inspect + click stats |
| `GET`  | `/shortener/links` | API | Bearer | list (limit/offset) |

`POST /shortener/links`
```json
{ "url": "https://clinic.com/whitening", "passport_id": "uuid",
  "identify": { "email": "jane@…" }, "data": { "name": "Jane" },
  "label": "spring-email", "ttlSec": 2592000, "identityTtlSec": 86400 }
→ { "code": "Api9AjAu", "short_url": "https://go.clinic.com/Api9AjAu", "expires_at": … }
```

## How a click binds

```
GET /:code      → resolve code → mint a fresh single-use claim_token (~3 min)
                → 302 to  dest#wb=<token>   (?wb= if dest already has a fragment)
                → idempotent: never consumes identity (email scanners can't burn it)
POST /claim     → validate+consume token (single-use) → HARD-BIND:
                  • first-touch  → session adopts the customer
                  • returning    → passports.merge(customer, P_anon)  ← non-destructive
                → mark identity consumed, link PII, record an awareness exposure
                → { bound:true, passport_id, data }   (data prefills forms)
```

**Hard-bind, safely:** identity is single-use and consumed **on the claim** (a real
browser that ran JS), never on the redirect GET — so scanners/prefetchers can't
consume or misattribute it, and forwarded links self-disarm after the first
claim. The client SDK ([whitebox-client-plugin-shortener](../whitebox-client-plugin-shortener))
reads `?wb=`/`#wb=`, claims, scrubs the URL, and adopts the returned passport.

## Handoff — automatic

No config: a clean **fragment** (`#wb=`) by default (kept out of the destination's
server logs); falls back to a **query param** (`?wb=`) when the destination URL
already has a fragment (hash router / anchor), where `#wb=` would collide.

## MCP

`shortener.create_link`, `shortener.list_links`, `shortener.link_stats`.
