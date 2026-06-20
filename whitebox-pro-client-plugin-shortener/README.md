# Shortener Client Plugin

> The landing-page half of a personalized short link — redeems the single-use claim token the redirect left in the URL and adopts the customer it was bound to.

## What it is

The landing-page half of a personalized short link. When a visitor arrives via a
[shortener](../whitebox-pro-server-plugin-shortener) link, the server's redirect left
a single-use **claim token** in the URL (`?wb=` or `#wb=`). This plugin redeems
it and adopts the customer it was bound to.

```js
import { createClient } from 'whitebox-pro-client'
import shortener from 'whitebox-pro-client-plugin-shortener'

const wb = createClient({ /* … */, plugins: [ shortener() ] })

// the link's prefill data, once claimed
const { name, email } = wb.shortener.data ?? {}
```

On install it:
1. reads the token from `?wb=` or `#wb=` (whichever the server used);
2. `POST /shortener/claim { token, passport_id }` — passing the current anonymous
   passport so the server **merges it into the customer** the link belongs to;
3. **scrubs** the token from the address bar (so it can't be re-shared/re-claimed);
4. **adopts** the returned passport (`core.setPassportId`) — every later event runs
   as that customer;
5. exposes `wb.shortener.data` (the link's prefill) and `wb.shortener.bound`.

No token in the URL → it's a no-op. A stale/used token → `{ bound: false }`, the
page just runs anonymously.
