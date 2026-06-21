# Mail Client Plugin

> Submit contact-form messages to whitebox-pro-server's mail inbox from the browser — JSON or multipart (with attachments), no auth required.

## What it is

The browser half of the [mail](../server-plugin-mail) channel: a thin
client that posts a contact-form submission to the server's public
`POST /mail/inbox`. The server links the submitter to a passport, forwards the
message to your configured company inbox, and records it in awareness as an
inbound `expression`.

## How to integrate

```js
import whitebox from 'whitebox-pro-client'
import mailPlugin from 'whitebox-pro-client-plugin-mail'

const wb = whitebox({
  url: 'https://api.example.com',
  plugins: [ mailPlugin() ],
})

await wb.mail.submit({
  from: 'jane@example.com',          // required
  subject: 'Question about pricing', // required
  body: 'Do you offer annual plans?',
  to: 'sales@yourco.com',            // optional routing hint
  data: { plan: 'pro' },             // optional structured fields (e.g. hidden utm_*)
  // files: [ fileFromInput ],       // optional File[]; sent as multipart
})
```

## API

`wb.mail.submit({ from, subject, body?, to?, data?, files? })` — submit one message.
`from` and `subject` are required; throws otherwise. With `files` present the
request is sent as `multipart/form-data` (the server parses attachments); otherwise
as JSON. Requests are queued through the client SDK like every other call.

## See also

- Server channel: [`whitebox-pro-server-plugin-mail`](../server-plugin-mail)
  (outbound send, inbound webhooks, tracking, suppressions).
