// Silence one specific, benign deprecation we can't fix at the source: DEP0040,
// the legacy `punycode` builtin. It's emitted by tough-cookie@2, pulled in
// transitively by the optional ARI client (ari-client → request → tough-cookie) —
// all long-deprecated and unbumpable. We drop ONLY DEP0040 and pass every other
// warning through untouched, so genuine deprecations still surface.
//
// Imported first in server.js so the patch is in place before any plugin loads.

const original = process.emitWarning.bind(process)

process.emitWarning = function emitWarning(warning, ...args) {
  const opts = args[0] && typeof args[0] === 'object' ? args[0] : null
  const code = opts ? opts.code : args[1]            // emitWarning(msg, opts) | emitWarning(msg, type, code)
  const text = typeof warning === 'string' ? warning : warning?.message
  if (code === 'DEP0040' || /\bpunycode\b/i.test(text || '')) return
  return original(warning, ...args)
}
