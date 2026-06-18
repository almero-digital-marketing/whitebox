import pino from 'pino'

const DEFAULT = {
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      // `component` is rendered inline as a [tag] prefix (see messageFormat), so
      // drop it from the key dump to avoid showing it twice.
      ignore: 'pid,hostname,component',
      // Show which plugin/core module a line came from, inline: "[voip] message".
      // Lines without a component (bare server bootstrap) print clean.
      messageFormat: '{if component}[{component}] {end}{msg}',
    },
  },
}

let logger = pino(DEFAULT)

export function init(options) {
  const cfg = options.config?.logger
  logger = pino({
    level: cfg?.level || DEFAULT.level,
    transport: cfg?.transport !== undefined
      ? cfg.transport
      : process.env.NODE_ENV !== 'production' ? DEFAULT.transport : undefined,
  })
}

export default logger
