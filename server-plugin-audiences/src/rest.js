// REST transport — thin routes over the service, behind the management bearer
// secret. Full reference: docs/09-api.md.

import crypto from 'node:crypto'

// Self-contained timing-safe bearer check (mirrors whitebox-pro-server/src/auth.js)
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

  // segments — chart-derived dynamic sub-queries (the atom of the audience layer)
  r('post',   '/segments/preview', async (req) => service.previewSegment(req.body?.source ?? req.body))
  r('post',   '/segments/name',    async (req) => service.nameSegment(req.body?.source ?? req.body, req.body?.context))
  r('get',    '/segments',         async () => service.listSegments())
  r('post',   '/segments',         async (req) => service.saveSegment(req.body || {}))
  r('get',    '/segments/:id',     async (req) => {
    const seg = await service.getSegment(req.params.id)
    if (!seg) { const e = new Error('segment not found'); e.status = 404; throw e }
    return seg
  })
  r('patch',  '/segments/:id',     async (req) => service.renameSegment(req.params.id, req.body?.name))
  r('delete', '/segments/:id',     async (req) => ({ deleted: await service.deleteSegment(req.params.id) }))
  r('get',    '/segments/:id/members', async (req) => service.resolveSegment(req.params.id, { limit: +req.query.limit || 5000 }))

  // audiences — boolean compositions of segments (the deliverable audience layer)
  r('post',   '/audiences/preview', async (req) => service.previewAudience(req.body?.rule ?? req.body))
  r('post',   '/audiences/name',    async (req) => service.nameAudience(req.body?.rule ?? req.body))
  // membership — which audiences this passport is in (reported to the client by activation_id)
  r('get',    '/audiences/memberships/:passportId', async (req) => service.passportAudiences(req.params.passportId))
  r('get',    '/audiences/by-activation-id/:activationId', async (req) => {
    const a = await service.getAudienceByActivationId(req.params.activationId)
    if (!a) { const e = new Error('audience not found'); e.status = 404; throw e }
    return a
  })
  r('get',    '/audiences',         async () => service.listAudiences())
  r('post',   '/audiences',         async (req) => service.saveAudience(req.body || {}))
  r('get',    '/audiences/:id',     async (req) => {
    const a = await service.getAudience(req.params.id)
    if (!a) { const e = new Error('audience not found'); e.status = 404; throw e }
    return a
  })
  r('delete', '/audiences/:id',     async (req) => ({ deleted: await service.deleteAudience(req.params.id) }))
  r('get',    '/audiences/:id/members', async (req) => service.resolveAudience(req.params.id, { limit: Math.min(+req.query.limit || 1000, 5000) }))
  r('post',   '/audiences/:id/delivery/preview', async (req) => service.previewDelivery(req.params.id))
  r('post',   '/audiences/:id/delivery', async (req) => service.setDelivery(req.params.id, { network: req.body?.network, enabled: !!req.body?.enabled }))
  r('post',   '/audiences/:id/client-side', async (req) => service.setClientSide(req.params.id, !!req.body?.enabled))
  r('post',   '/audiences/:id/campaigns', async (req) => service.setCampaigns(req.params.id, !!req.body?.enabled))

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
