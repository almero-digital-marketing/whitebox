const EXPOSURES = 'whitebox_awareness_exposures'
const CHUNKS = 'whitebox_awareness_chunks'
const SESSIONS = 'whitebox_sessions'

const SESSION_COLS = [
  's.utm_source',
  's.utm_medium',
  's.utm_campaign',
  's.utm_term',
  's.utm_content',
  's.referrer',
]

function toVectorLiteral(arr) {
  return `[${arr.join(',')}]`
}

// Dependencies captured once via init() — module-level singleton, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
let db

export function init(deps) {
  db = deps.db
}

export async function insertExposure(data) {
  const [row] = await db(EXPOSURES).insert(data).returning('*')
  return row
}

export async function findExposure(id) {
  return db(EXPOSURES).where({ id }).first()
}

export async function deletePassport(passportId) {
  return db(EXPOSURES).where({ passport_id: passportId }).del()
}

export async function timeline({ passport_id, from, to, channels, directions }) {
  let q = db(EXPOSURES + ' as e')
    .leftJoin(SESSIONS + ' as s', 's.id', 'e.session_id')
    .where('e.passport_id', passport_id)
    .select('e.*', ...SESSION_COLS)
  if (from) q = q.where('e.ts', '>=', from)
  if (to) q = q.where('e.ts', '<=', to)
  if (channels?.length) q = q.whereIn('e.channel', channels)
  if (directions?.length) q = q.whereIn('e.direction', directions)
  return q.orderBy('e.ts', 'desc')
}

export async function hasChunks(contentHash) {
  if (!contentHash) return false
  const row = await db(CHUNKS).where({ content_hash: contentHash }).first()
  return !!row
}

// chunks: [{ text, embedding }]  — content_hash applied uniformly
export async function insertChunks(contentHash, chunks) {
  if (!chunks.length) return
  await db(CHUNKS)
    .insert(chunks.map((c, i) => ({
      content_hash: contentHash,
      chunk_index: i,
      chunk_text: c.text,
      embedding: toVectorLiteral(c.embedding),
    })))
    .onConflict(['content_hash', 'chunk_index'])
    .ignore()
}

// Delete chunks whose content_hash is no longer referenced by any exposure.
// Returns number of orphan chunks removed.
export async function gcOrphanChunks() {
  const result = await db.raw(
    `DELETE FROM ${CHUNKS}
     WHERE content_hash NOT IN (SELECT DISTINCT content_hash FROM ${EXPOSURES} WHERE content_hash IS NOT NULL)`
  )
  return result.rowCount ?? 0
}

// Recall: chunks scoped to a passport via exposures.content_hash join.
//
// A passport can have many exposures sharing one content_hash (saw the same
// email twice, revisited a page). A naive chunk⋈exposure join would emit one
// row per (chunk, exposure) pair, so a single chunk would repeat and crowd
// the top-K evidence window. We collapse each content_hash to its most-recent
// exposure first (DISTINCT ON), so every chunk appears exactly once, carrying
// the metadata of the latest time the passport saw it. Ordering is then a pure
// vector-distance sort over the (small, per-passport) chunk set.
export async function recallChunks({ passport_id, embedding, limit = 10 }) {
  const v = toVectorLiteral(embedding)
  // Rank blends relevance with engagement depth: a deeply-read paragraph outranks
  // a skimmed heading of similar relevance. engagement is the per-exposure depth
  // weight (text reads only); non-text exposures coalesce to 1.0 (full). The
  // multiplier floors at 0.4 so a glance is demoted, not erased.
  const result = await db.raw(
      `SELECT
         c.id, c.content_hash, c.chunk_text,
         e.ts, e.passport_id, e.channel, e.direction, e.source, e.content_id, e.content_url,
         s.utm_source, s.utm_medium, s.utm_campaign, s.utm_term, s.utm_content, s.referrer,
         1 - (c.embedding <=> ?::vector) AS similarity,
         COALESCE((e.meta->>'engagement')::float, 1) AS engagement,
         e.meta->>'depth' AS depth
       FROM ${CHUNKS} c
       JOIN (
         SELECT DISTINCT ON (content_hash)
           content_hash, ts, passport_id, channel, direction, source, content_id, content_url, session_id, meta
         FROM ${EXPOSURES}
         WHERE passport_id = ?
         ORDER BY content_hash, ts DESC
       ) e ON e.content_hash = c.content_hash
       LEFT JOIN ${SESSIONS} s ON s.id = e.session_id
       ORDER BY (1 - (c.embedding <=> ?::vector)) * (0.4 + 0.6 * COALESCE((e.meta->>'engagement')::float, 1)) DESC
       LIMIT ?`,
    [v, passport_id, v, limit]
  )
  return result.rows ?? result
}

