import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import config from '../../whitebox-server/whitebox.config.js'
import * as ai from 'whitebox-server/ai'
import * as speech from '../src/speech.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, '../../whitebox-server/tests/fixtures/voip')
const SAMPLE = 'sample.mp3'

const context = fs.readFileSync(path.join(FIXTURES, 'speech.md'), 'utf8').trim()

const cfg = {
  ...config,
  voip: { ...config.voip, recordsFolder: FIXTURES },
}

beforeAll(async () => {
  await ai.init({ config })
  await speech.init({ config: cfg, ai, logger: console, context })
})

describe('transcribe', () => {
  it('returns a non-empty transcript for a real audio file', async () => {
    const result = await speech.transcribe(SAMPLE)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
    console.log('Transcript:', result)
  }, 120000)
})
