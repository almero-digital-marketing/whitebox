// Consistent pagination for the REST API. Every collection endpoint parses
// `limit` + `offset` the same way (with a per-endpoint cap) and returns the same
// envelope: { data, limit, offset, has_more } (+ `total` when it's cheap to know).
//
// Two ways to build the envelope:
//   • page(rows, p)      — pass limit+1 rows fetched from the DB; the extra row
//                          signals has_more without a separate COUNT query.
//   • pageSlice(all, p)  — when you already hold the full set in memory and its
//                          total (e.g. population's distinct-passport list).

// Parse from a plain object: req.query for GET, req.body for POST.
export function parsePage(source = {}, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const rawLimit = Number(source.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), maxLimit) : defaultLimit
  const rawOffset = Number(source.offset)
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
  return { limit, offset }
}

// Build the envelope from a DB fetch of limit+1 rows.
export function page(rows, { limit, offset }) {
  const has_more = rows.length > limit
  return { data: has_more ? rows.slice(0, limit) : rows, limit, offset, has_more }
}

// Build the envelope from a full in-memory set whose total size is known.
export function pageSlice(all, { limit, offset, total = all.length }) {
  return { data: all.slice(offset, offset + limit), limit, offset, total, has_more: offset + limit < total }
}
