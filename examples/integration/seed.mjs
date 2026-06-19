#!/usr/bin/env node
// Seed a synthetic multi-customer base for the integration demo, so the
// console's "All customers" / cohort / population questions return real
// aggregates (one browser session only ever produces ONE passport).
//
// It drives the SAME ingress the browser client uses — nothing special:
//   • POST /sessions/resolve          → mint a passport (+ UTM attribution)
//   • POST /engagement/events         → reading exposures (web)
//   • POST /crm/observe               → product observations (crm)
//   • socket voip.pick → /voip/calls  → an attributed sales-call transcript
// Everything funnels into the one awareness store and is embedded by the
// RUNNING server, so semantic recall/population actually matches.
//
//   Run (with the demo or whitebox-pro-server up on :3000):
//     node examples/integration/seed.mjs              # ~30 customers
//     COUNT=60 node examples/integration/seed.mjs
//     WB_SERVER=http://localhost:3000 node examples/integration/seed.mjs
//
// Then open the console and ask the "All customers" questions.

import { io } from 'socket.io-client'

const SERVER = (process.env.WB_SERVER || 'http://localhost:3000').replace(/\/$/, '')
const COUNT = Number(process.env.COUNT || 30)

// ── content pools — mirror the integration marketing page + CRM kinds, so the
// seeded base speaks the same vocabulary the console chips ask about. Reusing
// the exact paragraph text means identical reads dedupe to one shared chunk
// (one embedding) carrying a real "seen by N customers" reach count. ──────────
const READS = {
  welcome: [
    ['hero', 'Gentle, modern dentistry for the whole family.'],
    ['why-2', 'Costs are clear before we start: we accept most dental insurance, file the claim for you, and offer interest-free monthly payment plans, with a written estimate and no surprise bills.'],
  ],
  cosmetic: [
    ['cos-1', 'Professional teeth whitening lifts years of coffee and wine staining in about an hour, with take-home trays to keep it bright.'],
    ['cos-2', 'Porcelain veneers and composite bonding reshape chipped, gapped, or worn teeth in a couple of visits — ask about a free smile-makeover consultation.'],
  ],
  ortho: [
    ['ortho-1', 'Invisalign clear aligners straighten teeth without metal — removable for meals and nearly invisible, with most cases finishing in 6 to 18 months. The first consultation is free.'],
    ['ortho-2', 'For teens and complex bites, traditional and ceramic braces remain the most predictable option, with monthly payment plans on every case.'],
  ],
  implants: [
    ['imp-1', 'Dental implants replace a missing tooth with a titanium post and a natural-looking crown, placed in-house with a full treatment plan and financing up front.'],
    ['imp-2', 'Same-day crowns are milled and fitted in one visit, and root canal therapy saves a badly damaged tooth comfortably under local anaesthetic.'],
  ],
}
const CRM = {
  newpatient: [['new_patient_registered', 'Completed new-patient registration'], ['appointment_booked', 'Booked a checkup and cleaning'], ['insurance_added', 'Added dental insurance details']],
  cosmetic:   [['whitening_interest', 'Asked about teeth whitening'], ['treatment_plan_viewed', 'Viewed the cosmetic treatment plan']],
  ortho:      [['treatment_plan_viewed', 'Viewed the Invisalign treatment plan'], ['treatment_accepted', 'Accepted the Invisalign treatment plan']],
  implants:   [['treatment_plan_viewed', 'Viewed the dental implant treatment plan'], ['payment_plan_selected', 'Chose a monthly payment plan']],
  emergency:  [['emergency_request', 'Requested an emergency appointment for tooth pain']],
}
const CALLS = {
  whitening: 'Patient: I saw your whitening offer — how much is it and how long does it take?\nReceptionist: Professional whitening is about an hour, we file most insurance, and there are monthly payment plans.',
  ortho:     'Patient: My daughter needs her teeth straightened — do you do Invisalign for teens?\nReceptionist: Yes, clear aligners and braces both; the first orthodontic consultation is free.',
  implant:   'Patient: I lost a back tooth and want to ask about a dental implant and the cost.\nReceptionist: We place implants in-house; I can book a consult and we will quote a full plan with financing.',
  emergency: 'Patient: I have severe tooth pain since last night — can I be seen today?\nReceptionist: Yes, we keep same-day emergency slots; can you come in this afternoon?',
}
const CALLBACKS = [
  'Interested in teeth whitening before my wedding',
  'Need a quote for a dental implant and payment options',
  'Asking about Invisalign for my teenager',
  'In pain — need an emergency appointment as soon as possible',
]

// persona → which reads/crm/call themes, callback likelihood, and attribution.
const PERSONAS = [
  { name: 'whitening-cosmetic',  reads: ['cosmetic'], crm: ['newpatient', 'cosmetic'], call: 'whitening', callbackP: 0.4, utm: { utm_source: 'google',    utm_medium: 'cpc',      utm_campaign: 'teeth-whitening' } },
  { name: 'invisalign-ortho',    reads: ['ortho'],    crm: ['ortho'],                  call: 'ortho',     callbackP: 0.5, utm: { utm_source: 'instagram', utm_medium: 'social',   utm_campaign: 'invisalign' } },
  { name: 'implant-restorative', reads: ['implants'], crm: ['implants'],               call: 'implant',   callbackP: 0.4, utm: { utm_source: 'referral',  utm_medium: 'referral', utm_campaign: '' } },
  { name: 'new-patient-checkup', reads: [],           crm: ['newpatient'],             call: null,        callbackP: 0.1, utm: { utm_source: 'newsletter', utm_medium: 'email',   utm_campaign: 'recall-reminder' } },
  { name: 'emergency-pain',      reads: [],           crm: ['emergency'],              call: 'emergency', callbackP: 0.3, utm: { utm_source: 'google',    utm_medium: 'cpc',      utm_campaign: 'emergency-dentist' } },
]

