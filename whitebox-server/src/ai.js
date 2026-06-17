// AI facade — backed by the Vercel AI SDK. The OpenAI provider is the engine
// today (`@ai-sdk/openai`), but it's isolated in this module so it can be
// swapped without touching consumers. Consumers inject this as `ai` and call
// prompt / embed / vision / transcribe / expand — never the provider directly.

import { createOpenAI } from '@ai-sdk/openai'
import { generateText, embedMany, experimental_transcribe as aiTranscribe } from 'ai'
import { readFile } from 'fs/promises'
import { encode } from '@toon-format/toon'

const CHAT_MODEL = 'gpt-4o'
const EMBED_MODEL = 'text-embedding-3-small'
const TRANSCRIBE_MODEL = 'whisper-1'

// Provider captured once via init() — module-level singleton (no factory
// closure), matching the rest of core. Null until configured; methods throw.
let provider = null

export async function init(options) {
  const apiKey = options.config?.ai?.apiKey
  if (!apiKey) return
  provider = createOpenAI({ apiKey })
}

export async function prompt(system, user) {
  if (!provider) throw new Error('AI provider not configured')
  const { text } = await generateText({
    model: provider(CHAT_MODEL),
    system,
    prompt: user,
  })
  return text
}

export async function embed(texts, { model = EMBED_MODEL } = {}) {
  if (!provider) throw new Error('AI provider not configured')
  const input = Array.isArray(texts) ? texts : [texts]
  if (!input.length) return []
  const { embeddings } = await embedMany({
    model: provider.embedding(model),
    values: input,
  })
  return embeddings
}

export async function vision(promptText, imageUrl, { detail = 'low', maxTokens = 200 } = {}) {
  if (!provider) throw new Error('AI provider not configured')
  const { text } = await generateText({
    model: provider(CHAT_MODEL),
    maxOutputTokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        { type: 'image', image: imageUrl, providerOptions: { openai: { imageDetail: detail } } },
      ],
    }],
  })
  return text
}

// Returns a plain string by default; for response_format === 'verbose_json'
// returns { text, duration, segments: [{ start, end, text }] } — the same
// shape Whisper's verbose output exposed, so consumers don't change.
export async function transcribe(filePath, { language, prompt, response_format } = {}) {
  if (!provider) throw new Error('AI provider not configured')
  const audio = await readFile(filePath)
  const verbose = response_format === 'verbose_json'

  const transcribeOptions = {}
  if (language) transcribeOptions.language = language
  if (prompt) transcribeOptions.prompt = prompt
  if (verbose) transcribeOptions.timestampGranularities = ['segment']

  const res = await aiTranscribe({
    model: provider.transcription(TRANSCRIBE_MODEL),
    audio,
    providerOptions: { openai: transcribeOptions },
  })

  if (!verbose) return res.text
  return {
    text: res.text,
    duration: res.durationInSeconds,
    segments: (res.segments || []).map(s => ({
      start: s.startSecond,
      end: s.endSecond,
      text: s.text,
    })),
  }
}

export async function expand(content) {
  const urls = content.match(/https?:\/\/\S+/g)
  if (!urls?.length) return content

  const fetched = await Promise.all(urls.map(async url => {
    try {
      const res = await fetch(url)
      const contentType = res.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const json = await res.json()
        const data = json?.data?.meta ?? json
        return `\n\n--- ${url} ---\n${encode(data)}`
      } else {
        const text = await res.text()
        return `\n\n--- ${url} ---\n${text}`
      }
    } catch {
      return ''
    }
  }))

  return content + fetched.join('')
}
