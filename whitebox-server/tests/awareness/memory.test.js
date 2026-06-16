import { describe, it, expect, vi } from 'vitest'
import * as memory from '../../src/awareness/memory.js'
import * as store from '../../src/awareness/store.js'

// memory composes the store module (import * as store). Mock it so each test
// can drive findExposure / hasChunks / insertChunks behavior, mirroring the
// previous factory test where store was an injected dependency.
vi.mock('../../src/awareness/store.js', () => ({
  init: vi.fn(),
  findExposure: vi.fn(),
  hasChunks: vi.fn(),
  insertChunks: vi.fn(),
}))

function makeMemory({ exposure, chunkSize, embeddings, alreadyHasChunks = false } = {}) {
  let workerHandler = null
  const embedQueueAdd = vi.fn(async () => {})
  const queue = {
    createQueue: vi.fn(() => ({ add: embedQueueAdd })),
    createWorker: vi.fn((name, handler) => { workerHandler = handler }),
  }
  const insertedSets = []  // array of { contentHash, chunks }
  store.findExposure.mockReset().mockImplementation(async () => exposure ?? null)
  store.hasChunks.mockReset().mockImplementation(async () => alreadyHasChunks)
  store.insertChunks.mockReset().mockImplementation(async (contentHash, chunks) => {
    insertedSets.push({ contentHash, chunks })
  })
  const openai = {
    embed: vi.fn(async texts => {
      if (embeddings) return embeddings
      return texts.map(() => [0.1, 0.2, 0.3])
    }),
  }
  const config = { awareness: { chunk: { size: chunkSize ?? 200 } } }
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }

  memory.init({ store, openai, queue, config, logger })
  return {
    memory, store, openai, queue, insertedSets, embedQueueAdd,
    run: () => workerHandler({ data: { exposureId: exposure?.id ?? 1 } }),
  }
}

describe('awareness.memory.embed worker', () => {

  it('embeds and inserts chunks keyed by content_hash', async () => {
    const exposure = {
      id: 7, passport_id: 'p1',
      content_hash: 'abc123',
      text: 'Hello world.',
      ts: new Date('2024-01-01'),
    }
    const { run, store, openai, insertedSets } = makeMemory({ exposure, embeddings: [[0.5, 0.6]] })

    await run()

    expect(store.hasChunks).toHaveBeenCalledWith('abc123')
    expect(openai.embed).toHaveBeenCalled()
    expect(insertedSets).toHaveLength(1)
    expect(insertedSets[0].contentHash).toBe('abc123')
    expect(insertedSets[0].chunks).toEqual([{ text: 'Hello world.', embedding: [0.5, 0.6] }])
  })

  it('skips embed entirely when chunks already exist for the hash', async () => {
    const exposure = {
      id: 1, passport_id: 'p1',
      content_hash: 'cached-hash',
      text: 'Some content.',
      ts: new Date(),
    }
    const { run, openai, insertedSets } = makeMemory({ exposure, alreadyHasChunks: true })

    await run()

    expect(openai.embed).not.toHaveBeenCalled()
    expect(insertedSets).toHaveLength(0)
  })

  it('chunks text by approximate word size across sentences', async () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence ${i} has five words.`).join(' ')
    const exposure = { id: 1, passport_id: 'p1', content_hash: 'h', text, ts: new Date() }
    const { run, openai, insertedSets } = makeMemory({ exposure, chunkSize: 50 })

    await run()
    expect(openai.embed).toHaveBeenCalledTimes(1)
    const chunks = openai.embed.mock.calls[0][0]
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(insertedSets[0].chunks.length).toBe(chunks.length)
  })

  it('skips when exposure not found', async () => {
    const { run, openai } = makeMemory({ exposure: null })
    await run()
    expect(openai.embed).not.toHaveBeenCalled()
  })

  it('skips when exposure has no content_hash (e.g. disabled)', async () => {
    const exposure = { id: 1, passport_id: 'p1', text: 'x', ts: new Date() }
    const { run, store, openai } = makeMemory({ exposure })
    await run()
    expect(store.hasChunks).not.toHaveBeenCalled()
    expect(openai.embed).not.toHaveBeenCalled()
  })

  it('skips when text produces no chunks', async () => {
    const exposure = { id: 1, passport_id: 'p1', content_hash: 'h', text: '', ts: new Date() }
    const { run, openai } = makeMemory({ exposure })
    await run()
    expect(openai.embed).not.toHaveBeenCalled()
  })

  it('enqueue() schedules the embed job with retry + exponential backoff', async () => {
    const exposure = { id: 1, passport_id: 'p1', content_hash: 'h', text: 'hi', ts: new Date() }
    const { memory, embedQueueAdd } = makeMemory({ exposure })
    await memory.enqueue(42)
    expect(embedQueueAdd).toHaveBeenCalledWith(
      'embed',
      { exposureId: 42 },
      expect.objectContaining({
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnFail: false,
      }),
    )
  })

  it('enqueue() respects configured attempts / backoffMs', async () => {
    let workerHandler = null
    const embedQueueAdd = vi.fn(async () => {})
    const queue = {
      createQueue: vi.fn(() => ({ add: embedQueueAdd })),
      createWorker: vi.fn((name, handler) => { workerHandler = handler }),
    }
    store.findExposure.mockReset()
    store.hasChunks.mockReset()
    store.insertChunks.mockReset()
    const openai = { embed: vi.fn() }
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const config = { awareness: { embedding: { attempts: 2, backoffMs: 1000 } } }
    memory.init({ store, openai, queue, config, logger })

    await memory.enqueue(7)
    expect(embedQueueAdd).toHaveBeenCalledWith(
      'embed',
      { exposureId: 7 },
      expect.objectContaining({ attempts: 2, backoff: { type: 'exponential', delay: 1000 } }),
    )
  })
})

describe('awareness.memory — concurrent dedup', () => {

  it('only the first concurrent worker for a hash calls embed', async () => {
    const sharedA = { id: 1, passport_id: 'p1', content_hash: 'shared', text: 'Same content here.', ts: new Date() }
    const sharedB = { id: 2, passport_id: 'p2', content_hash: 'shared', text: 'Same content here.', ts: new Date() }

    let workerHandler = null
    const queue = {
      createQueue: vi.fn(() => ({ add: vi.fn() })),
      createWorker: vi.fn((name, handler) => { workerHandler = handler }),
    }

    let chunksExist = false
    store.findExposure.mockReset().mockImplementation(async (id) => id === 1 ? sharedA : sharedB)
    store.hasChunks.mockReset().mockImplementation(async () => chunksExist)
    store.insertChunks.mockReset().mockImplementation(async () => { chunksExist = true })

    const openai = {
      embed: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 30))
        return [[0.1]]
      }),
    }
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    memory.init({ store, openai, queue, config: { awareness: {} }, logger })

    await Promise.all([
      workerHandler({ data: { exposureId: 1 } }),
      new Promise(r => setTimeout(r, 5)).then(() => workerHandler({ data: { exposureId: 2 } })),
    ])

    expect(openai.embed).toHaveBeenCalledTimes(1)
  })
})
