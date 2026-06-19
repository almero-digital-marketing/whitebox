# 04 · Evaluator

The evaluator ([`src/evaluator.js`](../src/evaluator.js)) turns a rule + a passport into a verdict.
Its whole job is **assembling features**, then letting an LLM judge — not asking the LLM to do
everything.

## The pipeline

```
candidates(rule)                       # 1. vector-narrow: who's even near this topic?
  → for each candidate:
       metric.evaluate (SQL gates)     # 2. cheap structural gates — fail fast, no LLM
       crm.facts (if required)         # 3. required facts present? fail fast
       semantic.evidence (recall)      # 4. pull the relevant evidence
       judge(criteria, evidence, …)    # 5. LLM verdict {match, score, reason}
  → qualified if match && score ≥ threshold
```

## 1. Candidate narrowing (the cost lever)

`awareness.population({ query: seed, similarity, limit })` does an HNSW vector search and returns the
passports near the rule's seed. This turns *"N passports × M rules of LLM calls"* into *"M vector
searches + a small confirmed set of LLM calls."*

Tune in `config.audiences.evaluation`:
- `candidateSimilarity` (default `0.72`) — higher = fewer, tighter candidates.
- `candidateLimit` (default `2000`) — hard cap per rule.

## 2–3. Hard gates before the LLM

`metric` and `crm` requirements are evaluated **first**, in code, with deterministic SQL / fact
lookups. A passport that fails them is rejected **without an LLM call**. This is both a cost control
and a correctness guarantee — the LLM never has to count or verify state.

## 4. Evidence

`awareness.recall({ passport_id, query: seed, limit })` returns the most relevant chunks this passport
has been exposed to (cross-channel: web reads, voip transcripts, mail bodies), each with
`channel`, `source`, `content_id`, `similarity`, `text`, `ts`.

## 5. The judge (structured output)

The LLM gets the `criteria` + the assembled `{ evidence, metrics, facts }` and must return strict JSON:

```json
{ "match": true, "score": 0.86, "reason": "cites concrete evidence — channel + what they did" }
```

Notes:
- The scaffold uses `openai.prompt()` + JSON-parse. **For production, switch to a structured-output
  call** (AI SDK `generateObject` with a zod schema) so malformed JSON can't slip through — the parse
  fallback is portable but not bulletproof.
- The judge is told the `metrics` and `facts` are already true — *weigh, don't recompute.*
- The `reason` is stored on the match and surfaced by `explain` — it's your audit trail.

## Determinism for ad spend

AI verdicts are non-deterministic; audiences spend money. Guardrails:

- **Confidence threshold** (`rule.threshold`) — don't qualify on low confidence.
- **Stored reason** — every membership is explainable.
- **Hysteresis (recommended, v1.x):** require a margin (or N consecutive confirmations) before
  *removing* someone, so a borderline passport doesn't flap in/out of the audience each sweep. The
  keep-warm sweep is the natural place to add this.
- **Model tiering (recommended):** a cheap screen model for the bulk, escalate borderline scores
  (near the threshold) to a stronger model. The scaffold exposes `evaluation.model`; wire a second
  tier when you need it.

## Preview = the same pipeline, on a sample, firing nothing

`preview(rule, { sample })`:

```
requires availability check  (warn on missing crm facts)
candidate_pool = |candidates|
run evaluate() on the first `sample` candidates
est_matches = candidate_pool × (matched / sampled)
est_cost    = candidate_pool × per-eval cost
sample_reasons = up to 5 qualified reasons
```

`est_cost` uses a rough `$/eval` constant in `estCost()` — **set it to your real model price.** Preview
never calls delivery, so it never fires.

## Cost model, concretely

For one rule run:
```
cost ≈ candidate_pool × $/eval(screen model)
     − (passports rejected by metric/crm gates, which cost $0)
```
Lower it by: tighter `candidateSimilarity`, stronger `metric` gates, batching all rules into one LLM
call per candidate (a v1.x optimization — the prompt lists rules, returns a verdict array), and
incremental dirty-eval (only changed passports, already wired via `awareness.recorded`).
