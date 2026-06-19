import { describe, it, expect } from 'vitest'
import { createRouter } from '../src/router.js'

const P = (name) => ({ name, send: () => {} })

describe('createRouter', () => {
  it('throws without a default provider', () => {
    expect(() => createRouter({ routes: { '+359': P('mobica') } })).toThrow(/default provider/)
  })

  it('routes by longest matching prefix, falling back to the default', () => {
    const r = createRouter({ provider: P('twilio'), routes: { '+359': P('mobica'), '+3592': P('varna') } })
    expect(r.forNumber('+15551234567').name).toBe('twilio')   // no match → default
    expect(r.forNumber('+359888123456').name).toBe('mobica')  // +359
    expect(r.forNumber('+35921234567').name).toBe('varna')    // +3592 is longer than +359
  })

  it('normalizes prefixes lacking a leading +', () => {
    const r = createRouter({ provider: P('tw'), routes: { '359': P('mo') } })
    expect(r.forNumber('+359888').name).toBe('mo')
  })

  it('byName + names expose the provider registry', () => {
    const r = createRouter({ provider: P('twilio'), routes: { '+359': P('mobica') } })
    expect(r.byName('mobica').name).toBe('mobica')
    expect(r.byName('nope')).toBe(null)
    expect(r.names().sort()).toEqual(['mobica', 'twilio'])
  })
})
