// Whitebox runtime config.
//
// The default export is an `async (runtime) => ({ ... })` factory. Plugins are
// imported by name and CALLED with their options right here in the `plugins`
// array — the object they return ({ name, register, migrate }) is what the
// server loads. Use `.filter(Boolean)` so a plugin can be conditionally enabled
// by a short-circuiting expression (e.g. only mount mail when its key is set).
//
// All credentials come from the environment. Start with `npm start` (it runs
// `node --env-file-if-exists=.env`), so anything in ./.env is already loaded
// into process.env by the time this file is imported. This file holds NO
// secrets — only structure and non-sensitive defaults.

import { engagement } from 'whitebox-server-plugin-engagement'
import { crm } from 'whitebox-server-plugin-crm'
import { analytics } from 'whitebox-server-plugin-analytics'
import { conversions } from 'whitebox-server-plugin-conversions'
import { shortener } from 'whitebox-server-plugin-shortener'
import { voip } from 'whitebox-server-plugin-voip'
import { mail } from 'whitebox-server-plugin-mail'
import { sms } from 'whitebox-server-plugin-sms'

// Ad networks, mail providers, and SMS providers compose like plugins — one
// self-contained, independently-released package each, living in their own repos
// outside this monorepo (see ../whitebox-integrations + `npm run link:integrations`).
import { meta } from 'whitebox-adnetworks-meta'
import { tiktok } from 'whitebox-adnetworks-tiktok'
// import { google } from 'whitebox-adnetworks-google'   // server GA4 — see note below
import { mailgun } from 'whitebox-mail-mailgun'
// import { postmark } from 'whitebox-mail-postmark'      // swap the mail provider below
import { twilio } from 'whitebox-sms-twilio'
import { mobica } from 'whitebox-sms-mobica'

