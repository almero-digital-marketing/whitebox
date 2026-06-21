# VoIP Plugin

> Turns the company phone system into a tracked, transcribed, attributable channel that ties inbound calls to the web sessions that triggered them — and feeds every conversation into the same per-passport memory as email and web.

## What it is

A **passive observer** of an Asterisk PBX over ARI (Asterisk REST Interface). Whitebox connects to the PBX's WebSocket, receives events when inbound calls enter a Stasis app, starts an ARI-managed recording, then fetches the audio when the call ends and feeds it through Whisper + a GPT cleanup pass into the per-passport memory.

One PBX protocol, one connection. No AMI socket, no separate HTTP server for recordings, no monitor directory scraping.

The PBX still owns dialing, routing, and audio. The plugin never instructs it — if whitebox is offline, calls keep working; we just miss those events.

The single piece of clever machinery is **trackable-number assignment**: a web visitor who looks like they're about to call gets a real phone number swapped into the page (via the whitebox-pro-client `voip` tracker). When they dial it, the inbound call is matched back to their web session — so a call from a stranger becomes a call from "the visitor who spent 4 minutes on the pricing page after clicking the Google ad".

## What you get

- **Web → phone attribution.** Inbound calls are linked to the exact web session that prompted them, including UTM tags. *"Did the spring campaign drive any calls?"* is one SQL query, or one `/analytics/ask` question.
- **Every call transcribed and searchable.** Whisper transcript + GPT-4o normalization pass (catches misspelled proper nouns and product names). The transcript becomes a chunked, embedded awareness exposure — `/analytics/ask` can quote a specific call from 3 months ago.
- **Aggressive number-pool reuse.** Trackable numbers are returned to the pool the moment the visitor leaves, blurs the tab, goes idle, or hangs up — so a small pool of real numbers serves a large concurrent audience.
- **Best-effort everywhere.** Recording fails? Call still logged. Transcription fails? Call + recording still there. Whisper down? Raw audio still available. No single failure cascades.
- **Unified identity.** Phone numbers are strong identities — the second call from the same number lands on the same passport, automatically merging with their email/web identity if any of those match too.
- **Notify topics on every state.** `voip.ring`, `voip.pick`, `voip.call` flow through the same notify system as mail, so downstream consumers (CRM sync, alerting, dashboards) subscribe once.

## How to integrate

### 1. Enable the plugin (server)

```js
// config
{
  plugins: [..., 'voip'],
  voip: {
    ari: {
      url:      'http://pbx.example.com:8088',
      user:     'whitebox',                       // matches ari.conf
      password: process.env.PBX_ARI_PASSWORD,
      app:      'whitebox',                       // Stasis app name; default 'whitebox'
    },
    recordsFolder: '/var/lib/whitebox/voip/records',
    url: 'https://example.com',                   // base URL for public record links
    country: 'BG',                                // fallback region
    language: 'bg-BG',                            // Whisper language hint
    context: './business.txt',                    // optional company description for transcription prompt
    transcription: true,
    lines: {
      sofia: ['+35921234567', '+35921234568'],    // tag → trackable inbound numbers
    },
  },
}
```

### 1b. PBX-side configuration

Two small changes on the Asterisk host:

**`/etc/asterisk/ari.conf`** — define the user whitebox connects as:

```ini
[general]
enabled = yes
pretty = no

[whitebox]
type     = user
read_only = no
password = ${PBX_ARI_PASSWORD}
```

**`/etc/asterisk/extensions.conf`** — hand inbound calls to the Stasis app. Put this in whatever context already receives inbound calls today:

```ini
exten => _X.,1,NoOp(inbound, handing to whitebox)
exten => _X.,n,Stasis(whitebox)
exten => _X.,n,Hangup()
```

Reload Asterisk: `asterisk -rx 'core reload'`. The plugin connects on startup; the existing AMI / monitor configuration is no longer needed and can be retired.

Migrations run on startup. The plugin opens an ARI WebSocket (auto-reconnect) and starts logging every call to `whitebox_voip_calls`.

### 2. Wire the trackable-number swap on your site

Drop the whitebox-pro-client `voip` tracker into your site and tag any phone number you want trackable:

```html
<a href="tel:+35921234567" data-wb-phone="sales">+359 2 123 4567</a>
```

```js
import { createWhitebox } from 'whitebox-pro-client'

const wb = createWhitebox({ host: 'https://wb.example.com' })
wb.voip.start()
```

When the element scrolls into view and the visitor looks engaged, the client asks the server for a free number from the `sales` line's pool. The number replaces the displayed text and `href`. When they call, the inbound event finds the assignment, links the call to the visitor's session+passport, and emits `voip.ring` to that visitor's WebSocket so your UI can react ("Ringing now…").

