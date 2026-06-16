import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as pool from '../src/pool.js'
import * as phonebook from '../src/phonebook.js'

const LINES = {
  sales:   ['+35924000001', '+35924000002'],
  support: ['+35924000003'],
}

function makeConnect() {
  const handlers = { connected: null, disconnected: null, message: null }
  const emitted = []
  return {
    emit: vi.fn((connectionId, event, data) => emitted.push({ connectionId, event, data })),
    onConnected: fn => { handlers.connected = fn },
    onDisconnected: fn => { handlers.disconnected = fn },
    onMessage: fn => { handlers.message = fn },
    // helpers for triggering events in tests
    triggerConnected: data => handlers.connected(data),
    triggerDisconnected: data => handlers.disconnected(data),
    triggerMessage: data => handlers.message(data),
    emitted,
  }
}

// Re-init the pool + phonebook singletons per test (the pool's slots/pool
// state resets on init) and return the namespace so existing `ctx.pool.find()`
// call sites are unchanged.
function makePool(overrideLines, { notify } = {}) {
  const connect = makeConnect()
  const logger = { debug: vi.fn(), warn: vi.fn() }
  const config = { voip: { lines: overrideLines ?? LINES, country: 'BG' } }
  phonebook.init({ config })
  pool.init({ config, connect, notify, logger })
  return { pool, connect, logger }
}

function click(ctx, id, tag = 'sales') {
  ctx.connect.triggerMessage({ connectionId: id, event: 'voip.click', data: { tag } })
}

function connect(ctx, id, { passportId = null, sessionId = null } = {}) {
  ctx.connect.triggerConnected({ connectionId: id, passportId, sessionId })
}

function disconnect(ctx, id) {
  ctx.connect.triggerDisconnected({ connectionId: id })
}

function pick(ctx, id, tag = 'sales') {
  ctx.connect.triggerMessage({ connectionId: id, event: 'voip.pick', data: { tag } })
}

function hang(ctx, id, tag = 'sales') {
  ctx.connect.triggerMessage({ connectionId: id, event: 'voip.hang', data: { tag } })
}

function emittedTo(ctx, connectionId, event) {
  return ctx.connect.emitted.filter(e => e.connectionId === connectionId && e.event === event)
}

describe('connect / disconnect', () => {
  it('adds visitor to pool on connect', () => {
    const ctx = makePool()
    connect(ctx, 'c1', { passportId: 'p1', sessionId: 42 })
    const found = ctx.pool.find('+35924000001') // nothing assigned yet
    expect(found).toBeNull()
    // visible side-effect: connecting then picking should work
    pick(ctx, 'c1')
    expect(ctx.pool.find('+35924000001') || ctx.pool.find('+35924000002')).not.toBeNull()
  })

  it('removes visitor from pool on disconnect', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    pick(ctx, 'c1')
    disconnect(ctx, 'c1')
    expect(ctx.pool.find('+35924000001')).toBeNull()
    expect(ctx.pool.find('+35924000002')).toBeNull()
  })

  it('returns released number to pool when visitor disconnects', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    connect(ctx, 'c2')
    pick(ctx, 'c1')
    pick(ctx, 'c2')
    disconnect(ctx, 'c1')
    // one number freed — a third visitor can now get it
    connect(ctx, 'c3')
    pick(ctx, 'c3')
    const found = emittedTo(ctx, 'c3', 'voip.number')
    expect(found).toHaveLength(1)
  })
})

