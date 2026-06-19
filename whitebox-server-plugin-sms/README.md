# SMS Plugin

> Transactional + marketing SMS — sent, delivery-tracked, opt-out-managed, and fed into the per-passport semantic memory, with the provider chosen per destination.

## What it is

The SMS counterpart to [`whitebox-server-plugin-mail`](../whitebox-server-plugin-mail): outbound sending (single + bulk), inbound replies with **STOP/START opt-out**, **delivery-status (DLR) tracking**, and the two block lists every sender needs (suppressed / undeliverable). Every send and reply becomes part of the customer's awareness profile (channel `sms`).

The **provider is pluggable and routed by destination.** The plugin owns the plumbing; provider packages own transport, webhook authenticity, and payload shapes. [`whitebox-sms-twilio`](../whitebox-sms-twilio) and [`whitebox-sms-mobica`](../whitebox-sms-mobica) ship today — and a single deployment can use **both at once**, routed by phone prefix.

## Provider routing

```js
import { sms } from 'whitebox-server-plugin-sms'
import { twilio } from 'whitebox-sms-twilio'
import { mobica } from 'whitebox-sms-mobica'

plugins: [
  sms({
    provider: twilio({ accountSid, authToken, from }),   // default / international
    routes: { '+359': mobica({ user, pass, from: 'Clinic' }) },  // BG → Mobica
    defaultCountry: 'BG',                                 // normalize national numbers
    auth: { secret: process.env.WB_SMS_TOKEN },
  }),
]
```

Each recipient is routed by **longest-matching E.164 prefix** (else the default). Providers are addressed by name on their webhooks (`/sms/webhooks/:provider/*`), so each points its callbacks at its own path.

## Provider contract

| method | required | notes |
|---|---|---|
| `send({ to, from, body, media }) → { messageId }` | ✓ | the provider sends; returns its id (Twilio SID) or one it generated (Mobica `idd`) |
| `verifySignature(req, kind)` | ✓ for webhooks | Twilio `X-Twilio-Signature`; Mobica a URL secret |
| `parseInbound(req)` | inbound only | absent ⇒ that provider's inbound webhook returns `501` |
| `parseStatus(req)` | status/DLR | normalize to `{ messageId, status, recipient, errorMessage, blacklisted }` |
| `classifyError(err)` | optional | permanent ⇒ blocklist instead of retry |

Canonical status vocabulary: `queued → sent → delivered / undelivered / failed` (+ `cancelled` for bulk). No opens/clicks — SMS has none.

## Endpoints

| method | path | auth | purpose |
|---|---|---|---|
| `POST` | `/sms/outbox` | Bearer | send one |
| `POST` | `/sms/bulk` | Bearer | up to 10k recipients (per-recipient fan-out) |
| `GET` / `POST` | `/sms/bulk/:batchId` (+ `/cancel`) | Bearer | batch stats / cancel |
| `POST` | `/sms/webhooks/:provider/inbound` | provider-verified | inbound reply (MO) + STOP/START |
| `GET` / `POST` | `/sms/webhooks/:provider/status` | provider-verified | delivery status / DLR (GET for Mobica, POST for Twilio) |
| CRUD | `/sms/suppressions`, `/sms/invalid` | Bearer | the two block lists |

## Shared DLR endpoints (fan-out)

Some providers (e.g. Mobica) allow only **one** delivery-callback URL per account, with no per-message override. To run several instances on one such account, fan that URL out to every instance: the status handler advances a row **only** when the report's message id matches one of *its own* sends, and stays completely silent otherwise — no status event, no awareness, no blocklisting of another instance's recipient. This requires the message id to be globally unique across instances; the Mobica provider's `instanceId` prefix guarantees that. See [`whitebox-sms-mobica`](../whitebox-sms-mobica#multi-instance-dlr-fan-out-instanceid).

## Compliance: STOP/START

Inbound `STOP`/`UNSUBSCRIBE`/`CANCEL`/`END`/`QUIT`/`OPTOUT` adds the sender to `suppressions`; `START`/`YES`/`UNSTOP` removes them. The outbox worker preflight-blocks suppressed + invalid numbers before sending. Phone numbers are normalized to E.164 (with `defaultCountry`) everywhere, so national and international forms match the same record.

## Notify topics

`sms.queued`, `sms.sent`, `sms.delivered`, `sms.undelivered`, `sms.failed`, `sms.received`, `sms.bulk.queued`, `sms.bulk.cancelled`.

## Not yet

In-SMS link shortening (detect URLs in the body → personalized short link + UTM) — the plain-text analog of the mail plugin's `data-wb-shorten`; a planned follow-on (the shortener + UTM pieces already exist).
