import { describe, it, expect } from 'vitest'
import { redact } from '../../src/awareness/pii.js'

describe('awareness.pii.redact', () => {
  it('redacts credit card numbers', () => {
    expect(redact('Card 4111111111111111 used')).toContain('[REDACTED-CC]')
    expect(redact('Card 4111-1111-1111-1111 used')).toContain('[REDACTED-CC]')
  })

  it('redacts SSN', () => {
    expect(redact('SSN: 123-45-6789')).toContain('[REDACTED-SSN]')
  })

  it('redacts IBAN', () => {
    expect(redact('Pay to GB29NWBK60161331926819')).toContain('[REDACTED-IBAN]')
  })

  it('leaves normal text alone', () => {
    expect(redact('Hello world')).toBe('Hello world')
  })

  it('returns non-string unchanged', () => {
    expect(redact(null)).toBe(null)
    expect(redact(undefined)).toBe(undefined)
    expect(redact(42)).toBe(42)
  })

  it('handles multiple redactions in one string', () => {
    const out = redact('Card 4111111111111111 and SSN 123-45-6789')
    expect(out).toContain('[REDACTED-CC]')
    expect(out).toContain('[REDACTED-SSN]')
  })
})