describe('assign', () => {
  it('emits voip.number when a number is available', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    pick(ctx, 'c1')
    const events = emittedTo(ctx, 'c1', 'voip.number')
    expect(events).toHaveLength(1)
    expect(events[0].data.tag).toBe('sales')
    expect(LINES.sales).toContain(events[0].data.number)
  })

  it('stores the assigned number on find()', () => {
    const ctx = makePool()
    connect(ctx, 'c1', { passportId: 'p1', sessionId: 7 })
    pick(ctx, 'c1')
    const number = emittedTo(ctx, 'c1', 'voip.number')[0].data.number
    const found = ctx.pool.find(number)
    expect(found).toMatchObject({ connectionId: 'c1', passportId: 'p1', sessionId: 7, tag: 'sales' })
  })

  it('does not assign the same number twice to the same visitor', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    pick(ctx, 'c1')
    pick(ctx, 'c1')
    expect(emittedTo(ctx, 'c1', 'voip.number')).toHaveLength(1)
  })

  it('assigns numbers across different tags independently', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    pick(ctx, 'c1', 'sales')
    pick(ctx, 'c1', 'support')
    expect(emittedTo(ctx, 'c1', 'voip.number')).toHaveLength(2)
  })

  it('emits voip.unavailable when no numbers are free', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    connect(ctx, 'c2')
    connect(ctx, 'c3')
    pick(ctx, 'c1')
    pick(ctx, 'c2')
    pick(ctx, 'c3') // only 2 sales numbers
    expect(emittedTo(ctx, 'c3', 'voip.unavailable')).toHaveLength(1)
  })
})

describe('release', () => {
  it('frees the number on voip.hang', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    pick(ctx, 'c1')
    hang(ctx, 'c1')
    expect(ctx.pool.find('+35924000001')).toBeNull()
    expect(ctx.pool.find('+35924000002')).toBeNull()
  })

  it('assigns freed number to a waiting visitor', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    connect(ctx, 'c2')
    connect(ctx, 'c3')
    pick(ctx, 'c1')
    pick(ctx, 'c2')
    pick(ctx, 'c3') // goes to waiting
    hang(ctx, 'c1') // releases → c3 should get it
    expect(emittedTo(ctx, 'c3', 'voip.number')).toHaveLength(1)
  })

  it('removes disconnected visitor from waiting so the next release goes to a connected visitor', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    connect(ctx, 'c2')
    connect(ctx, 'c3')
    connect(ctx, 'c4')
    pick(ctx, 'c1')
    pick(ctx, 'c2')
    pick(ctx, 'c3') // waiting
    pick(ctx, 'c4') // waiting — waiting = [c3, c4]
    disconnect(ctx, 'c3') // c3 removed from waiting
    hang(ctx, 'c1') // releases → c4 (only remaining) should get it
    expect(emittedTo(ctx, 'c4', 'voip.number')).toHaveLength(1)
  })
})

describe('hold timeout', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('moves visitor to postponed when hold expires with no one waiting', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    pick(ctx, 'c1')
    vi.runAllTimers()
    // number still assigned (no one waiting), find() still returns c1
    const number = emittedTo(ctx, 'c1', 'voip.number')[0].data.number
    expect(ctx.pool.find(number)).toMatchObject({ connectionId: 'c1' })
  })

  it('releases number when hold expires and someone is waiting', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    connect(ctx, 'c2')
    connect(ctx, 'c3')
    pick(ctx, 'c1')
    pick(ctx, 'c2')
    pick(ctx, 'c3') // waiting
    vi.runAllTimers() // c1 or c2 hold expires → c3 gets the number
    expect(emittedTo(ctx, 'c3', 'voip.number')).toHaveLength(1)
  })

  it('evicts postponed visitor when a new visitor needs a number', () => {
    const ctx = makePool()
    // fill both sales slots
    connect(ctx, 'c1')
    connect(ctx, 'c2')
    pick(ctx, 'c1')
    pick(ctx, 'c2')
    // let timers fire with no one waiting → both go to postponed
    vi.runAllTimers()
    // new visitor picks — should evict one postponed visitor
    connect(ctx, 'c3')
    pick(ctx, 'c3')
    expect(emittedTo(ctx, 'c3', 'voip.number')).toHaveLength(1)
  })
})

