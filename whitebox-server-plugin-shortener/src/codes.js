// Unguessable short codes + opaque claim tokens. Both are random base62 from
// crypto — codes are short (they're public and typed); claim tokens are long
// (they're bearer tickets, never seen by a human).

import { randomBytes } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function base62(nBytes) {
  const buf = randomBytes(nBytes)
  let out = ''
  for (const byte of buf) out += ALPHABET[byte % 62]
  return out
}

export const newCode = (len = 8) => base62(len)
export const newClaimToken = () => base62(40)