Aggressive release: viewport-leave, tab-hide, blur, idle, or pagehide all return the number to the pool. A clicked `tel:` link is sticky until the page unloads.

### 3. Subscribe to call events

Either via global notify webhooks (`config.voip.webhooks: [...]`) or in-process:

```js
events.on('voip.call', ({ data }) => {
  // data = full call row: vault_id, from, to, picked_at, ended_at,
  // duration_s, record_url, transcription, passport_id, session_id
})
```

### 4. Use the data

Recordings stream from `${config.voip.url}/voip/records/<uuid>.mp3` (UUID-named, currently unauth'd — proxy with auth if you need access control). Transcripts and call metadata are available via the same `/analytics/ask`, `/analytics/timeline`, and `/analytics/recall` endpoints as every other channel — calls show up under channel `voip`, direction `conversation`.

## Role

The PBX is the source of truth for telephony. Whitebox is a **passive observer + recorder**:
- We log every ring, pickup, and hangup
- We download the call recording, transcode to MP3, transcribe via Whisper
- We assign trackable phone numbers to web visitors so a website session can be correlated with the inbound call

## File layout

```
src/
├── index.js          - Plugin entry; wires components, mounts /voip/records static
├── ari.js            - ARI WebSocket subscriber + Stasis handlers + recording fetch
├── mcp.js            - MCP tool registrations
├── calls.js          - DB layer for whitebox_voip_calls
├── phonebook.js      - E.164 parsing + per-line region detection
├── pool.js           - Dynamic number assignment (web → phone line tracking)
├── encoder.js        - WAV → MP3 transcode + duration probe (ffmpeg)
├── speech.js         - Whisper transcription + GPT-4o normalization
└── migrations/
    └── 001_create_calls.js
```

## Core flow

```
ARI WebSocket (Stasis app: whitebox)
  ↓
StasisStart
  ↓ derive vault_id = sha256(linkedid) [stable across all events of the call]
  ↓ phonebook.guessRegionByLineIn / toE164 — caller + line in E.164
  ↓ pool.find(line) — was this number assigned to a web visitor?
  ↓ if yes: link existing passport + reuse session
    else: passports.identify(null) + link phone
  ↓ calls.ring() — insert row, status='ringing'
  ↓ if visitor: pool.notify() — push 'voip.ring' to their WS connection
  ↓ notify 'voip.ring' (with passport+session)
  ↓ channel.answer() + channel.record({format: 'wav', name: 'wb-<vault>-<ts>'})
  ↓ channel.continueInDialplan() — hand back to Asterisk so the call still
                                     reaches the agent via normal routing

ChannelStateChange (state=Up):
  ↓ calls.pick() — update row, status='active', picked_at
  ↓ notify 'voip.pick'

ChannelDestroyed:
  ↓ ARI auto-finalises the recording into /recordings/stored
  ↓ GET /ari/recordings/stored/<name>/file → download as .wav
  ↓ encoder.duration — ffprobe seconds
  ↓ encoder.encode — wav → mp3, delete original
  ↓ if speech enabled AND duration > 5s:
        speech.transcribe → Whisper → GPT-4o cleanup pass
  ↓ calls.end() — update with duration, record, link, transcription
      status = picked_at ? 'ended' : 'missed'
  ↓ DELETE /ari/recordings/stored/<name> (best-effort cleanup on PBX)
  ↓ notify 'voip.call'
```

## Call status machine

```
ringing ─── pick() ───► active ─── end() ───► ended
   │
   └─── end() without pick ─────────────────► missed
```

Single linear progression. `vault_id` (SHA-256 of PBX `linkedid`) is the stable identifier across all events of one call.

## Number pool (web → phone tracking)

The clever part. Each entry in `config.voip.lines` maps a tag (e.g. `sales`, `support`) to its array of trackable inbound numbers. When a web visitor connects via WebSocket and asks for a number (via `voip.pick` event), `pool.assign()`:

1. Picks a random free number from the line's pool
2. Sends it back to the visitor (`voip.number`) so they can display "Call us at +359 …"
3. Holds the number for the visitor with a timeout (60s prod, 10s dev)
4. When a call rings on that exact number, `pbx.ring()` calls `pool.find()` to link the call to that visitor's session+passport

When the visitor disconnects or releases the number:
- Number goes back to the available pool
- If someone is waiting in `slot.waiting`, they get it immediately

If all numbers are taken:
- Visitor is added to `slot.waiting`
- `voip.unavailable` is emitted to them

When a visitor's hold timeout fires while others are waiting → release. Otherwise → moved to `slot.postponed` (still has the number, but evictable to make room for an active waiter).

This makes inbound calls **attributable to a specific web session** — invaluable for marketing analytics and customer support context.

## Recording pipeline

```
PBX writes file ────► 30s grace period ────► recorder fetches via HTTP listing
                                                        ↓
                          ┌─── encoder.duration (ffprobe)
                          ↓
                     encoder.encode (wav→mp3 if needed, delete source)
                          ↓
                     speech.transcribe (only if duration > 5s)
                       ├─ Whisper with language hint + business context prompt
                       └─ GPT-4o normalization pass:
                          "Fix spelling of names, products, business-specific terms"
                          ↓
                     calls.end() stores filename + link + transcription
```

The double-pass transcription (Whisper → GPT) catches misspelled proper nouns and product names that Whisper alone would get wrong. The business context comes from `config.voip.context` (path to a file containing a description of the company).

## Phonebook

Handles the messy reality of phone numbers:
- `guessRegionByLineIn(rawNumber)` — looks at which configured line's `in[]` matches the raw inbound number, returns its country. Falls back to `config.voip.country` when no line matches.
- `toE164(raw, region)` — normalize via libphonenumber-js
- `findLine(e164)` — returns the tag of the line that owns this number, or `null`
- `format(e164)` — pretty-print for the client-facing `voip.number` payload

All call rows store E.164 numbers, never raw PBX strings. The agent's destination number (in `pick` / `end` events) is parsed with the global `config.voip.country` since agents are local to the PBX installation.

## Passport linking

- Visitor pool entry has `passportId` → that passport gets the phone E.164 linked on ring
- No visitor (cold call): a new passport is identified and the phone is linked anyway
- Subsequent calls from the same number find the same passport via the merge keys (phone is a strong key with 30-day lifespan)

## Notify topics

| Event | When | Payload |
|---|---|---|
| `voip.ring` | call starts ringing | `{ type, date, data: call, session }` |
| `voip.pick` | agent picks up | `{ type, date, data: call, session }` |
| `voip.call` | call ends (recording ready) | `{ type, date, data: call, session }` |

Plus pool events sent directly over the WebSocket connection (not via notify): `voip.number`, `voip.unavailable`, `voip.ring` (with the trackable number).

## Storage

- **DB**: single table `whitebox_voip_calls` with `vault_id` unique index
- **Filesystem**: `config.voip.recordsFolder` — MP3 files with UUID names
- **Public URL**: `${config.voip.url}/voip/records/<uuid>.mp3` — served via `express.static`. Unguessable but no auth (same as mail attachments — known gap)

## Config shape

```js
config.voip = {
  ari: {
    url:      'http://pbx.example.com:8088',  // ARI base URL (host:8088 default)
    user:     'whitebox',                     // matches ari.conf user block
    password: '...',
    app:      'whitebox',                     // Stasis app name from extensions.conf
  },
  recordsFolder: '/var/lib/whitebox/voip/records',
  url: 'https://example.com',                 // base URL for public record links
  country: 'BG',                              // fallback region for parsing
  language: 'bg-BG',                          // Whisper language hint
  context: './business.txt',                  // optional company description for transcription prompt
  transcription: true,                        // enable Whisper + GPT normalization
  lines: {
    // tag → trackable inbound numbers for that line
    sofia: ['+35921234567', '+35921234568'],
  },
  webhooks: [ /* outbound notify configs */ ],
}
```

## Design properties

- **Observer-with-recording pattern**: we receive every channel event over the ARI WebSocket, briefly answer the channel to start an ARI-managed recording, then `continueInDialplan()` so the call routes normally to the agent. Recoverable if whitebox is down for a while — we miss events but the PBX keeps running.
- **vault_id stability**: SHA-256 of the ARI `linkedid` makes the call ID stable across all events of the same call (re-entries into Stasis, channel snoops, etc.).
- **Best-effort recording**: if the ARI `/recordings/stored` fetch fails, the call row is still ended without audio. The transcript pipeline is skipped; the row stays accurate.
- **Best-effort transcription**: if Whisper fails or GPT fails, we keep the raw Whisper output or `null`. The call still completes.
- **Session attribution**: the pool design ensures that a website session and an inbound call can be unified via the trackable number — the central value of the plugin.
- **Single PBX protocol**: just ARI on port 8088. No AMI port, no Apache-served monitor directory. One connection to monitor, one to log.

## Known gaps

1. **Records are publicly served** — UUID-named but no access control
2. **No call cleanup on whitebox side** — local MP3 files accumulate; no GC for old recordings
3. **No call statistics endpoint** — calls are stored but only the WS push and notify events expose them
4. **ARI WebSocket reconnect** is handled by `ari-client` but no observability around how often it happens or what events were dropped during the disconnect window
5. **Dialplan coupling** — the PBX side requires `Stasis(whitebox)` to be added to inbound contexts. Existing dialplan logic that runs before Stasis (CDR, IVR menus, etc.) still works; logic that runs after the line will only fire once whitebox calls `continueInDialplan()`
