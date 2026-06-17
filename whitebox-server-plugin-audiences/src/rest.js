// REST transport — thin routes over the service, behind the management bearer
// secret. Full reference: docs/09-api.md.

import crypto from 'node:crypto'

// Self-contained timing-safe bearer check (mirrors whitebox-server/src/auth.js)
// so the plugin has no internal-import dependency on the host.
function bearer(secret) {
  const expected = Buffer.from(secret, 'utf8')
  return (req, res, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')
    const got = m && Buffer.from(m[1], 'utf8')
    if (!got || got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
  }
}

export function register(app, { service, secret, logger }) {
  const auth = secret ? bearer(secret) : (req, res, next) => next()
  if (!secret) logger?.warn?.('audiences: REST management API has NO auth secret — set audiences.auth.secret')

  const r = (method, path, fn) => app[method](`/audiences${path}`, auth, wrap(fn))

  // rules
  r('get',    '/rules',          async (req) => service.listRules())
  r('post',   '/rules',          async (req) => service.saveRule(req.body, req.get('x-actor')))
  r('get',    '/rules/:id',      async (req) => service.getRule(req.params.id))
  r('patch',  '/rules/:id',      async (req) => service.saveRule({ ...(await service.getRule(req.params.id)), ...req.body, id: req.params.id }, req.get('x-actor')))
  r('delete', '/rules/:id',      async (req) => ({ deleted: await service.deleteRule(req.params.id) }))
  r('post',   '/rules/:id/preview',  async (req) => service.preview(req.params.id, { sample: req.body?.sample }))
  r('post',   '/rules/:id/evaluate', async (req) => service.evaluateRule(req.params.id, { dryRun: req.body?.dryRun !== false }))
  r('get',    '/rules/:id/members',  async (req) => service.members(req.params.id, { limit: +req.query.limit || 50, offset: +req.query.offset || 0 }))
  r('get',    '/rules/:id/stats',    async (req) => service.stats(req.params.id))

  // passports
  r('get',    '/passports/:pid/segments', async (req) => service.passportSegments(req.params.pid))
  r('post',   '/passports/:pid/evaluate', async (req) => service.evaluatePassport(req.params.pid))
  r('post',   '/passports/:pid/suppress', async (req) => ({ ok: await service.suppress(req.params.pid, req.body?.reason) }))
  r('delete', '/passports/:pid/suppress', async (req) => ({ ok: await service.unsuppress(req.params.pid) }))

  // networks / discovery
  r('get',    '/networks',                 async () => service.networks())
  r('get',    '/networks/:net/identity-manifest', async () => service.manifest())
  r('get',    '/facts',                    async () => service.availableFacts())

  // audit / suppression
  r('get',    '/deliveries',  async (req) => service.deliveries({ ruleId: req.query.rule, network: req.query.network, status: req.query.status, limit: +req.query.limit || 50 }))
  r('get',    '/suppression', async () => service.listSuppression())

  // drafting
  r('post',   '/draft', async (req) => service.draft(req.body?.description || ''))
}

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req)) }
  catch (err) { res.status(err.status || 500).json({ error: err.message }) }
}