describe('notify', () => {
  it('emits voip.ring to the visitor holding the called number', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    pick(ctx, 'c1')
    ctx.pool.notifyRing('c1', { tag: 'sales', caller: '+359880000099' })
    const rings = emittedTo(ctx, 'c1', 'voip.ring')
    expect(rings).toHaveLength(1)
    expect(rings[0].data.caller).toBe('+359880000099')
    expect(LINES.sales).toContain(rings[0].data.number)
  })

  it('does not emit voip.ring if visitor has no number assigned', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    ctx.pool.notifyRing('c1', { tag: 'sales', caller: '+359880000099' })
    expect(emittedTo(ctx, 'c1', 'voip.ring')).toHaveLength(0)
  })
})

describe('voip.number includes formatted', () => {
  it('uses phonebook.format() to pretty-print the assigned number', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    pick(ctx, 'c1', 'sales')
    const emit = emittedTo(ctx, 'c1', 'voip.number')[0]
    expect(emit).toBeDefined()
    expect(emit.data).toMatchObject({
      tag: 'sales',
      number: expect.stringMatching(/^\+/),
      formatted: phonebook.format(emit.data.number),
    })
    // phonebook.format turns E.164 into international form (spaces inserted).
    expect(emit.data.formatted).toBe(phonebook.format(emit.data.number))
    expect(emit.data.formatted).toContain(' ')
  })
})

describe('voip.click', () => {
  it('marks the number as clicked and fires notify', () => {
    const notify = vi.fn(async () => {})
    const ctx = makePool(undefined, { notify })
    connect(ctx, 'c1', { passportId: 'p1', sessionId: 9 })
    pick(ctx, 'c1', 'sales')
    const number = emittedTo(ctx, 'c1', 'voip.number')[0].data.number

    click(ctx, 'c1', 'sales')

    expect(notify).toHaveBeenCalledWith('voip.click', expect.objectContaining({
      type: 'voip.click',
      data: expect.objectContaining({
        tag: 'sales',
        number,
        connectionId: 'c1',
        passportId: 'p1',
        sessionId: 9,
      }),
    }))

    // find() now reports clicked=true
    const found = ctx.pool.find(number)
    expect(found?.clicked).toBe(true)
  })

  it('extends hold to CLICKED_HOLD_TIMEOUT (no immediate auto-release)', async () => {
    vi.useFakeTimers()
    const ctx = makePool()
    connect(ctx, 'c1')
    pick(ctx, 'c1', 'sales')
    click(ctx, 'c1', 'sales')

    // The default HOLD_TIMEOUT in dev is 10s. Advance past it; the clicked
    // number should still be assigned.
    vi.advanceTimersByTime(15_000)

    const numberEntry = emittedTo(ctx, 'c1', 'voip.number')[0].data.number
    expect(ctx.pool.find(numberEntry)).toBeTruthy()
    vi.useRealTimers()
  })

  it('is a no-op when no number assigned for tag', () => {
    const notify = vi.fn(async () => {})
    const ctx = makePool(undefined, { notify })
    connect(ctx, 'c1')
    click(ctx, 'c1', 'sales')   // no pick yet
    expect(notify).not.toHaveBeenCalled()
  })

  it('explicit release clears clicked state', () => {
    const ctx = makePool()
    connect(ctx, 'c1')
    pick(ctx, 'c1', 'sales')
    const number = emittedTo(ctx, 'c1', 'voip.number')[0].data.number
    click(ctx, 'c1', 'sales')
    hang(ctx, 'c1', 'sales')
    expect(ctx.pool.find(number)).toBeNull()
  })
})

describe('phonebook.format()', () => {
  it('formats E.164 to international form', () => {
    phonebook.init({ config: { voip: { lines: LINES, country: 'BG' } } })
    const formatted = phonebook.format('+15551234567')
    expect(formatted).toBe('+1 555 123 4567')
  })

  it('returns the raw input when parsing fails', () => {
    phonebook.init({ config: { voip: { lines: LINES, country: 'BG' } } })
    expect(phonebook.format('not-a-number')).toBe('not-a-number')
  })
})
