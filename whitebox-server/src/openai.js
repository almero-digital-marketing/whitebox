import { encode } from '@toon-format/toon'

let client = null

export async function init(options) {
  if (!options.config?.openai?.apiKey) return
  const { default: OpenAI } = await import('openai')
  client = new OpenAI({ apiKey: options.config.openai.apiKey })
}

export async function prompt(system, user) {
  if (!client) throw new Error('OpenAI not configured')
  const res = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })
  const text = res.choices[0].message.content
  return text
}

export async function embed(texts, { model = 'text-embedding-3-small' } = {}) {
  if (!client) throw new Error('OpenAI not configured')
  const input = Array.isArray(texts) ? texts : [texts]
  if (!input.length) return []
  const res = await client.embeddings.create({ model, input })
  return res.data.map(d => d.embedding)
}

export async function vision(prompt, imageUrl, { detail = 'low', maxTokens = 200 } = {}) {
  if (!client) throw new Error('OpenAI not configured')
  const res = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageUrl, detail } },
      ],
    }],
  })
  return res.choices[0].message.content
}

export async function transcribe(filePath, { language, prompt, response_format } = {}) {
  if (!client) throw new Error('OpenAI not configured')
  const { createReadStream } = await import('fs')
  const res = await client.audio.transcriptions.create({
    file: createReadStream(filePath),
    model: 'whisper-1',
    language,
    prompt,
    response_format,
  })
  return response_format === 'verbose_json' ? res : res.text
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

  const expanded = content + fetched.join('')
  return expanded
}
