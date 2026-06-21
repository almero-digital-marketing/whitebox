# 08 · Consent & privacy

Forwarding **AI-inferred** behavioral segments to third-party ad networks is the most legally sensitive
thing this plugin does. Consent, hashing, and the sensitive-category guard are **load-bearing**, not
polish.

## The gates (in order)

Every passport passes three gates before a single event is fired (`consent.js` + `delivery.js`):

```
1. suppression   — on the do-not-target list?         → drop (hard)
2. consent       — has the required consent category?  → drop unless granted
3. policy        — sensitive-category guard            → drop if a non_sensitive rule hits one
```

If any gate fails, nothing is fired and the match's `fired` map is left untouched (so it ages out of
the platforms).

## 1. Suppression

A hard do-not-target list (`whitebox_audience_suppression`). A suppressed passport is **never**
evaluated or fired for any rule, regardless of consent. Use it for opt-outs and legal holds.

```
audiences_suppress { passport_id, reason }      # MCP
POST /audiences/passports/:pid/suppress         # REST
```

## 2. Consent

Configured by `privacy.requireConsentCategory` (default `'marketing'`). The plugin **default-denies**
when a category is required and no consent source is wired — you cannot accidentally forward
un-consented users.

**Wire your consent source.** The client already has a `consent` module (`marketing` category). Persist
a per-passport flag server-side — e.g. write it at `/sessions/resolve` from the client consent state,
or expose a `consent` context provider — and implement `passports.hasConsent(passport, category)` (the
hook `consent.js` calls). Also honor GPC / DNT and a global kill-switch upstream.

## 3. Sensitive-category guard

A `non_sensitive` rule must not target inferred special-category traits (health, finance, religion,
sexuality, politics — configurable via `privacy.sensitiveCategories`). `consent.policyAllows()` blocks
a match whose reason/evidence trips a sensitive category.

> The scaffold uses a keyword stub. **For production, replace it with a classifier** — or better, have
> the AI judge return a `sensitive` flag/category in its structured output and gate on that. AI-derived
> sensitive segments are GDPR special-category data; treat the guard as mandatory.

## PII hashing

- Email/phone are **SHA-256 hashed** before they leave your server (`identity.resolve`): email
  lowercased/trimmed; phone reduced to digits (prefix the country code for true E.164).
- **Raw PII is never sent.** Networks match on hashes.
- **Awareness chunk text is PII-redacted** at ingest (`redactPii`), so match keys never come from
  content — only from passport identities. This keeps the semantic layer clean of identifiers.

## The audit trail (your "why")

Every match stores the AI's `reason` + `evidence`. `explain` / `audiences_explain_match` surfaces it:

> *"Why is passport X in this audience?"* → the concrete cross-channel evidence, the score, the consent
> state, and when/where it was fired.

This is both your trust story and your GDPR "right to explanation" answer. Keep it.

## Data minimization & retention

- Only the **hashed** identifiers + browser ad signals leave the system.
- `whitebox_audience_deliveries` is an audit log — set a retention policy.
- On erasure (a passport's right-to-be-forgotten), the core's `awareness.forget` removes content;
  also delete `audience_matches`/`identities`/`suppression` rows and stop firing (the platforms age the
  user out).

## Checklist before going live

- [ ] `privacy.requireConsentCategory` set and `passports.hasConsent` wired.
- [ ] `privacy.sensitiveCategories` reviewed; guard upgraded from the keyword stub.
- [ ] PII hashing verified (normalize before hashing).
- [ ] Suppression endpoint reachable by your support/ops flow.
- [ ] Per-network data-use / consent terms accepted (Meta, TikTok, Google).
- [ ] Retention policy on the deliveries audit log.
