// Example config showing how to enable the audiences plugin. Merge the import
// and the audiences({...}) call into your whitebox.config.js. All secrets come
// from process.env, never literals.

import { engagement } from 'whitebox-pro-server-plugin-engagement'
import { analytics } from 'whitebox-pro-server-plugin-analytics'
import { audiences } from 'whitebox-pro-server-plugin-audiences'
import { meta } from 'whitebox-pro-adnetworks-meta'
import { tiktok } from 'whitebox-pro-adnetworks-tiktok'
import { google } from 'whitebox-pro-adnetworks-google'

export default async (runtime) => ({
  port: Number(process.env.WB_PORT || 3000),
  db: { /* … */ },
  redis: { /* … */ },
  ai: { apiKey: process.env.WB_OPENAI_API_KEY },

  // MCP must have an auth secret in production — the audiences management tools
  // live behind it. See docs/09-api.md (Auth).
  mcp: {
    path: '/mcp',
    auth: { secret: process.env.WB_MCP_TOKEN },
  },

  plugins: [
    engagement({ auth: { secret: process.env.WB_ENGAGEMENT_TOKEN } }),
    analytics({ auth: { secret: process.env.WB_ANALYTICS_TOKEN } }),

    audiences({
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

      // Composed network packages (each eligible only when its secrets are
      // present). Import the factories at the top:
      //   import { meta } from 'whitebox-pro-adnetworks-meta'
      //   import { tiktok } from 'whitebox-pro-adnetworks-tiktok'
      //   import { google } from 'whitebox-pro-adnetworks-google'
      networks: [
        meta({ pixelId: process.env.WB_META_PIXEL_ID, accessToken: process.env.WB_META_CAPI_TOKEN, testEventCode: process.env.WB_META_TEST_EVENT_CODE }),
        tiktok({ pixelCode: process.env.WB_TIKTOK_PIXEL_CODE, accessToken: process.env.WB_TIKTOK_EVENTS_TOKEN }),
        google({ measurementId: process.env.WB_GA4_MEASUREMENT_ID, apiSecret: process.env.WB_GA4_API_SECRET }),
      ],

      // Privacy. See docs/08-consent-privacy.md.
      privacy: {
        requireConsentCategory: 'marketing', // forward only consented passports
        sensitiveCategories: ['health', 'finance', 'religion', 'sexuality', 'politics'],
      },
    }),
  ],
})
