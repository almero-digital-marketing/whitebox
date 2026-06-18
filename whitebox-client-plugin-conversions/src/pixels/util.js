// Shared helpers for the pixel mappers.

export const removeUndefined = obj => {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v
  }
  return out
}

// Normalise the canonical payload's product references into a single item list.
// Accepts `contents: [{ id, quantity, price }]` or `content_ids: [id]`.
export const toItems = p => {
  if (p.contents?.length) return p.contents
  if (p.content_ids?.length) return p.content_ids.map(id => ({ id }))
  return undefined
}
