import { describe, it, expect, vi } from 'vitest'
import createAuth, { bearer, resolveMcpAuth } from '../src/auth.js'

function call(mw, authHeader) {
  const req = { headers: authHeader ? { authorization: authHeader } : {}, get(n) { return this.headers[n.toLowerCase()] } }
  const res = { statusCode: 200, body: null, status(s) { this.statusCode = s; return this }, json(b) { this.body = b; return this } }
  const next = vi.fn()
  mw(req, res, next)
  return { res, next }
}

describe('bearer (static secret)', () => {
  it('passes a matching secret and rejects others', () => {
    const mw = createAuth({ secret: 's3cret', logger: {} })
    expect(call(mw, 'Bearer s3cret').next).toHaveBeenCalled()
    expect(call(mw, 'Bearer nope').res.statusCode).toBe(401)
    expect(call(mw, undefined).res.statusCode).toBe(401)
  })
})

describe('resolveMcpAuth', () => {
  it('string → bearer verifier', () => {
    const v = resolveMcpAuth('tok', {})
    expect(typeof v.middleware).toBe('function')
    expect(call(v.middleware, 'Bearer tok').next).toHaveBeenCalled()
  })

  it('{ secret } (legacy) → bearer verifier', () => {
    const v = resolveMcpAuth({ secret: 'tok' }, {})
    expect(call(v.middleware, 'Bearer tok').next).toHaveBeenCalled()
  })

  it('a composed verifier passes through unchanged', () => {
    const verifier = { middleware: () => {}, authorizationServers: ['https://x/'], scopesSupported: ['mcp:use'] }
    expect(resolveMcpAuth(verifier, {})).toBe(verifier)
  })

  it('a bare middleware fn → wrapped', () => {
    const fn = () => {}
    expect(resolveMcpAuth(fn, {}).middleware).toBe(fn)
  })

  it('null / empty → no auth', () => {
    expect(resolveMcpAuth(null, {})).toBeNull()
    expect(resolveMcpAuth(undefined, {})).toBeNull()
    expect(resolveMcpAuth({}, {})).toBeNull()
  })

  it('bearer() helper returns a verifier', () => {
    const v = bearer({ secret: 'x' })
    expect(typeof v.middleware).toBe('function')
  })
})
