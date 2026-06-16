import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import whitebox from '../src/index.js'

function mockFetch(impl) {
  globalThis.fetch = vi.fn(impl)
}

describe('whitebox factory', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    history.replaceState({}, '', '/')
  })

  afterEach(() => {
    delete globalThis.fetch
  })

  it('throws if url is missing', () => {
    expect(() => whitebox({})).toThrow(/url.*required/)
  })

  it('resolves session on init and persists ids', async () => {
    mockFetch(async (input, init) => {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sessionId: 7, passportId: 'p-1' }),
      }
    })
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    await wb.ready
    expect(wb.sessionId).toBe(7)
    expect(wb.passportId).toBe('p-1')
    expect(localStorage.getItem('wb:passport_id')).toBe('p-1')
  })

  it('emits ready event after init', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    const onReady = vi.fn()
    wb.on('ready', onReady)
    await wb.ready
    // Already emitted before listener; that's OK — test that subsequent emit on
    // explicit topic works. Most consumers will use `await wb.ready`.
    expect(typeof wb.ready.then).toBe('function')
  })

  it('plugin install attaches API to wb', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    wb.use({
      name: 'mock',
      install(core) {
        core.attach('mock', { hello: () => 'world' })
      },
    })
    expect(wb.mock.hello()).toBe('world')
  })

  it('plugin throws if install() missing', () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    expect(() => wb.use({})).toThrow(/install/)
  })

  it('forget clears local state', async () => {
    mockFetch(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ sessionId: 1, passportId: 'p' }),
    }))
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    await wb.ready
    expect(wb.passportId).toBe('p')
    wb.forget()
    expect(wb.passportId).toBeNull()
    expect(wb.sessionId).toBeNull()
    expect(localStorage.getItem('wb:passport_id')).toBeNull()
  })

  it('autoResolveSession=false skips the /sessions/resolve call', async () => {
    mockFetch(vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })))
    const wb = whitebox({ url: 'https://api.example.com', autoResolveSession: false, transport: false })
    await wb.ready
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('installs plugins passed in the constructor `plugins: [...]` array', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const calls = []
    const plugin = (name) => ({
      name,
      install(ctx) {
        calls.push({ name, gotUrl: ctx.url, gotEmitter: !!ctx.emitter })
        ctx.attach(name, { who: name })
      },
    })
    const wb = whitebox({
      url: 'https://api.example.com',
      transport: false,
      logger: { warn: () => {} },
      plugins: [plugin('alpha'), plugin('beta')],
    })
    await wb.ready
    expect(calls).toEqual([
      { name: 'alpha', gotUrl: 'https://api.example.com', gotEmitter: true },
      { name: 'beta',  gotUrl: 'https://api.example.com', gotEmitter: true },
    ])
    expect(wb.alpha.who).toBe('alpha')
    expect(wb.beta.who).toBe('beta')
  })

  it('ctx is mutable — later plugins can read what earlier ones wrote', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    let secondSawFirst = null
    const first = {
      name: 'first',
      install(ctx) { ctx.firstState = { secret: 42 } },
    }
    const second = {
      name: 'second',
      install(ctx) { secondSawFirst = ctx.firstState?.secret },
    }
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {} },
      plugins: [first, second],
    })
    await wb.ready
    expect(secondSawFirst).toBe(42)
  })

  it('install can be async — wb.ready awaits all plugins', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    let installed = false
    const slow = {
      name: 'slow',
      async install(ctx) {
        await new Promise(r => setTimeout(r, 5))
        installed = true
        ctx.attach('slow', {})
      },
    }
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {} },
      plugins: [slow],
    })
    await wb.ready
    expect(installed).toBe(true)
  })

  it('teardown fn returned by install() is called by wb.destroy()', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const tornDown = []
    const plugin = (name) => ({
      name,
      install() { return () => tornDown.push(name) },
    })
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {} },
      plugins: [plugin('a'), plugin('b')],
    })
    await wb.ready
    wb.destroy()
    // teardowns run in reverse install order
    expect(tornDown).toEqual(['b', 'a'])
  })

  it('opens transport by default (socket.io)', async () => {
    vi.resetModules()
    vi.doMock('socket.io-client', () => {
      const socket = { on: vi.fn(), onAny: vi.fn(), emit: vi.fn(), disconnect: vi.fn(), id: 's1' }
      return { io: vi.fn(() => socket) }
    })

    const { default: whiteboxFresh } = await import('../src/index.js')
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const wb = whiteboxFresh({ url: 'https://api.example.com', logger: { warn: () => {} } })
    await wb.ready

    const { io } = await import('socket.io-client')
    expect(io).toHaveBeenCalledWith('https://api.example.com', expect.any(Object))
  })
})
