import * as store from './store.js'

const DEFAULT_CHUNK_SIZE = 200
const DEFAULT_MODEL = 'text-embedding-3-small'
const DEFAULT_ATTEMPTS = 5
const DEFAULT_BACKOFF_MS = 5000

// Dependencies captured once via init() — module-level singletons, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
let openai
let queue
let logger

// Module state derived from config / deps in init().
let chunkSize
let model
let attempts
let backoffMs
let embedQueue

// In-process coordination so concurrent workers don't pay for the same embed.
// The leader does the work; followers wait, then see chunks already exist.
let inFlight  // Map<content_hash, Promise>

export function init(deps) {
  openai = deps.openai
  queue = deps.queue
  logger = deps.logger

  const cfg = deps.config.awareness || {}
  chunkSize = cfg.chunk?.size ?? DEFAULT_CHUNK_SIZE
  model = cfg.embedding?.model ?? DEFAULT_MODEL
  // Embedding is the one place a transient OpenAI error means permanent data
  // loss: the exposure is stored but, with no retry, never gets chunks and is
  // never recallable. Retry with exponential backoff; keep failed jobs (don't
  // removeOnFail) so a persistent failure is visible in the queue for triage.
  attempts = cfg.embedding?.attempts ?? DEFAULT_ATTEMPTS
  backoffMs = cfg.embedding?.backoffMs ?? DEFAULT_BACKOFF_MS

  embedQueue = queue.createQueue('awareness:embed')
  inFlight = new Map()

  queue.createWorker('awareness:embed', async job => {
    const { exposureId } = job.data
    const exposure = await store.findExposure(exposureId)
    if (!exposure || !exposure.content_hash) return

    // Fast path: chunks already exist for this content
    if (await store.hasChunks(exposure.content_hash)) {
      logger.debug({ exposureId, content_hash: exposure.content_hash }, 'Chunks already cached')
      return
    }

    const hash = exposure.content_hash

    // Coordinate with concurrent workers embedding the same content
    if (inFlight.has(hash)) {
      try {
        await inFlight.get(hash)
        return  // leader inserted chunks; we're done
      } catch {
        // Leader failed — fall through and try ourselves
      }
    }

    const work = doEmbed(exposure)
    inFlight.set(hash, work)
    try {
      await work
    } finally {
      inFlight.delete(hash)
    }
  }, { concurrency: cfg.embedConcurrency ?? 5 })
}

async function doEmbed(exposure) {
  const chunks = chunk(exposure.text)
  if (!chunks.length) return

  const embeddings = await openai.embed(chunks, { model })

  await store.insertChunks(exposure.content_hash, chunks.map((text, i) => ({
    text,
    embedding: embeddings[i],
  })))

  logger.debug({ exposureId: exposure.id, content_hash: exposure.content_hash, chunks: chunks.length }, 'Embedded content')
}

function chunk(text) {
  if (!text || !text.trim()) return []
  const sentences = text.match(/[^.!?\n]+[.!?\n]?\s*/g) || [text]
  const out = []
  let buf = []
  let words = 0

  for (const s of sentences) {
    const w = s.trim().split(/\s+/).filter(Boolean).length
    if (words + w > chunkSize && buf.length) {
      out.push(buf.join(' ').trim())
      buf = []
      words = 0
    }
    buf.push(s.trim())
    words += w
  }
  if (buf.length) out.push(buf.join(' ').trim())
  return out
}

export async function enqueue(exposureId) {
  await embedQueue.add('embed', { exposureId }, {
    attempts,
    backoff: { type: 'exponential', delay: backoffMs },
    removeOnComplete: true,
    removeOnFail: false,
  })
}