// Base-wide aggregates — no embedding, no query. Cheap counting for "how many
// customers do we have / how active are they" and for grounding population-scope
// answers even when a question maps to no semantic cohort.
export async function populationStats() {
  const totals = await db(EXPOSURES)
    .countDistinct({ customers: 'passport_id' })
    .count({ exposures: '*' })
    .first()
  const breakdown = await db(EXPOSURES)
    .select('channel', 'direction')
    .count({ exposures: '*' })
    .countDistinct({ customers: 'passport_id' })
    .groupBy('channel', 'direction')
    .orderBy('exposures', 'desc')
  return {
    customers: Number(totals?.customers || 0),
    exposures: Number(totals?.exposures || 0),
    breakdown: breakdown.map(b => ({
      channel: b.channel,
      direction: b.direction,
      exposures: Number(b.exposures),
      customers: Number(b.customers),
    })),
  }
}

// A representative sample of base-wide content for overview questions — NOT
// filtered by any query. One row per distinct content, carrying how many distinct
// customers it reached. Ordered by reach first (the strongest population signal —
// what the most customers have in common), with an expression/conversation
// tiebreak so the genuine "voice of the customer" outranks broadcast content of
// equal reach, then recency.
export async function sampleContent({ limit = 40 } = {}) {
  const result = await db.raw(
      `WITH reach AS (
         SELECT content_hash,
                COUNT(DISTINCT passport_id) AS customers,
                MAX(ts) AS latest,
                (ARRAY_AGG(channel   ORDER BY ts DESC))[1] AS channel,
                (ARRAY_AGG(direction ORDER BY ts DESC))[1] AS direction
         FROM ${EXPOSURES}
         WHERE content_hash IS NOT NULL
         GROUP BY content_hash
       )
       SELECT r.customers, r.latest AS ts, r.channel, r.direction, c.chunk_text
       FROM reach r
       JOIN ${CHUNKS} c ON c.content_hash = r.content_hash AND c.chunk_index = 0
       ORDER BY
         r.customers DESC,
         (CASE WHEN r.direction IN ('expression', 'conversation') THEN 0 ELSE 1 END),
         r.latest DESC
       LIMIT ?`,
    [limit]
  )
  return result.rows ?? result
}

// Population: matching chunks first (HNSW-efficient), then resolve to passports.
// minEngagement (0 = off) gates which exposures count: a text read only qualifies
// if its depth weight clears the threshold, so a heading-glance doesn't put a
// passport in the cohort. Non-text exposures (mail/voip/crm — no depth signal)
// always qualify.
export async function populationChunks({ embedding, similarity = 0.75, limit = 1000, minEngagement = 0 }) {
  const v = toVectorLiteral(embedding)
  const result = await db.raw(
      `WITH matches AS (
         SELECT id, chunk_text, content_hash, 1 - (embedding <=> ?::vector) AS similarity
         FROM ${CHUNKS}
         WHERE 1 - (embedding <=> ?::vector) >= ?
         ORDER BY embedding <=> ?::vector
         LIMIT ?
       )
       SELECT DISTINCT
         e.passport_id, m.chunk_text, m.similarity, e.ts,
         e.channel, e.direction, e.source,
         s.utm_source, s.utm_medium, s.utm_campaign,
         s.utm_term, s.utm_content, s.referrer
       FROM matches m
       JOIN ${EXPOSURES} e ON e.content_hash = m.content_hash
         AND (?::float <= 0 OR (e.meta->>'engagement') IS NULL OR (e.meta->>'engagement')::float >= ?::float)
       LEFT JOIN ${SESSIONS} s ON s.id = e.session_id
       ORDER BY m.similarity DESC`,
    [v, v, similarity, v, limit, minEngagement, minEngagement]
  )
  return result.rows ?? result
}
