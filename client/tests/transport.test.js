import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import createTransport from '../src/transport.js'
import createEmitter from '../src/emitter.js'

// Mock socket.io-client at the module level so the dynamic import in transport.js
// receives our fake `io` factory.
vi.mock('socket.io-client', () => {
  const handlers = new Map()
  const fakeSocket = {
    on: vi.fn((event, fn) => {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event).add(fn)
    }),
    onAny: vi.fn(fn => { fakeSocket._any = fn }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    id: 'fake-sock-1',
    _trigger(event, ...args) {
      handlers.get(event)?.forEach(fn => fn(...args))
    },
  }
  return {
    io: vi.fn(() => fakeSocket),
    _fakeSocket: fakeSocket,
  }
})

describe('transport (socket.io)', () => {

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('open() loads socket.io-client and creates a socket', async () => {
    const emitter = createEmitter()
    const t = createTransport({
      url: 'http://test',
      getSessionId: () => null,
      getPassportId: () => 'p-1',
      emitter,
      logger: { warn: () => {} },
    })

    const socket = await t.open()
    expect(socket).toBeDefined()

    const { io } = await import('socket.io-client')
    expect(io).toHaveBeenCalledWith('http://test', expect.objectContaining({
      transports: ['websocket', 'polling'],
      reconnection: true,
    }))
    // Passport should be passed in the connection query
    const options = io.mock.calls[0][1]
    expect(options.query.passport).toBe('p-1')
  })

  it('emits transport:connected on socket connect', async () => {
    const emitter = createEmitter()
    const onConnected = vi.fn()
    emitter.on('transport:connected', onConnected)

    const t = createTransport({
      url: 'http://test',
      getSessionId: () => null,
      getPassportId: () => null,
      emitter,
      logger: { warn: () => {} },
    })

    await t.open()
    const { _fakeSocket } = await import('socket.io-client')
    _fakeSocket._trigger('connect')

    expect(onConnected).toHaveBeenCalled()
  })

  it('send() returns false when not connected', async () => {
    const emitter = createEmitter()
    const t = createTransport({
      url: 'http://test', getSessionId: () => null, getPassportId: () => null,
      emitter, logger: { warn: () => {} },
    })
    expect(t.send('foo', {})).toBe(false)
  })

  it('send() emits via the socket when connected', async () => {
    const emitter = createEmitter()
    const t = createTransport({
      url: 'http://test', getSessionId: () => null, getPassportId: () => null,
      emitter, logger: { warn: () => {} },
    })
    await t.open()
    const { _fakeSocket } = await import('socket.io-client')
    _fakeSocket._trigger('connect')

    const ok = t.send('engagement.batch', { events: [{ x: 1 }] })
    expect(ok).toBe(true)
    expect(_fakeSocket.emit).toHaveBeenCalledWith('engagement.batch', { events: [{ x: 1 }] })
  })

  it('onAny re-emits socket events through the emitter', async () => {
    const emitter = createEmitter()
    const onCustom = vi.fn()
    emitter.on('voip.ring', onCustom)

    const t = createTransport({
      url: 'http://test', getSessionId: () => null, getPassportId: () => null,
      emitter, logger: { warn: () => {} },
    })
    await t.open()
    const { _fakeSocket } = await import('socket.io-client')
    _fakeSocket._any('voip.ring', { caller: '+1234' })

    expect(onCustom).toHaveBeenCalledWith({ caller: '+1234' })
  })

  it('close() disconnects the socket', async () => {
    const emitter = createEmitter()
    const t = createTransport({
      url: 'http://test', getSessionId: () => null, getPassportId: () => null,
      emitter, logger: { warn: () => {} },
    })
    await t.open()
    t.close()
    const { _fakeSocket } = await import('socket.io-client')
    expect(_fakeSocket.disconnect).toHaveBeenCalled()
  })
})
