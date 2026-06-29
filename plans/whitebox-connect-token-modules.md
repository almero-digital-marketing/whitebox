# Gateway — per-platform token / refresh modules

> **Companion to** [`whitebox-connect-gateway.md`](whitebox-connect-gateway.md)
> (§3.2 OAuth broker + §3.3 token service). This is the inside of the broker: the
> three small modules that hide how Meta / Google / TikTok each do OAuth, token
> lifetime, and credential injection — behind one uniform interface.
>
> **Status:** design / not started. API versions/field names below are illustrative
> (pin exact versions at build time).

---

## 1. Where it sits

Three subsystems of the gateway all speak to one **`PlatformModule`** per platform:

- **connect flow** (control plane) — `authUrl()` → redirect; `exchangeCode()` → a
  `StoredGrant` to persist; `listAccounts()` → what's connectable.
- **token service** (data plane, per relay call) — `accessToken(grant)` → a usable
  token, refreshing/re-extending and re-persisting as needed.
- **relay injector** (data plane) — `authorize(req, {token})` attaches creds the way
  that platform wants; `classifyUpstreamError()` turns an upstream auth failure into
  the `reconnect_required` code the [relay client](whitebox-connect-relay-client.md)
  already knows how to act on.

**The moat lives here in code:** every module needs the **app secret** (Meta
`appsecret_proof`, Google `developer-token`, TikTok `secret`) to inject creds. Those
secrets exist **only** in the gateway's vault, which is exactly why credential
injection is gateway-side and not in the instance.

---

## 2. The `PlatformModule` interface

```js
// Implemented once per platform. The broker code is generic over this.
{
  platform,                                   // 'meta' | 'google' | 'tiktok'

  // ── connect flow ──
  authUrl({ redirectUri, state }),            // → string (portal redirects the user here)
  async exchangeCode({ code, redirectUri }),  // → StoredGrant (persist, encrypted)
  async listAccounts(grant),                  // → [{ accountId, name }]

  // ── token service ──
  async accessToken(grant, now),              // → { token, grant?, expiresAt? }
                                              //   grant? present ⇒ re-persist (token rotated)
  needsReconnect(grant, now),                 // → bool (proactive; long-lived near expiry)

  // ── relay injection ──
  authorize(req, { token, account }),         // → req with creds attached (headers/params/proof)
  classifyUpstreamError(status, body),        // → 'reconnect_required'|'rate_limited'|'upstream'|null

  // ── lifecycle ──
  async revoke(grant),
}
```

`StoredGrant` (what the vault persists, envelope-encrypted): `{ platform,
refreshToken?, accessToken?, accessExpiresAt?, longLived?, scope, accountIds?, raw }`.

---

## 3. The generic token service

Platform-agnostic; one cache + one refresh-and-repersist path:

```js
async function tokenFor(tenant, platform, account, cache, vault, now = epoch()) {
  const key = `${tenant}:${platform}:${account}`
  const hit = cache.get(key)
  if (hit && hit.expiresAt - SKEW > now) return { token: hit.token, mod: MODULES[platform] }

  const mod = MODULES[platform]
  const grant = await vault.load(tenant, platform, account)        // KMS-decrypt
  const { token, grant: updated, expiresAt } = await mod.accessToken(grant, now)
  if (updated) await vault.save(tenant, platform, account, updated) // re-encrypt rotated token
  cache.set(key, { token, expiresAt: expiresAt ?? now + 300 })      // short default if unknown
  return { token, mod }
}
```

`accessToken()` throwing an auth error (revoked refresh token / expired long-lived
token) propagates up; the relay injector's `classifyUpstreamError` (or the module
throwing a tagged error) turns it into `reconnect_required` → the instance flags the
account → UI shows "reconnect."

---

## 4. The three modules (the distinctive mechanics)

They differ more than they're alike — which is the whole reason to isolate them.

### 4.1 Google Ads — classic OAuth offline refresh (the "normal" one)

