import path from 'path'
import os from 'os'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { createWriteStream } from 'fs'
import axios from 'axios'
import sharp from 'sharp'
import ffmpeg from 'fluent-ffmpeg'

const TABLE = 'whitebox_engagement_content'

const IMAGE_PROMPT = 'Describe this image in 2-3 sentences for content awareness tracking. Focus on subject, message, and notable text shown.'
const FRAME_PROMPT = 'Describe this video frame in one sentence. Focus on subjects, action, on-screen text, and notable visual elements.'

// Dependencies captured once via init() — module-level singletons, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
let db
let ai
let logger
let image
let video

export function init(deps) {
  db = deps.db
  ai = deps.ai
  logger = deps.logger

  const cfg = deps.options || {}
  image = {
    maxSide: cfg.image?.maxSide ?? 1024,
    quality: cfg.image?.quality ?? 85,
    detail: cfg.image?.detail ?? 'low',
    maxDownloadMB: cfg.image?.maxDownloadMB ?? 20,
  }
  video = {
    extractVisual: cfg.video?.extractVisual !== false,
    framePeriodSec: cfg.video?.framePeriodSec ?? 5,
    sceneThreshold: cfg.video?.sceneThreshold ?? 0.3,
    visionDetail: cfg.video?.visionDetail ?? 'low',
    maxFrames: cfg.video?.maxFrames ?? 100,
    maxDurationSec: cfg.video?.maxDurationSec ?? 1800,
    maxDownloadMB: cfg.video?.maxDownloadMB ?? 500,
  }
}

// -------- image --------

export async function resolveImage(url, providedDescription) {
  const cached = await db(TABLE).where({ url }).first()
  if (cached) return cached

  if (providedDescription) {
    return upsert({ url, kind: 'image', text: providedDescription, source_kind: 'provided' })
  }

  const { buf } = await fetchAndResize(url)
  const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`
  const description = await ai.vision(IMAGE_PROMPT, dataUrl, { detail: image.detail, maxTokens: 200 })

  return upsert({
    url, kind: 'image', text: description, source_kind: 'auto',
    meta: { model: 'gpt-4o', detail: image.detail },
  })
}

async function fetchAndResize(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 10_000,
    maxContentLength: image.maxDownloadMB * 1024 * 1024,
  })
  const contentType = res.headers['content-type'] || ''
  if (!contentType.startsWith('image/')) throw new Error(`Not an image: ${contentType}`)

  const buf = await sharp(Buffer.from(res.data))
    .resize({ width: image.maxSide, height: image.maxSide, fit: 'inside', withoutEnlargement: true })
    .rotate()
    .jpeg({ quality: image.quality, mozjpeg: true })
    .withMetadata({ exif: {} })
    .toBuffer()

  return { buf }
}

// -------- video --------

export async function resolveVideo(url, providedTranscript) {
  const cached = await db(TABLE).where({ url }).first()
  if (cached) return cached

  if (providedTranscript) {
    const segments = parseProvidedTranscript(providedTranscript)
    return upsert({
      url, kind: 'video',
      text: segments.map(s => s.audio).filter(Boolean).join(' '),
      segments,
      source_kind: 'provided',
    })
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wb-engagement-'))
  try {
    const videoPath = await downloadVideo(url, tmp)
    const audioPath = await extractAudio(videoPath, tmp)

    const [whisper, frames] = await Promise.all([
      ai.transcribe(audioPath, { response_format: 'verbose_json' }),
      video.extractVisual ? extractAndDescribeFrames(videoPath, tmp) : Promise.resolve([]),
    ])

    const segments = mergeSegments(whisper.segments || [], frames)
    const text = segments.map(s => [s.audio, s.visual].filter(Boolean).join(' ')).join('\n')

    return upsert({
      url, kind: 'video', text, segments, source_kind: 'auto',
      meta: {
        duration_s: whisper.duration,
        frames: frames.length,
        has_visual: frames.length > 0,
      },
    })
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

async function downloadVideo(url, tmpDir) {
  const dest = path.join(tmpDir, 'video.mp4')
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 60_000,
    maxContentLength: video.maxDownloadMB * 1024 * 1024,
  })
  await new Promise((resolve, reject) => {
    const w = createWriteStream(dest)
    res.data.pipe(w)
    w.on('finish', resolve)
    w.on('error', reject)
  })
  return dest
}

function extractAudio(videoPath, tmpDir) {
  const audioPath = path.join(tmpDir, 'audio.mp3')
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .on('error', reject)
      .on('end', () => resolve(audioPath))
      .save(audioPath)
  })
}

async function extractAndDescribeFrames(videoPath, tmpDir) {
  const framesDir = path.join(tmpDir, 'frames')
  await mkdtemp(framesDir).catch(() => {})

  const period = video.framePeriodSec
  const scene = video.sceneThreshold

  const frames = await new Promise((resolve, reject) => {
    const result = []
    ffmpeg(videoPath)
      .outputOptions([
        `-vf select='gt(scene\\,${scene})+lt(prev_selected_t\\,t-${period})',scale=768:768:force_original_aspect_ratio=decrease,showinfo`,
        '-vsync', 'vfr',
        '-q:v', '5',
      ])
      .on('stderr', line => {
        // showinfo emits "pts_time:<t>" — capture frame timestamps
        const m = line.match(/pts_time:([\d.]+)/)
        if (m) result.push({ t: parseFloat(m[1]), index: result.length })
      })
      .on('error', reject)
      .on('end', () => resolve(result))
      .save(path.join(framesDir, 'f-%04d.jpg'))
  })

  const limited = frames.slice(0, video.maxFrames)

  const descriptions = await Promise.all(limited.map(async (frame, i) => {
    const framePath = path.join(framesDir, `f-${String(i + 1).padStart(4, '0')}.jpg`)
    try {
      const buf = await sharp(framePath).jpeg({ quality: 80 }).toBuffer()
      const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`
      const desc = await ai.vision(FRAME_PROMPT, dataUrl, { detail: video.visionDetail, maxTokens: 80 })
      return { t: frame.t, description: desc }
    } catch (err) {
      logger.warn({ err, t: frame.t }, 'Frame describe failed')
      return null
    }
  }))

  return descriptions.filter(Boolean)
}