export default async (runtime) => ({
  port: Number(process.env.WB_PORT || 3000),

  logger: {
    level: process.env.WB_LOG_LEVEL || 'info',   // trace | debug | info | warn | error | fatal
    // transport: null                            // set to null to disable pretty-print in production
  },

  db: {
    host: process.env.WB_DB_HOST || 'localhost',
    port: Number(process.env.WB_DB_PORT || 5432),
    database: process.env.WB_DB_NAME || 'whitebox',
    user: process.env.WB_DB_USER || 'whitebox',
    password: process.env.WB_DB_PASSWORD || '',
  },

  redis: {
    host: process.env.WB_REDIS_HOST || 'localhost',
    port: Number(process.env.WB_REDIS_PORT || 6379),
    // password: process.env.WB_REDIS_PASSWORD,
    // db: 0,
  },

  webhooks: {
    concurrency: 5,
    retries: 3,
    timeout: 10000,
  },

  ai: {
    apiKey: process.env.WB_OPENAI_API_KEY,   // AI SDK provider key (OpenAI today)
  },

  passports: {
    lifespans: {
      fingerprint: 7,   // days
      phone: 30,
      email: 365,
    },
  },

  // MCP endpoint + auth. `auth` is a pluggable verifier: a static Bearer secret
  // by default (string or { secret }), or a composed one from an external
  // package. For Auth0, add at the top:
  //   import { auth0 } from 'whitebox-auth-auth0'
  // and set: auth: auth0({ domain: process.env.AUTH0_DOMAIN,
  //                        audience: 'https://whitebox/mcp', scope: 'mcp:use' })
  // (that also serves /.well-known/oauth-protected-resource so MCP clients can
  // log in via Auth0 themselves). Omit `auth` entirely for no auth (dev only).
  mcp: {
    path: '/mcp',
    auth: process.env.WB_MCP_TOKEN,   // string → Bearer; swap for auth0({…})
  },

  // Each entry is a built plugin object. Options passed to the factory are the
  // plugin's config — there is no separate top-level block to keep in sync.
  plugins: [
    engagement({
      auth: { secret: process.env.WB_ENGAGEMENT_TOKEN },
      // image: { detail: 'low' }, video: { visionDetail: 'low' },
    }),

    crm({
      auth: { secret: process.env.WB_CRM_TOKEN },
    }),

    analytics({
      auth: { secret: process.env.WB_ANALYTICS_TOKEN },
    }),

    // Receives /conversions/events from the browser, records them, and (when a
    // network's creds are present) fans out to the ad platforms, deduped by
    // event_id. With no networks configured it records into awareness only.
    conversions({
      auth: { secret: process.env.WB_CONVERSIONS_TOKEN },   // Bearer for the GET audit endpoint (optional)
      // Compose the server-side (SST) networks. No networks ⇒ records into
      // awareness only. Each is a self-contained package called with its creds.
      networks: [
        meta({ pixelId: process.env.WB_META_PIXEL_ID, accessToken: process.env.WB_META_CAPI_TOKEN }),
        tiktok({ pixelCode: process.env.WB_TIKTOK_PIXEL_CODE, accessToken: process.env.WB_TIKTOK_EVENTS_TOKEN }),
        // GA4 is handled CLIENT-SIDE via the gtag pixel (no pixel↔MP event_id
        // dedup). Don't add google() here alongside client gtag — non-purchase
        // events would double-count. Use it only for a server-ONLY GA4 setup.
        // google({ measurementId: process.env.WB_GA4_MEASUREMENT_ID, apiSecret: process.env.WB_GA4_API_SECRET }),
      ],
    }),

    // Short links served on their own host (baseUrl's hostname gates the bare
    // /:code redirect — point a vhost at this same server). A personalized link
    // hard-binds the clicker's session to its passport; the id never hits a URL.
    shortener({
      baseUrl: process.env.WB_SHORTENER_BASEURL || 'https://go.example.com',
      auth: { secret: process.env.WB_SHORTENER_TOKEN },   // Bearer for POST /shortener/links
    }),

    voip({
      country: 'BG',
      recordsFolder: 'recordings',   // relative to the server's working dir (absolute paths also work)
      context: './context/speech.md',
      transcription: false,
      language: 'bg-BG',
      lines: [
        {
          in: ['+35924000000'],
          out: ['+359880000000'],
          tag: 'sales',
          strategy: 'hunt',
          prefix: '00',
          // message: '/path/to/hold.mp3',
        },
      ],
      // ari: { url: process.env.WB_ARI_URL, user: process.env.WB_ARI_USER, password: process.env.WB_ARI_PASSWORD },
      // webhooks: {
      //   ring: { url: 'https://example.com/hooks/voip/ring', method: 'POST' },
      //   pick: { url: 'https://example.com/hooks/voip/pick', method: 'POST' },
      //   call: { url: 'https://example.com/hooks/voip/call', method: 'POST' },
      // },
    }),

    // Mail only mounts when a Mailgun key is present — the && short-circuits to a
    // falsy value otherwise, and `.filter(Boolean)` drops it from the array.
    process.env.WB_MAILGUN_API_KEY && mail({
      company: 'team@example.com',   // forwarding destination for inbound + form submissions
      // The mail provider is composed like a plugin — Mailgun here. To use
      // Postmark instead, import { postmark } above and swap:
      //   provider: postmark({ serverToken: process.env.WB_POSTMARK_SERVER_TOKEN,
      //     from: process.env.WB_POSTMARK_FROM,
      //     webhookUser: process.env.WB_POSTMARK_WEBHOOK_USER,
      //     webhookPassword: process.env.WB_POSTMARK_WEBHOOK_PASSWORD }),
      provider: mailgun({
        apiKey: process.env.WB_MAILGUN_API_KEY,
        domain: process.env.WB_MAILGUN_DOMAIN || 'mg.example.com',
        webhookSigningKey: process.env.WB_MAILGUN_WEBHOOK_SIGNING_KEY,
        replayWindowMs: 5 * 60 * 1000,               // reject webhook signatures older than this
      }),
      auth: { secret: process.env.WB_MAIL_TOKEN },   // Bearer token for POST /mail/inbox and /mail/outbox
      outbox: {
        rate: { max: 10, duration: 60000 },          // worker rate limit (per duration)
        attempts: 5,                                 // total send attempts before terminal failure
        backoffMs: 5000,                             // initial exponential backoff
      },
    }),

    // SMS, with a provider chosen by destination: Twilio by default, Mobica for
    // Bulgarian (+359) numbers. Providers own send + webhook auth + payload
    // parsing; the plugin owns outbox/status/suppressions/awareness. Mobica is
    // a send + DLR gateway (no inbound); Twilio does send + inbound + status.
    sms({
      provider: twilio({
        accountSid: process.env.WB_TWILIO_SID,
        authToken: process.env.WB_TWILIO_TOKEN,
        from: process.env.WB_TWILIO_FROM,                                  // a Twilio number or messagingServiceSid
        statusCallback: 'https://wb.example.com/sms/webhooks/twilio/status',
      }),
      routes: {
        '+359': mobica({
          user: process.env.WB_MOBICA_USER,
          pass: process.env.WB_MOBICA_PASS,
          from: 'WhiteBox',                                                // alphanumeric sender id
          // dlrSecret: process.env.WB_MOBICA_DLR_SECRET,                  // ?secret= on the DLR URL
        }),
      },
      defaultCountry: 'BG',                                                // for normalizing national numbers
      auth: { secret: process.env.WB_SMS_TOKEN },                         // Bearer for /sms/outbox + /sms/bulk
    }),
  ].filter(Boolean),
})
