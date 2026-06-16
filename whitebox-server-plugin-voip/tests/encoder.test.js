import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import * as encoder from '../src/encoder.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, '../../whitebox-server/tests/fixtures/voip')
const SAMPLE_WAV = 'sample.wav'

// Re-init the module singleton with a fresh recordsFolder per test, return
// the namespace so existing `encoder.duration()` / `encoder.encode()` call
// sites are unchanged.
function makeEncoder(recordsFolder) {
  const logger = { warn: () => { } }
  const config = { voip: { recordsFolder } }
  encoder.init({ config, logger })
  return encoder
}

describe('duration', () => {
  it('returns the duration of a wav file in seconds', async () => {
    const encoder = makeEncoder(FIXTURES)
    const secs = await encoder.duration(SAMPLE_WAV)
    expect(typeof secs).toBe('number')
    expect(secs).toBeGreaterThan(0)
  })

  it('returns a floored integer', async () => {
    const encoder = makeEncoder(FIXTURES)
    const secs = await encoder.duration(SAMPLE_WAV)
    expect(secs).toBe(Math.floor(secs))
  })

  it('rejects for a missing file', async () => {
    const encoder = makeEncoder(FIXTURES)
    await expect(encoder.duration('nonexistent.wav')).rejects.toThrow()
  })
})

describe('encode', () => {
  const TMP = path.join(FIXTURES, 'tmp')
  let tmpWav

  beforeEach(() => {
    fs.mkdirSync(TMP, { recursive: true })
    tmpWav = `test-${Date.now()}.wav`
    fs.copyFileSync(path.join(FIXTURES, SAMPLE_WAV), path.join(TMP, tmpWav))
  })

  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true })
  })

  it('produces an mp3 file', async () => {
    const encoder = makeEncoder(TMP)
    const mp3 = await encoder.encode(tmpWav)
    expect(mp3).toBe(tmpWav.replace('.wav', '.mp3'))
    expect(fs.existsSync(path.join(TMP, mp3))).toBe(true)
  })

  it('removes the source wav after encoding', async () => {
    const encoder = makeEncoder(TMP)
    await encoder.encode(tmpWav)
    expect(fs.existsSync(path.join(TMP, tmpWav))).toBe(false)
  })

  it('rejects for a missing file', async () => {
    const encoder = makeEncoder(TMP)
    await expect(encoder.encode('nonexistent.wav')).rejects.toThrow()
  })
})
