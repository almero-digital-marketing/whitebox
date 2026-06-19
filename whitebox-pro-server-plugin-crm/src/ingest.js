// CRM ingest. Two independent pipelines, one shared identity gate.
//
//   ingestRecords({ source, customer, records[] })
//     → upserts (source, kind, external_id) into whitebox_crm_records
//     → returns { passport_id, passport_created, records: { accepted, dropped } }
//
//   ingestFacts({ source, customer, facts[] })
//     → feeds each fact to awareness as channel='crm', direction='observation'
//       with stable content_id = ${source}:fact:${kind}:${id}
//     → returns { passport_id, passport_created, facts:   { accepted, dropped } }
//
//   resolvePassport({ source, ...customer })
//     Shared identity gate. Returns { passportId, created } or null when
//     the customer block has no usable identity (no email / parseable
//     phone / external_id). Both ingest functions drop with reason
//     'no_identity' in that case.
//
// Identity resolution:
//   1. If any identity already belongs to a passport → reuse it; backfill
//      any missing identities onto it via passports.link().
//   2. No match but at least one identity provided → mint a new passport
//      and link every identity the CRM gave us.
//   3. No usable identity at all → drop the entire request.

import { parsePhoneNumber } from 'libphonenumber-js'

import * as records from './records.js'

function normalizePhone(raw, defaultCountry = 'US') {
  try {
    const pn = parsePhoneNumber(String(raw).trim(), defaultCountry)
    return pn?.isPossible?.() ? pn.format('E.164') : null
  } catch { return null }
}

function buildClaims({ source, email, phone, country, external_id }) {
  const claims = []
  if (email) claims.push({ type: 'email', name: 'address', value: String(email).toLowerCase() })
  const phoneE164 = phone ? normalizePhone(phone, country) : null
  if (phoneE164) claims.push({ type: 'phone', name: 'e164', value: phoneE164 })
  if (external_id && source) {
    claims.push({ type: 'user', name: source, value: `${source}:${external_id}` })
  }
  return claims
}

// Dependencies captured once via init() — module-level singletons. `records`
// is another converted module, imported directly above; only non-module
// values (passports, awareness, logger) come through init.
let passports, awareness, logger

export function init(deps) {
  passports = deps.passports
  awareness = deps.awareness
  logger = deps.logger
}

export async function resolvePassport(customer = {}) {
  const claims = buildClaims(customer)
  if (!claims.length) return null

  for (const c of claims) {
    const existing = await passports.findByIdentity(c.type, c.value)
    if (existing) {
      await passports.link(existing.id, claims).catch(err =>
        logger.warn({ err }, 'CRM: failed to backfill identities on existing passport'))
      return { passportId: existing.id, created: false }
    }
  }

  const passportId = await passports.identify(null)
  await passports.link(passportId, claims).catch(err =>
    logger.warn({ err, passportId }, 'CRM: failed to link identities on new passport'))
  return { passportId, created: true }
}

export async function ingestRecords({ source, customer, records: incoming = [] }) {
  if (!source) throw new Error('source is required')
  if (!Array.isArray(incoming) || !incoming.length) {
    return { reason: 'empty_payload', records: { accepted: 0, dropped: 0 } }
  }

  const resolved = await resolvePassport({ source, ...customer })
  if (!resolved) {
    logger.info({ source }, 'CRM records dropped — no identity information')
    return { reason: 'no_identity', records: { accepted: 0, dropped: incoming.length } }
  }
  const { passportId, created } = resolved

  let accepted = 0
  for (const r of incoming) {
    try {
      await records.upsert({
        source,
        kind: r.kind,
        external_id: String(r.external_id),
        passport_id: passportId,
        status: r.status ?? null,
        starts_at: r.starts_at ? new Date(r.starts_at) : null,
        data: r.data ?? {},
      })
      accepted++
    } catch (err) {
      logger.error({ err, record: { kind: r.kind, external_id: r.external_id } },
        'Failed to upsert CRM record')
    }
  }

  return {
    passport_id: passportId,
    passport_created: created,
    records: { accepted, dropped: incoming.length - accepted },
  }
}

export async function ingestFacts({ source, customer, facts: incoming = [] }) {
  if (!source) throw new Error('source is required')
  if (!Array.isArray(incoming) || !incoming.length) {
    return { reason: 'empty_payload', facts: { accepted: 0, dropped: 0 } }
  }

  const resolved = await resolvePassport({ source, ...customer })
  if (!resolved) {
    logger.info({ source }, 'CRM facts dropped — no identity information')
    return { reason: 'no_identity', facts: { accepted: 0, dropped: incoming.length } }
  }
  const { passportId, created } = resolved

  let accepted = 0
  for (const f of incoming) {
    if (!f?.body) continue
    const meta = { kind: f.kind }
    if (f.ref) {
      meta.ref = { kind: f.ref.kind, external_id: String(f.ref.external_id) }
      // Resolve ref to a stored record id when possible. One indexed lookup
      // against unique(source, kind, external_id). If the referenced record
      // doesn't exist yet (fact pushed before its record), record_id is
      // simply absent and ref still carries the external identity for
      // future joins.
      try {
        const row = await records.find({
          source,
          kind: f.ref.kind,
          external_id: String(f.ref.external_id),
        })
        if (row) meta.record_id = row.id
      } catch (err) {
        logger.warn({ err, ref: f.ref }, 'CRM: failed to resolve fact ref to record_id')
      }
    }
    try {
      await awareness.record({
        passport_id: passportId,
        session_id: null,
        ts: f.ts ? new Date(f.ts) : new Date(),
        channel: 'crm',
        direction: 'observation',
        source,
        content_id: `${source}:fact:${f.kind}:${f.id}`,
        text: f.body,
        meta,
      })
      accepted++
    } catch (err) {
      logger.warn({ err, fact: { id: f.id, kind: f.kind } },
        'awareness.record failed for CRM fact')
    }
  }

  return {
    passport_id: passportId,
    passport_created: created,
    facts: { accepted, dropped: incoming.length - accepted },
  }
}

// Client-reported observations (browser SDK via whitebox-pro-client-plugin-crm).
// The passport is ALREADY known — from the authenticated socket connection or
// an explicit passport_id — so there's no customer/identity block to resolve.
// These are LOW-TRUST: things the client app witnessed in the UI, not
// authoritative state. Recorded as awareness observations tagged source='client'
// so downstream (ask, audiences) can weigh them as self-reported. Authoritative
// state must still come through ingestRecords (the bearer-authed webhook).
export async function ingestObservations({ passport_id, source = 'client', observations = [] }) {
  if (!passport_id) {
    return { reason: 'no_identity', observations: { accepted: 0, dropped: observations.length } }
  }
  if (!Array.isArray(observations) || !observations.length) {
    return { passport_id, observations: { accepted: 0, dropped: 0 } }
  }

  let accepted = 0
  for (const o of observations) {
    if (!o?.body) continue
    try {
      await awareness.record({
        passport_id,
        session_id: null,
        ts: o.ts ? new Date(o.ts) : new Date(),
        channel: 'crm',
        direction: 'observation',
        source,
        content_id: `${source}:obs:${o.kind}:${o.id}`,
        text: o.body,
        meta: { kind: o.kind, client: true, ...(o.meta || {}) },
      })
      accepted++
    } catch (err) {
      logger.warn({ err, obs: { id: o.id, kind: o.kind } },
        'awareness.record failed for client observation')
    }
  }

  return { passport_id, observations: { accepted, dropped: observations.length - accepted } }
}