```js
const TOKEN = 'https://oauth2.googleapis.com/token'
export const google = ({ clientId, clientSecret, developerToken, loginCustomerId }) => ({
  platform: 'google',

  authUrl: ({ redirectUri, state }) =>
    'https://accounts.google.com/o/oauth2/v2/auth?' + qs({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'https://www.googleapis.com/auth/adwords',
      access_type: 'offline', prompt: 'consent', state }),       // offline+consent ⇒ refresh_token

  async exchangeCode({ code, redirectUri }) {
    const r = await postForm(TOKEN, { client_id: clientId, client_secret: clientSecret,
      code, redirect_uri: redirectUri, grant_type: 'authorization_code' })
    return { refreshToken: r.refresh_token, accessToken: r.access_token,
             accessExpiresAt: epoch() + r.expires_in, scope: r.scope }
  },

  async accessToken(grant, now) {
    if (grant.accessToken && grant.accessExpiresAt - 60 > now) return { token: grant.accessToken }
    const r = await postForm(TOKEN, { client_id: clientId, client_secret: clientSecret,
      refresh_token: grant.refreshToken, grant_type: 'refresh_token' })   // invalid_grant ⇒ reconnect
    const updated = { ...grant, accessToken: r.access_token, accessExpiresAt: now + r.expires_in }
    return { token: r.access_token, grant: updated, expiresAt: updated.accessExpiresAt }
  },

  needsReconnect: () => false,                                   // refresh handles expiry

  authorize(req, { token }) {
    req.headers['authorization']   = `Bearer ${token}`
    req.headers['developer-token'] = developerToken              // app-level moat artifact
    if (loginCustomerId) req.headers['login-customer-id'] = loginCustomerId  // MCC, when used
    return req
  },

  // listAccounts: customers:listAccessibleCustomers → customer_ids (+ traverse MCC clients)
  revoke: (g) => post(`https://oauth2.googleapis.com/revoke?token=${g.refreshToken}`),
  classifyUpstreamError(status, body) {
    if (body?.error === 'invalid_grant') return 'reconnect_required'
    if (status === 401) return 'reconnect_required'
    if (status === 429 || body?.error?.status === 'RESOURCE_EXHAUSTED') return 'rate_limited'
    if (status >= 500) return 'upstream'
    return null
  },
})
```

Notes: the **`developer-token` header is app-level** (the standard-access moat) and
the same on every tenant's call. `login-customer-id` is the **MCC** path; per-user
OAuth (above) needs no MCC. (Access-model choice = the parent's open question.)

### 4.2 Meta — long-lived token, **no refresh_token**, re-extend + `appsecret_proof`

```js
import { createHmac } from 'node:crypto'
const G = 'https://graph.facebook.com/v19.0'
export const meta = ({ appId, appSecret }) => ({
  platform: 'meta',

  authUrl: ({ redirectUri, state }) =>
    `https://www.facebook.com/v19.0/dialog/oauth?` + qs({
      client_id: appId, redirect_uri: redirectUri, state, scope: 'ads_read,business_management' }),

  async exchangeCode({ code, redirectUri }) {
    const short = await getJson(`${G}/oauth/access_token?` + qs({
      client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code }))
    const long = await getJson(`${G}/oauth/access_token?` + qs({      // upgrade to ~60d long-lived
      grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret,
      fb_exchange_token: short.access_token }))
    return { accessToken: long.access_token, longLived: true,
             accessExpiresAt: epoch() + (long.expires_in ?? 60 * 86400) }
  },

  async accessToken(grant, now) {
    if (grant.accessExpiresAt - 7 * 86400 > now) return { token: grant.accessToken }  // re-extend within 7d
    const long = await getJson(`${G}/oauth/access_token?` + qs({       // fails if already expired ⇒ reconnect
      grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret,
      fb_exchange_token: grant.accessToken }))
    const updated = { ...grant, accessToken: long.access_token, accessExpiresAt: now + (long.expires_in ?? 60 * 86400) }
    return { token: long.access_token, grant: updated }
  },

  needsReconnect: (g, now) => g.accessExpiresAt <= now,

  authorize(req, { token }) {                                   // token as query param + HMAC proof
    const proof = createHmac('sha256', appSecret).update(token).digest('hex')
    req.query = { ...req.query, access_token: token, appsecret_proof: proof }
    return req
  },

  // listAccounts: GET /me/adaccounts?fields=account_id,name
  revoke: (g) => del(`${G}/me/permissions?access_token=${g.accessToken}`),
  classifyUpstreamError(status, body) {
    const code = body?.error?.code
    if (code === 190) return 'reconnect_required'               // expired/invalid token
    if ([4, 17, 32, 613].includes(code)) return 'rate_limited'  // throttling family
    if (status >= 500) return 'upstream'
    return null
  },
})
```

Notes: Meta gives **no OAuth2 refresh token** — a long-lived user token (~60d) is
**re-extended by exchanging it again while still valid**; once expired the user must
re-auth (`needsReconnect`). For non-expiring access, a **System User** token from
the customer's Business is the production-grade option (open question §6). Every
call carries **`appsecret_proof`** (HMAC of the token with the app secret) — only
the gateway can compute it.

### 4.3 TikTok — long-lived / non-expiring token, no refresh, `Access-Token` header

```js
const API = 'https://business-api.tiktok.com/open_api/v1.3'
export const tiktok = ({ appId, secret }) => ({
  platform: 'tiktok',

  authUrl: ({ redirectUri, state }) =>
    `https://business-api.tiktok.com/portal/auth?` + qs({ app_id: appId, redirect_uri: redirectUri, state }),

  async exchangeCode({ code }) {
    const r = await postJson(`${API}/oauth2/access_token/`, { app_id: appId, secret, auth_code: code })
    return { accessToken: r.data.access_token, accountIds: r.data.advertiser_ids, longLived: true }
  },

  accessToken: (grant) => ({ token: grant.accessToken }),       // non-expiring → no refresh
  needsReconnect: () => false,

  authorize(req, { token }) { req.headers['Access-Token'] = token; return req },  // NB: not Bearer

  listAccounts: (g) => (g.accountIds || []).map((id) => ({ accountId: String(id) })),
  revoke: (g) => postJson(`${API}/oauth2/revoke/`, { app_id: appId, secret, access_token: g.accessToken }),
  classifyUpstreamError(status, body) {
    if ([40105, 40100, 40001].includes(body?.code)) return 'reconnect_required'  // auth errors
    if (body?.code === 40016 || status === 429) return 'rate_limited'
    if (status >= 500) return 'upstream'
    return null
  },
})
```

Notes: the access token comes **bundled with `advertiser_ids`** (no separate account
discovery call needed) and is **long-lived/non-expiring**, so `accessToken` is a
pass-through and `revoke` is the only lifecycle event.

---

## 5. Relay injection + the reconnect bridge

On a relay call the gateway: `tokenFor()` → `mod.authorize(req, {token, account})` →
forward → if the upstream rejects, `mod.classifyUpstreamError(status, body)` → emit
the gateway error envelope `{ error: { code } }`. The relay client maps that code to
a channel action (its §4 table): `reconnect_required` → flag account → UI prompt;
`rate_limited` → backoff (with `Retry-After`); `upstream` → retry then leave
last-synced. **This is the seam that connects the broker internals to the
instance-side UX** without either side knowing the other's platform specifics.

---

## 6. Per-platform cheat-sheet

| | token lifetime | "refresh" | account discovery | cred injection | reconnect signal |
|---|---|---|---|---|---|
| **Google** | access ~1h + **refresh_token** | refresh_token grant | `listAccessibleCustomers` (+MCC) | `Bearer` + `developer-token` (+`login-customer-id`) | `invalid_grant` / 401 |
| **Meta** | long-lived user ~60d, **no refresh_token** | **re-exchange** `fb_exchange_token` while valid | `/me/adaccounts` | `access_token` **query param** + `appsecret_proof` | error **190** / expiry |
| **TikTok** | **non-expiring** access token | none (pass-through) | **bundled** `advertiser_ids` | **`Access-Token`** header | code **40105/40100** |

---

## 7. Storage & security recap

- Persist `StoredGrant` **envelope-encrypted** (KMS data key) keyed `(tenant,
  platform, account)`; access tokens cached in memory/Redis with TTL = `expiresAt -
  skew`, never persisted in plaintext.
- App secrets (Meta `appSecret`, Google `clientSecret` + `developerToken`, TikTok
  `secret`) live **only** in the gateway vault.
- Request only read scopes (`ads_read` / `adwords` read / TikTok reporting).
- Revoke deletes the grant + busts the cache; tenant offboarding revokes all.

---

## 8. Open questions

- **Meta:** long-lived user token (simple, re-extend, ~60d reconnect) **vs** System
  User token (non-expiring, but needs the customer's Business Manager) — start with
  user token, offer System User for managed accounts.
- **Google:** per-user OAuth (no link step, refresh_token per user) **vs** MCC
  manager-link (`login-customer-id`, fewer tokens, needs the customer to accept a
  link). Support per-user for self-serve; MCC for agency/managed.
- **TikTok:** some newer auth variants issue a refresh token + expiring access token;
  detect and branch (`grant.longLived === false` → add a refresh path) if/when the
  app lands on that flow.
- **Token rotation races:** two concurrent relay calls both refresh — guard
  `accessToken()` with a per-key single-flight so only one refresh runs.
