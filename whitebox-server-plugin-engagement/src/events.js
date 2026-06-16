// Validation schemas + dispatch table for engagement events.
//
// Events arrive from two paths:
//   - the WebSocket (live, one event at a time, or a batched envelope)
//   - the HTTP POST /events endpoint (sendBeacon fallback on page unload)
//
// Both paths normalise into the same kind ('section' | 'text' | 'video' | 'image')
// then call the matching consumer (sections / text / videos / images).

import { z } from 'zod'

// Manual section (legacy / explicit wb.engagement.section(...) calls)
const sectionSchema = z.object({
  id:       z.string().optional().nullable(),
  url:      z.string().url().optional().nullable(),
  text:     z.string().min(1),
  ts:       z.union([z.string(), z.number()]).optional(),
  dwell_ms: z.number().int().nonnegative().optional(),
  meta:     z.record(z.any()).optional(),
})

// Automatic text tracking (data-wb-text)
const textSchema = z.object({
  id:           z.string().optional().nullable(),
  kind:         z.enum(['paragraph', 'heading']).optional(),
  level:        z.number().int().min(1).max(6).optional().nullable(),
  text:         z.string().min(1),
  length_chars: z.number().int().nonnegative().optional(),
  url:          z.string().url().optional().nullable(),
  ts:           z.union([z.string(), z.number()]).optional(),
  ms_spent:     z.number().int().nonnegative().optional(),
  partial:      z.boolean().optional(),
})

const videoIntervalSchema = z.object({
  start_s: z.number().nonnegative(),
  end_s:   z.number().nonnegative(),
})

const videoSchema = z.object({
  id:              z.string().optional().nullable(),
  kind:            z.literal('video').optional(),
  src:             z.string().url().optional().nullable(),
  url:             z.string().url().optional().nullable(),
  duration_s:      z.number().nonnegative().optional().nullable(),
  intervals:       z.array(videoIntervalSchema).optional(),
  total_watched_s: z.number().nonnegative().optional(),
  completion_pct:  z.number().min(0).max(100).optional().nullable(),
  ms_spent:        z.number().int().nonnegative().optional(),
  muted:           z.boolean().optional(),
  partial:         z.boolean().optional(),
  ts:              z.union([z.string(), z.number()]).optional(),
  // Legacy single-range form
  start_s:         z.number().nonnegative().optional(),
  end_s:           z.number().nonnegative().optional(),
  transcript:      z.any().optional(),
}).refine(d => d.src || d.url || d.intervals, {
  message: 'Either src or url must be provided',
})

const imageSchema = z.object({
  id:          z.string().optional().nullable(),
  kind:        z.literal('image').optional(),
  src:         z.string().url().optional().nullable(),
  url:         z.string().url().optional().nullable(),
  alt:         z.string().optional().nullable(),
  width:       z.number().int().nonnegative().optional().nullable(),
  height:      z.number().int().nonnegative().optional().nullable(),
  ts:          z.union([z.string(), z.number()]).optional(),
  ms_spent:    z.number().int().nonnegative().optional(),
  partial:     z.boolean().optional(),
  description: z.string().optional(),                              // legacy
})

// Batch envelope (used by both WS and HTTP). Flat `{ type, ...fields }` is
// the canonical form; `{ kind, data }` is tolerated for back-compat.
export const batchSchema = z.object({
  events: z.array(z.union([
    z.object({ type: z.string() }).passthrough(),
    z.object({ kind: z.enum(['section', 'text', 'video', 'image']), data: z.any() }),
  ])).min(1).max(500),
})

export const KIND_BY_TYPE = {
  'engagement.section': 'section',
  'engagement.text':    'text',
  'engagement.video':   'video',
  'engagement.image':   'image',
}

export function createDispatch({ sections, text, videos, images, logger }) {
  function parse(kind, payload) {
    try {
      if (kind === 'section') return sectionSchema.parse(payload)
      if (kind === 'text')    return textSchema.parse(payload)
      if (kind === 'video')   return videoSchema.parse(payload)
      if (kind === 'image')   return imageSchema.parse(payload)
    } catch (err) {
      logger.warn({ err, kind }, 'engagement payload validation failed')
      return null
    }
  }

  async function dispatch(visitor, kind, payload) {
    const parsed = parse(kind, payload)
    if (!parsed) return
    if (kind === 'section') return sections.consume(visitor, parsed)
    if (kind === 'text')    return text.consume(visitor, parsed)
    if (kind === 'video')   return videos.consume(visitor, parsed)
    if (kind === 'image')   return images.consume(visitor, parsed)
  }

  // Each batched event is either a flat `{ type: 'engagement.X', ...fields }`
  // or the legacy wrapper `{ kind: 'X', data: {...} }`. Normalise both.
  async function dispatchBatchEvent(visitor, event) {
    if (event.type) {
      const kind = KIND_BY_TYPE[event.type]
      if (!kind) return
      const { type, ...payload } = event
      return dispatch(visitor, kind, payload)
    }
    if (event.kind) return dispatch(visitor, event.kind, event.data)
  }

  return { dispatch, dispatchBatchEvent }
}
