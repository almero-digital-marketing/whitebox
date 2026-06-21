# VoIP Client Plugin

> Swap trackable phone numbers into the page for engaged visitors (`data-wb-phone`), so an inbound call ties back to the web session that triggered it.

## What it is

The browser half of the [voip](../server-plugin-voip) channel. When a
phone element comes into view and the visitor looks genuinely engaged, the plugin
asks the server for a trackable number from that line's pool, swaps it into the DOM
(text + `tel:` href), and emits `voip.click` when the user dials. The number is
released aggressively — on tab hide, blur, idle, viewport-leave, or hold expiry —
so the pool stays small. When that number is later called, the server correlates
the call back to this visitor's session and passport.

## How to integrate

Mark the phone elements with `data-wb-phone="<line tag>"`:

```html
<a href="tel:+35924000000" data-wb-phone="sales">+359 2 400 0000</a>
```

```js
import whitebox from 'whitebox-pro-client'
import voipPlugin from 'whitebox-pro-client-plugin-voip'

const wb = whitebox({
  url: 'https://api.example.com',
  plugins: [ voipPlugin() ],   // tracks [data-wb-phone], excludes [data-wb-nophone]
})
```

The line `tag` must match a `lines` entry configured on the server's `voip` plugin.
Elements added later (SPA routes included) are picked up automatically.

## Events

`wb.on('voip.click', ({ tag, number }) => …)` — fired when the visitor clicks a
swapped-in number.

## See also

- Server channel: [`whitebox-pro-server-plugin-voip`](../server-plugin-voip)
  (Asterisk ARI observer, number pool, recording, transcription).
