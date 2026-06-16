import pino from 'pino'

const DEFAULT = {
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
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
