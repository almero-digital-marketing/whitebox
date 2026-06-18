import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import * as ai from 'whitebox-server/ai'
import * as speech from '../src/speech.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, '../../whitebox-server/tests/fixtures/voip')
const SAMPLE = 'sample.mp3'

const context = fs.readFileSync(path.join(FIXTURES, 'speech.md'), 'utf8').trim()

// Live test: hits the real Whisper API. Build only what speech.init needs
// (config.ai + config.voip.{language,recordsFolder}) straight from the env, and
// skip when no key is present so the suite stays green without credentials.
const apiKey = process.env.WB_OPENAI_API_KEY
const config = {
  ai: { apiKey },
  voip: { language: 'bg-BG', recordsFolder: FIXTURES },
}

beforeAll(async () => {
  if (!apiKey) return
  await ai.init({ config })
  await speech.init({ config, ai, logger: console, context })
})

describe.skipIf(!apiKey)('transcribe', () => {
  it('returns a non-empty transcript for a real audio file', async () => {
    const result = await speech.transcribe(SAMPLE)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
    console.log('Transcript:', result)
  }, 120000)
})
