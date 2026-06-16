import path from 'path'
import { unlink } from 'fs/promises'
import ffmpeg from 'fluent-ffmpeg'

let recordsFolder, logger

export function init(deps) {
  recordsFolder = deps.config.voip.recordsFolder
  logger = deps.logger
}

export function duration(filename) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(path.join(recordsFolder, filename), (err, meta) => {
      if (err) reject(err)
      else resolve(Math.floor(meta.format.duration))
    })
  })
}

export function encode(filename) {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.mp3') return Promise.resolve(filename)

  const src = path.join(recordsFolder, filename)
  const mp3 = filename.slice(0, -ext.length) + '.mp3'
  const dest = path.join(recordsFolder, mp3)

  return new Promise((resolve, reject) => {
    ffmpeg(src)
      .on('error', reject)
      .on('end', () => {
        unlink(src)
          .catch(err => logger.warn({ err }, 'Could not delete source: %s', filename))
          .then(() => resolve(mp3))
      })
      .save(dest)
  })
}
