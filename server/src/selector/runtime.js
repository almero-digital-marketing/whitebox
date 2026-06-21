// Shared injected runtime for the selector modules. init() captures the deps
// once; the projection modules (people, knowledge, about) read them off `rt`
// instead of threading them through every call. Same module-singleton pattern as
// before the split — just shared across files via one object reference.

export const rt = {
  db: null,
  logger: null,
  passports: null,   // reserved: scope/merge resolution as the engine grows
  awareness: null,   // the semantic memory (about → population, judge evidence → recall)
  ai: null,          // the LLM behind judge
  defaults: null,
}

export function init(deps) {
  rt.db = deps.db
  rt.passports = deps.passports
  rt.awareness = deps.awareness
  rt.ai = deps.ai
  rt.logger = deps.logger.child({ component: 'selector' })
  const cfg = deps.config?.selector ?? {}
  rt.defaults = {
    candidateSimilarity: cfg.candidateSimilarity ?? 0.72,
    candidateLimit: cfg.candidateLimit ?? 2000,
    previewSample: cfg.previewSample ?? 20,      // §9 — judge sample size for preview
    confirmCap: cfg.confirmCap ?? 5000,          // §9 — survivors above this need explicit confirm
    judgeConcurrency: cfg.judgeConcurrency ?? 6, // matches judge.evaluate's default
    judgeMsPerCall: cfg.judgeMsPerCall ?? 1200,  // coarse per-call latency for the estimate
    knowledgeLimit: cfg.knowledgeLimit ?? 20,    // §7 — evidence rows returned by the knowledge projection
    knowledgeSimilarity: cfg.knowledgeSimilarity ?? 0.3, // soft relevance floor — about *ranks* knowledge (S1)
  }
}
