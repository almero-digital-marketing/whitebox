# Engagement Plugin

> Captures fine-grained web engagement — reading, image dwell, video watch intervals, link clicks — from the browser SDK into the per-passport semantic memory, with Whisper/Vision content caching so `/analytics/ask` knows what each customer actually read and watched.

## What it is

The server side of web-engagement tracking. The browser SDK
([`whitebox-pro-client-plugin-engagement`](../client-plugin-engagement))
decides when content was *genuinely* engaged with — settled reading, image dwell,
the video intervals actually played, a link click — and streams those events here.
The plugin turns them into awareness (channel `web`), generating and caching the
content they refer to: a video's Whisper transcript (sliced to the watched
segments), an image's Vision description.

## What you get

- **Engagement → memory.** Every read/watch/click becomes an awareness record,
  weighted by how deeply it was consumed, so a fully-read paragraph outranks a
  skimmed heading in recall.
- **Content caching.** Video transcripts and image descriptions are generated once
  (keyed by source URL) and reused across everyone who engages the same content.
- **Inspectable cache.** List, fetch, and invalidate cached content over HTTP/MCP.

## How to integrate

```js
import { engagement } from 'whitebox-pro-server-plugin-engagement'

engagement({
  auth: { secret: process.env.WB_ENGAGEMENT_TOKEN },   // Bearer for the cache-admin endpoints
  image: { detail: 'low' },                            // OpenAI Vision detail (default 'low')
  video: { visionDetail: 'low' },                      // frame-analysis detail (default 'low')
})
```

Then add the browser SDK and mark up your content (`data-wb-text` / `-image` /
`-video` / `-link`) — see the client plugin.

## Endpoints

| method | path | auth | purpose |
|---|---|---|---|
| `POST` | `/engagement/events` | public (browser) | batched engagement events (sendBeacon fallback on unload); needs `passport_id` |
| `GET` | `/engagement/content` | Bearer | list cached transcripts/descriptions (paginated) |
| `GET` | `/engagement/content/:url` | Bearer | fetch one cached entry (full transcript/segments) |
| `DELETE` | `/engagement/content/:url` | Bearer | invalidate; regenerated on next engagement |

## Awareness

Channel `web`. Text, section, image and video are recorded as `exposure`
(engagement-weighted via `meta.engagement`/`meta.depth`); a **link** click is an
`expression` (active intent, not passive reading). The link's interest text comes
from the anchor's label, or from the `data-wb-link` value when the visible text is
generic.

## MCP

`engagement.list_content`, `engagement.get_content`, `engagement.invalidate_content`.

## See also

- Browser SDK: [`whitebox-pro-client-plugin-engagement`](../client-plugin-engagement)
- Reading it back: [`whitebox-pro-server-plugin-analytics`](../server-plugin-analytics)
  (`/analytics/ask`, `recall`, `timeline`)
