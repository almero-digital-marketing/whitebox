import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock ari-client BEFORE importing the module under test, so the real
// WebSocket connection is never attempted.
const mockClient = {
  handlers: {},
  on(name, fn) { this.handlers[name] = fn },
  start: vi.fn(async () => {}),
  stop:  vi.fn(async () => {}),
  recordings: {
    deleteStored: vi.fn(async () => {}),
  },
}

vi.mock('ari-client', () => ({
  connect: vi.fn(async () => mockClient),
  default: { connect: vi.fn(async () => mockClient) },
}))

// The converted sibling modules ari.js imports directly are mocked so the
// test controls their behavior (they used to be injected via the factory).
vi.mock('../src/calls.js', () => ({
  init: vi.fn(),
  ring: vi.fn(async () => {}),
  pick: vi.fn(async () => {}),
  end:  vi.fn(async () => ({ vault_id: 'v1' })),
  find: vi.fn(async () => ({ vault_id: 'v1', passport_id: 'p1' })),
}))
vi.mock('../src/phonebook.js', () => ({
  init: vi.fn(),
  guessRegionByLineIn: () => 'BG',
  toE164: (n) => n.startsWith('+') ? n : `+359${n}`,
  findLine: () => 'sofia',
  format: (n) => n,
}))
vi.mock('../src/pool.js', () => ({
  init: vi.fn(),
  find: vi.fn(() => null),
  notifyRing: vi.fn(),
}))
vi.mock('../src/encoder.js', () => ({
  init: vi.fn(),
  duration: vi.fn(async () => 30),
  encode: vi.fn(async (f) => f),
}))
vi.mock('../src/speech.js', () => ({
  init: vi.fn(async () => {}),
  transcribe: vi.fn(async () => ''),
}))

const ari = await import('../src/ari.js')
const calls = await import('../src/calls.js')
const pool = await import('../src/pool.js')

function makeDeps(overrides = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return {
    config: {
      voip: {
        ari: { url: 'http://pbx.test:8088', user: 'u', password: 'p', app: 'whitebox' },
        recordsFolder: '/tmp/wb-voip-test',
        url: 'https://example.com',
        country: 'US',
        webhooks: [],
        lines: { sofia: ['+35921234567'] },
      },
    },
    webhooks: { dispatch: vi.fn() },
    events:   { publish: vi.fn(), on: vi.fn() },
    logger,
    passports: { identify: vi.fn(async () => 'p1'), link: vi.fn(async () => {}) },
    sessions:  { findById: vi.fn(async () => null) },
    awareness: { record: vi.fn(async () => {}) },
    speechEnabled: false,
    ...overrides,
  }
}

describe('voip/ari', () => {
  beforeEach(() => {
    mockClient.handlers = {}
    vi.clearAllMocks()
    // Restore default mock return values cleared by clearAllMocks.
    calls.end.mockImplementation(async () => ({ vault_id: 'v1' }))
    calls.find.mockImplementation(async () => ({ vault_id: 'v1', passport_id: 'p1' }))
    pool.find.mockImplementation(() => null)
  })

  it('connects to ARI and starts the configured Stasis app on init()', async () => {
    await ari.init(makeDeps())
    expect(mockClient.start).toHaveBeenCalledWith('whitebox')
  })

  it('throws if voip.ari config is incomplete', async () => {
    const deps = makeDeps()
    deps.config.voip.ari = { url: 'x' }                       // no user / pass
    await expect(ari.init(deps)).rejects.toThrow(/voip\.ari/)
  })

  it('on StasisStart: rings the call, links phone identity, answers + records the channel', async () => {
    const deps = makeDeps()
    deps.passports.identify = vi.fn(async () => 'p1')
    await ari.init(deps)

    const channel = {
      id: 'ch-1',
      linkedid: 'L-1',
      caller: { number: '+359888001122' },
      dialplan: { exten: '+35921234567' },
      answer: vi.fn(async () => {}),
      record: vi.fn(async () => {}),
      continueInDialplan: vi.fn(async () => {}),
    }
    await mockClient.handlers.StasisStart({ args: [], type: 'StasisStart' }, channel)
    // Give the wrapped promise a tick to flush
    await new Promise(r => setImmediate(r))

    expect(calls.ring).toHaveBeenCalledWith(expect.objectContaining({
      caller: '+359888001122',
      line:   '+35921234567',
      tag:    'sofia',
    }))
    expect(deps.passports.identify).toHaveBeenCalled()
    expect(deps.passports.link).toHaveBeenCalledWith('p1', [{ type: 'phone', name: 'e164', value: '+359888001122' }])
    expect(channel.answer).toHaveBeenCalled()
    expect(channel.record).toHaveBeenCalledWith(expect.objectContaining({ format: 'wav' }))
    expect(channel.continueInDialplan).toHaveBeenCalled()
  })

  it('on ChannelStateChange to Up: marks pick + notifies', async () => {
    const deps = makeDeps()
    await ari.init(deps)

    // Set up an in-flight call by feeding a StasisStart first
    const channel = {
      id: 'ch-1', linkedid: 'L-1',
      caller: { number: '+359888001122' },
      dialplan: { exten: '+35921234567' },
      answer: vi.fn(), record: vi.fn(), continueInDialplan: vi.fn(),
    }
    await mockClient.handlers.StasisStart({ args: [], type: 'StasisStart' }, channel)
    await new Promise(r => setImmediate(r))
    calls.pick.mockClear()

    // Now Up
    const upChannel = { id: 'ch-1', state: 'Up', caller: { number: '+359888001122' } }
    await mockClient.handlers.ChannelStateChange({ type: 'ChannelStateChange' }, upChannel)
    await new Promise(r => setImmediate(r))

    expect(calls.pick).toHaveBeenCalledWith(expect.objectContaining({ vaultId: expect.any(String) }))
  })

  it('ignores ChannelStateChange for channels we don\'t know about', async () => {
    const deps = makeDeps()
    await ari.init(deps)
    await mockClient.handlers.ChannelStateChange(
      { type: 'ChannelStateChange' },
      { id: 'untracked', state: 'Up' },
    )
    expect(calls.pick).not.toHaveBeenCalled()
  })

  it('on ChannelDestroyed: marks the call ended even when recording fetch fails', async () => {
    const deps = makeDeps()
    await ari.init(deps)

    // Seed an in-flight call
    const channel = {
      id: 'ch-1', linkedid: 'L-1',
      caller: { number: '+359888001122' },
      dialplan: { exten: '+35921234567' },
      answer: vi.fn(), record: vi.fn(), continueInDialplan: vi.fn(),
    }
    await mockClient.handlers.StasisStart({ args: [], type: 'StasisStart' }, channel)
    await new Promise(r => setImmediate(r))

    // Destroy — fetch will fail because there's no PBX to talk to. That's
    // fine; the handler should still call calls.end with the no-record path.
    await mockClient.handlers.ChannelDestroyed(
      { type: 'ChannelDestroyed' },
      { id: 'ch-1' },
    )
    await new Promise(r => setImmediate(r))

    expect(calls.end).toHaveBeenCalled()
  })
})
