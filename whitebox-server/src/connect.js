import { Server } from 'socket.io'
import logger from './logger.js'

const CH_EMIT = 'whitebox:connect:emit'
const CH_BROADCAST = 'whitebox:connect:broadcast'
const CH_CONNECTED = 'whitebox:connect:connected'
const CH_DISCONNECTED = 'whitebox:connect:disconnected'
const CH_MESSAGE = 'whitebox:connect:message'

let events
let sessions

const connections = new Map()

function init(options) {
  events = options.events
  sessions = options.sessions

  const io = new Server(options.server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  })

  io.on('connection', async socket => {
    const connectionId = socket.id
    const { passport: passportId, utm_source, utm_medium, utm_campaign, utm_term, utm_content } = socket.handshake.query
    const utms = { utm_source, utm_medium, utm_campaign, utm_term, utm_content }

    const session = await sessions.resolve(passportId || null, utms).catch(err => {
      logger.warn({ err }, 'Failed to resolve session for %s', connectionId)
      return null
    })

    connections.set(connectionId, { sessionId: session?.id || null, passportId: passportId || null })

    logger.debug('Socket connected: %s', connectionId)
    events.publish(CH_CONNECTED, { connectionId, passportId: passportId || null, sessionId: session?.id || null })

    socket.onAny((event, data) => {
      events.publish(CH_MESSAGE, { connectionId, event, data })
    })

    socket.on('disconnect', async () => {
      connections.delete(connectionId)
      logger.debug('Socket disconnected: %s', connectionId)
      events.publish(CH_DISCONNECTED, { connectionId })
    })
  })

  events.subscribe(CH_EMIT, ({ connectionId, event, data }) => {
    io.to(connectionId).emit(event, data)
  })

  events.subscribe(CH_BROADCAST, ({ event, data }) => {
    io.emit(event, data)
  })

  logger.info('Socket.io ready')
}

function emit(connectionId, event, data) {
  return events.publish(CH_EMIT, { connectionId, event, data })
}

function broadcast(event, data) {
  return events.publish(CH_BROADCAST, { event, data })
}

function find(connectionId) {
  const connection = connections.get(connectionId)
  return connection || null
}

function onMessage(handler) {
  events.subscribe(CH_MESSAGE, handler)
}

function onConnected(handler) {
  events.subscribe(CH_CONNECTED, handler)
}

function onDisconnected(handler) {
  events.subscribe(CH_DISCONNECTED, handler)
}

export { init, emit, broadcast, find, onMessage, onConnected, onDisconnected }
