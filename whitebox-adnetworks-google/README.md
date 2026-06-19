# whitebox-adnetworks-google

Google GA4 as a self-contained WhiteBox ad-network: the canonical→GA4 event map +
signals ([spec.js](src/spec.js)), the **Measurement Protocol** server adapter
([index.js](src/index.js)), and the **gtag** client mapper ([client.js](src/client.js)).

```js
import { google } from 'whitebox-adnetworks-google'          // server MP
import { google } from 'whitebox-adnetworks-google/client'   // client gtag
```

> **GA4 has no pixel↔MP `event_id` dedup.** Fire GA4 on ONE side — client `gtag`
> OR server MP, not both for the same events (purchases dedupe via `transaction_id`).
> The MP adapter REQUIRES the `_ga` client_id, which the client `collect()` reads.
