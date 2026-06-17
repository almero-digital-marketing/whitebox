// Example config block for the audiences plugin. Merge into your
// whitebox.config.js. All secrets should come from process.env, never literals.
//
// Enable the plugin by adding 'audiences' to the top-level `plugins` array.

export default {
  plugins: ['engagement', 'analytics', 'audiences'],

  // MCP must have an auth secret in production — the audiences management tools
  // live behind it. See docs/09-api.md (Auth).
  mcp: {
    path: '/mcp',
    auth: { secret: process.env.WB_MCP_TOKEN },
  },

  audiences: {
    // Bearer secret for the REST management surface (/audiences/*). Separate,
    // privileged tier — NOT the public client token. See docs/09-api.md.
    auth: { secret: process.env.WB_AUDIENCES_TOKEN },

    // Evaluation tuning. See docs/04-evaluator.md.
    evaluation: {
      candidateLimit: 2000,       // population() vector-narrow cap per rule
      candidateSimilarity: 0.72,  // min cosine similarity for a candidate
      model: 'gpt-4o-mini',       // screen model; borderline can escalate
      debounceMs: 30000,          // per-passport dirty-eval debounce window
      keepWarmDays: 7,            // re-fire cadence (must be < the audience window)
    },

    // Per-network credentials + transport config. A network is "eligible" only
    // when its secrets are present. See docs/05-networks.md.
    networks: {
      meta: {
        enabled: true,
        pixelId: process.env.WB_META_PIXEL_ID,
        accessToken: process.env.WB_META_CAPI_TOKEN,
        testEventCode: process.env.WB_META_TEST_EVENT_CODE, // optional, dev only
      },
      tiktok: {
        enabled: true,
        pixelCode: process.env.WB_TIKTOK_PIXEL_CODE,
        accessToken: process.env.WB_TIKTOK_EVENTS_TOKEN,
      },
      google: {
        enabled: true,
        // GA4 Measurement Protocol. See docs/networks/google-ga4.md.
        measurementId: process.env.WB_GA4_MEASUREMENT_ID,
        apiSecret: process.env.WB_GA4_API_SECRET,
      },
    },

    // Privacy. See docs/08-consent-privacy.md.
    privacy: {
      requireConsentCategory: 'marketing', // forward only consented passports
      sensitiveCategories: ['health', 'finance', 'religion', 'sexuality', 'politics'],
    },
  },
}
