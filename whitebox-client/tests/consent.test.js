import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import whitebox from '../src/index.js'
import createConsent from '../src/consent.js'
import createEmitter from '../src/emitter.js'

describe('consent (built-in core)', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }))
  })
  afterEach(() => delete globalThis.fetch)

  describe('factory', () => {
    it('grant/has/revoke flow', () => {
      const emitter = createEmitter()
      const consent = createConsent({ emitter, required: ['analytics', 'marketing'] })

      expect(consent.has('analytics')).toBe(false)
      consent.grant('analytics')
      expect(consent.has('analytics')).toBe(true)
      consent.revoke('analytics')
      expect(consent.has('analytics')).toBe(false)
    })

    it('decided() distinguishes an explicit choice from "never asked"', () => {
      const emitter = createEmitter()
      const consent = createConsent({ emitter, required: ['analytics', 'marketing'] })

      expect(consent.decided('analytics')).toBe(false)   // never asked
      consent.grant('analytics')
      expect(consent.decided('analytics')).toBe(true)    // granted = decided
      consent.revoke('analytics')
      expect(consent.has('analytics')).toBe(false)
      expect(consent.decided('analytics')).toBe(true)    // denied is still decided
    })

    it('allGranted requires every category in `required`', () => {
      const emitter = createEmitter()
      const consent = createConsent({ emitter, required: ['analytics', 'marketing'] })

      expect(consent.allGranted()).toBe(false)
      consent.grant('analytics')
      expect(consent.allGranted()).toBe(false)
      consent.grant('marketing')
      expect(consent.allGranted()).toBe(true)
    })

    it('emits consent:granted and consent:revoked events', () => {
      const emitter = createEmitter()
      const consent = createConsent({ emitter })

      const granted = vi.fn(), revoked = vi.fn()
      emitter.on('consent:granted', granted)
      emitter.on('consent:revoked', revoked)
      consent.grant('x')
      consent.revoke('x')
      expect(granted).toHaveBeenCalledWith({ category: 'x' })
      expect(revoked).toHaveBeenCalledWith({ category: 'x' })
    })

    it('requires an emitter at construction', () => {
      expect(() => createConsent({})).toThrow(/emitter/)
    })

    it('clear() removes persisted state', () => {
      const emitter = createEmitter()
      const consent = createConsent({ emitter })
      consent.grant('analytics')
      expect(consent.has('analytics')).toBe(true)
      consent.clear()
      expect(consent.has('analytics')).toBe(false)
    })
  })

  describe('integration with whitebox()', () => {
    it('wb.consent is always present without any plugin', async () => {
      const wb = whitebox({ url: 'https://api.example.com', autoResolveSession: false })
      await wb.ready
      expect(typeof wb.consent.grant).toBe('function')
      expect(typeof wb.consent.has).toBe('function')
    })

    it('reads consent.required from the constructor options', async () => {
      const wb = whitebox({
        url: 'https://api.example.com',
        autoResolveSession: false,
        consent: { required: ['analytics', 'marketing'] },
      })
      await wb.ready
      expect(wb.consent.required).toEqual(['analytics', 'marketing'])
      expect(wb.consent.allGranted()).toBe(false)
    })

    it('exposes consent to plugins via ctx.consent during install', async () => {
      let pluginSawConsent = null
      const wb = whitebox({
        url: 'https://api.example.com',
        autoResolveSession: false,
        plugins: [{
          name: 'probe',
          install(ctx) { pluginSawConsent = ctx.consent },
        }],
      })
      await wb.ready
      expect(pluginSawConsent).toBe(wb.consent)
    })

    it('events fire on the shared emitter (wb.on() sees them)', async () => {
      const wb = whitebox({ url: 'https://api.example.com', autoResolveSession: false })
      await wb.ready
      const granted = vi.fn()
      wb.on('consent:granted', granted)
      wb.consent.grant('analytics')
      expect(granted).toHaveBeenCalledWith({ category: 'analytics' })
    })
  })
})
