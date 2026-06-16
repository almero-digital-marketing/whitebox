import path from 'path'

let language, recordsFolder, openai, logger, context
let business = null

export async function init(deps) {
  language = deps.config.voip.language
  recordsFolder = deps.config.voip.recordsFolder
  openai = deps.openai
  logger = deps.logger
  context = deps.context
  business = context ? await openai.expand(context) : null
}

function buildPrompt() {
  return [
    'Phone call between a customer and a company representative.',
    context || '',
  ].filter(Boolean).join(' ').slice(0, 800)
}

export async function transcribe(filename) {
  const localPath = path.join(recordsFolder, filename)
  const lang = language?.split('-')[0]

  const text = await openai.transcribe(localPath, { language: lang, prompt: buildPrompt() })

  if (!text) return text

  const normalized = await normalize(text).catch(err => {
    logger.warn({ err }, 'Transcription normalization failed')
    return text
  })
  return normalized
}

async function normalize(transcript) {
  const system = [
    'You are a transcription editor.',
    business ? `Context about the business:\n${business}` : '',
    'You will receive a raw phone call transcript between two people.',
    'Fix spelling of names, products, and terms specific to this business.',
    'Correct obvious speech recognition errors. Keep the meaning intact as much as possible.',
    'Return only the corrected transcript, no commentary.',
  ].filter(Boolean).join('\n')

  const result = await openai.prompt(system, transcript)
  return result
}