const rnd = () => Math.random()
const pick = (a) => a[Math.floor(rnd() * a.length)]
const chance = (p) => rnd() < p

async function postJson(path, body, query = '') {
  const res = await fetch(`${SERVER}${path}${query}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return res
}

async function resolvePassport(utms) {
  const res = await postJson('/sessions/resolve', { passport_id: null, utms })
  if (!res.ok) throw new Error(`/sessions/resolve → ${res.status}`)
  return res.json() // { passportId, sessionId }
}

async function sendReads(passportId, sessionId, reads) {
  const events = reads.map(([id, text]) => ({
    type: 'engagement.text', id, text,
    ms_spent: 1500 + Math.floor(rnd() * 6000), length_chars: text.length,
  }))
  await postJson('/engagement/events', { events }, `?passport_id=${passportId}&session_id=${sessionId ?? ''}`)
}

async function sendObservations(passportId, obs) {
  const observations = obs.map(([kind, body], i) => ({ id: `seed-${kind}-${i}`, kind, body }))
  await postJson('/crm/observe', { passport_id: passportId, observations })
}

// voip needs a number assigned to a live connection; pick one over a short-lived
// socket (passport in the handshake → attribution), then POST the transcript.
async function makeCall(passportId, utms, transcription) {
  const socket = io(SERVER, { query: { passport: passportId, ...utms }, transports: ['websocket'], forceNew: true, timeout: 4000 })
  try {
    const number = await new Promise((resolve, reject) => {
      // The server registers the visitor in the voip pool only after an async
      // session resolve, which can land after our pick — so re-pick on a short
      // interval until a number comes back (or we give up).
      let timer
      const t = setTimeout(() => { clearInterval(timer); reject(new Error('voip.number timeout')) }, 5000)
      const pick = () => socket.emit('voip.pick', { tag: 'demo' })
      socket.on('connect', () => { pick(); timer = setInterval(pick, 500) })
      socket.on('voip.number', (d) => { clearTimeout(t); clearInterval(timer); resolve(d?.number) })
      socket.on('connect_error', (e) => { clearTimeout(t); clearInterval(timer); reject(e) })
    })
    if (!number) throw new Error('no number assigned')
    await postJson('/voip/calls', { number, caller: '+15551234567', transcription, duration: 60 + Math.floor(rnd() * 120) })
    return true
  } finally {
    socket.close()
  }
}

async function seedCustomer(i) {
  const persona = pick(PERSONAS)
  const { passportId, sessionId } = await resolvePassport(persona.utm)

  // everyone reads the welcome/pricing copy; persona adds its service themes
  const reads = [...READS.welcome, ...persona.reads.flatMap(t => READS[t])]
  await sendReads(passportId, sessionId, reads)

  const obs = persona.crm.flatMap(g => CRM[g])
  if (chance(persona.callbackP)) obs.push(['callback_request', `Requested a callback: ${pick(CALLBACKS)}`])
  await sendObservations(passportId, obs)

  let called = false
  if (persona.call) {
    try { called = await makeCall(passportId, persona.utm, CALLS[persona.call]) }
    catch (err) { if (i === 0) console.warn(`  (voip skipped: ${err.message})`) }
  }
  return { persona: persona.name, passportId, reads: reads.length, obs: obs.length, called }
}

async function main() {
  // fail friendly if nothing is listening
  try {
    const h = await fetch(`${SERVER}/health`).catch(() => null)
    if (!h || !h.ok) throw new Error('no /health')
  } catch {
    console.error(`Cannot reach whitebox-pro-server at ${SERVER}. Start the demo (node serve.mjs) or set WB_SERVER.`)
    process.exit(1)
  }

  console.log(`Seeding ${COUNT} synthetic customers → ${SERVER}\n`)
  const byPersona = {}
  let calls = 0, callbacks = 0
  for (let i = 0; i < COUNT; i++) {
    try {
      const r = await seedCustomer(i)
      byPersona[r.persona] = (byPersona[r.persona] || 0) + 1
      if (r.called) calls++
      process.stdout.write(r.called ? '☎' : '·')
    } catch (err) {
      process.stdout.write('x')
      if (i === 0) console.warn(`\n  first customer failed: ${err.message}`)
    }
  }

  console.log('\n\nDone. Personas:')
  for (const [name, n] of Object.entries(byPersona)) console.log(`  ${name.padEnd(20)} ${n}`)
  console.log(`  sales calls           ${calls}`)
  console.log('\nEmbeddings are generated in the background — give it a few seconds, then open')
  console.log('the console\'s "All customers" tab and ask, e.g., "What services are patients most')
  console.log('interested in?" or run a cohort on "teeth whitening" / "dental implants".')
}

main()
