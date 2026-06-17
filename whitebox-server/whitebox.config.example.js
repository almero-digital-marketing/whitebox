export default {
  port: 3000,

  logger: {
    level: 'info',                // trace | debug | info | warn | error | fatal
    // transport: undefined       // set to null to disable pretty-print in production
  },

  db: {
    host: 'localhost',
    port: 5432,
    database: 'whitebox',
    user: 'whitebox',
    password: '',
  },

  redis: {
    host: 'localhost',
    port: 6379,
    // password: '',
    // db: 0,
  },

  webhooks: {
    concurrency: 5,
    retries: 3,
    timeout: 10000,
  },

  plugins: ['voip', 'mail'],

  passports: {
    lifespans: {
      fingerprint: 7,   // days
      phone: 30,
      email: 365,
    },
  },

  // ai: {
  //   apiKey: process.env.WB_OPENAI_API_KEY,   // AI SDK provider key (OpenAI today)
  // },

  // business: {
  //   name: 'Acme Plumbing',
  //   description: 'Residential and commercial plumbing services in Sofia.',
  // },

  mail: {
    company: 'team@example.com',                         // forwarding destination for inbound + form submissions

    mailgun: {
      apiKey: '',
      domain: 'mg.example.com',
      webhookSigningKey: '',                             // shared with Mailgun webhook signing
    },

    auth: {
      secret: '',                                        // required Bearer token for POST /mail/inbox and /mail/outbox
    },

    webhookReplayWindowMs: 5 * 60 * 1000,                // reject Mailgun signatures older than this
    webhookTokenTtlMs: 24 * 60 * 60 * 1000,              // how long to remember tokens for replay dedupe

    outbox: {
      rate: { max: 10, duration: 60000 },                // worker rate limit (per duration)
      attempts: 5,                                       // total send attempts before terminal failure
      backoffMs: 5000,                                   // initial exponential backoff
    },

    forward: {
      attempts: 3,
      backoffMs: 5000,
    },

    // webhooks: {
    //   queued:     { url: 'https://example.com/hooks/mail/queued',     method: 'POST' },
    //   sent:       { url: 'https://example.com/hooks/mail/sent',       method: 'POST' },
    //   delivered:  { url: 'https://example.com/hooks/mail/delivered',  method: 'POST' },
    //   opened:     { url: 'https://example.com/hooks/mail/opened',     method: 'POST' },
    //   engaged:    { url: 'https://example.com/hooks/mail/engaged',    method: 'POST' },
    //   bounced:    { url: 'https://example.com/hooks/mail/bounced',    method: 'POST' },
    //   complained: { url: 'https://example.com/hooks/mail/complained', method: 'POST' },
    //   failed:     { url: 'https://example.com/hooks/mail/failed',     method: 'POST' },
    //   received:   { url: 'https://example.com/hooks/mail/received',   method: 'POST' },
    // },
  },

  voip: {
    country: 'BG',
    url: 'https://example.com',
    recordsFolder: '/var/whitebox/voip/records',
    context: './context/speech.md',
    transcription: false,
    language: 'bg-BG',

    pbx: {
      host: 'pbx.example.com',
      user: 'voip',
      password: '',
    },

    monitor: {
      url: 'http://pbx.example.com/monitor',
      auth: { username: '', password: '' },
    },

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

    webhooks: {
      ring: { url: 'https://example.com/hooks/ring', method: 'POST' },
      pick: { url: 'https://example.com/hooks/pick', method: 'POST' },
      call: { url: 'https://example.com/hooks/call', method: 'POST' },
    },

  },
}
