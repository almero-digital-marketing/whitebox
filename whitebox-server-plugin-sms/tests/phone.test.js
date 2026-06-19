import { describe, it, expect } from 'vitest'
import { toE164, callingCode } from '../src/phone.js'

describe('toE164', () => {
  it('normalizes a national number with the default country', () => {
    expect(toE164('0888123456', 'BG')).toBe('+359888123456')
  })
  it('keeps an already-E.164 number', () => {
    expect(toE164('+15551234567')).toBe('+15551234567')
  })
  it('returns null for junk or empty', () => {
    expect(toE164('not-a-phone')).toBe(null)
    expect(toE164('')).toBe(null)
    expect(toE164(null)).toBe(null)
  })
})

describe('callingCode', () => {
  it('extracts the E.164 calling code', () => {
    expect(callingCode('+359888123456')).toBe('+359')
    expect(callingCode('+15551234567')).toBe('+1')
  })
  it('returns null for non-E.164 input', () => {
    expect(callingCode('0888')).toBe(null)
  })
})
