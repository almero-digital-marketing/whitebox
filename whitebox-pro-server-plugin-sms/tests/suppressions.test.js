import { describe, it, expect } from 'vitest'
import * as suppressions from '../src/suppressions.js'

// Minimal in-memory db supporting the chains suppressions uses.
function makeDb() {
  const rows = []
  const db = () => ({
    where: (cond) => ({
      first: async () => rows.find(r => r.phone === cond.phone) || null,
      del: async () => { const i = rows.findIndex(r => r.phone === cond.phone); if (i >= 0) { rows.splice(i, 1); return 1 } return 0 },
    }),
    whereIn: (col, vals) => ({ select: async () => rows.filter(r => vals.includes(r[col])).map(r => ({ phone: r.phone })) }),
    insert: (row) => ({ onConflict: () => ({ merge: () => ({ returning: async () => { rows.push(row); return [row] } }) }) }),
  })
  db._rows = rows
  return db
}

describe('suppressions phone normalization (defaultCountry)', () => {
  it('stores + matches a national number via the default country', async () => {
    const db = makeDb()
    suppressions.init({ db, logger: { error: () => {} }, defaultCountry: 'BG' })

    const row = await suppressions.add({ phone: '0888999000', reason: 'unsubscribed' })
    expect(row.phone).toBe('+359888999000')

    expect(await suppressions.check('0888999000')).toMatchObject({ phone: '+359888999000' })   // national lookup
    expect(await suppressions.check('+359888999000')).toMatchObject({ phone: '+359888999000' }) // E.164 lookup
    const set = await suppressions.checkMany(['0888999000', '+15550001111'])
    expect(set.has('+359888999000')).toBe(true)
  })

  it('rejects an unparseable number', async () => {
    suppressions.init({ db: makeDb(), logger: { error: () => {} }, defaultCountry: 'BG' })
    expect(await suppressions.add({ phone: 'nope' })).toBe(null)
  })
})
