import { describe, it, expect, beforeEach } from 'vitest'
import createIdentity from '../src/identity.js'

describe('identity', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('persists passportId to localStorage', () => {
    const id = createIdentity()
    id.setPassportId('abc')
    expect(id.getPassportId()).toBe('abc')
    expect(localStorage.getItem('wb:passport_id')).toBe('abc')
  })

  it('persists sessionId to sessionStorage (coerced to string)', () => {
    const id = createIdentity()
    id.setSessionId(42)
    expect(id.getSessionId()).toBe('42')
    expect(sessionStorage.getItem('wb:session_id')).toBe('42')
  })

  it('clear() removes both passport and session', () => {
    const id = createIdentity()
    id.setPassportId('abc')
    id.setSessionId(1)
    id.clear()
    expect(id.getPassportId()).toBeNull()
    expect(id.getSessionId()).toBeNull()
  })

  it('clear() does NOT touch consent (separate concern)', () => {
    const id = createIdentity()
    id.setPassportId('abc')
    localStorage.setItem('wb:consent', JSON.stringify({ analytics: true }))
    id.clear()
    expect(localStorage.getItem('wb:consent')).toBe(JSON.stringify({ analytics: true }))
  })

  it('returns null for missing values', () => {
    const id = createIdentity()
    expect(id.getPassportId()).toBeNull()
    expect(id.getSessionId()).toBeNull()
  })
})