function mergeSegments(whisperSegments, frameDescriptions) {
  const out = []
  for (const s of whisperSegments) {
    const visuals = frameDescriptions
      .filter(f => f.t >= s.start && f.t <= s.end)
      .map(f => f.description)
    out.push({
      start_s: s.start,
      end_s: s.end,
      audio: s.text?.trim() || null,
      visual: visuals.length ? visuals.join(' | ') : null,
    })
  }
  // Capture visuals between/after audio segments as visual-only segments
  if (frameDescriptions.length) {
    const audioEnd = whisperSegments.length ? whisperSegments[whisperSegments.length - 1].end : 0
    const leftover = frameDescriptions.filter(f => f.t > audioEnd)
    if (leftover.length) {
      out.push({
        start_s: audioEnd,
        end_s: leftover[leftover.length - 1].t,
        audio: null,
        visual: leftover.map(f => f.description).join(' | '),
      })
    }
  }
  return out
}

function parseProvidedTranscript(transcript) {
  // Accepts: string (single segment) or [{ start_s, end_s, audio, visual }]
  if (typeof transcript === 'string') {
    return [{ start_s: 0, end_s: null, audio: transcript, visual: null }]
  }
  if (Array.isArray(transcript)) return transcript
  return []
}

// -------- slicing --------
//
// sliceVideo(content, intervals)
//   intervals: [{ start_s, end_s }, ...]  — watched ranges
//   - null/empty intervals → full text
//   - single object { start_s, end_s } → wrapped as one-element array (back-compat)
//   - legacy two-arg call (start_s, end_s) → wrapped to one interval
//
// Returns the concatenated transcript text for every segment that overlaps
// ANY interval, joined by newline. Each segment is included at most once.

export function sliceVideo(content, intervalsOrStart, endS) {
  if (!content.segments?.length) return content.text || ''

  let intervals = intervalsOrStart
  // Legacy two-arg form
  if (typeof intervalsOrStart === 'number' || typeof endS === 'number') {
    intervals = [{ start_s: intervalsOrStart, end_s: endS }]
  }
  // Single-object form
  if (intervals && !Array.isArray(intervals) && typeof intervals === 'object') {
    intervals = [intervals]
  }
  if (!intervals?.length) return content.text || ''

  const ranges = intervals
    .filter(r => r && (r.end_s == null || r.end_s > (r.start_s ?? 0)))
    .map(r => ({ from: r.start_s ?? 0, to: r.end_s ?? Infinity }))

  if (!ranges.length) return content.text || ''

  return content.segments
    .filter(s => {
      if (s.end_s == null) return true
      return ranges.some(r => s.end_s >= r.from && s.start_s <= r.to)
    })
    .map(s => [s.audio, s.visual].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n')
}

// -------- store --------

async function upsert(row) {
  const [out] = await db(TABLE).insert(row).onConflict('url').merge().returning('*')
  return out
}

export async function invalidate(url) {
  return db(TABLE).where({ url }).del()
}
