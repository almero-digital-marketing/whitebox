# whitebox-adnetworks-tiktok

TikTok as a self-contained WhiteBox ad-network: the canonical→TikTok event map +
signals ([spec.js](src/spec.js)), the **Events API** server adapter
([index.js](src/index.js)), and the **Pixel** client mapper ([client.js](src/client.js)).

```js
import { tiktok } from 'whitebox-adnetworks-tiktok'          // server Events API
import { tiktok } from 'whitebox-adnetworks-tiktok/client'   // client ttq
```

Signals: `_ttp`, `ttclid`. Shares the `event_id` with the pixel for dedup.
