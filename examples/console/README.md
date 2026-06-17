# Console

Ask grounded questions — about **one customer** or your **whole customer base** — and inspect the underlying memory, **with no external Claude/OpenAI client**. Every call hits the server's own `/analytics/*` routes; the server does the LLM synthesis. It's the "now query it" companion to the [integration demo](../integration).

## Run

```bash
cd examples/console
node serve.mjs            # starts/reuses whitebox-server, serves on :5373
```

`serve.mjs` reuses a running whitebox-server (or starts one), proxies `/analytics/*` same-origin, and hands the page the analytics token from `whitebox-server/.env` so you don't have to paste it (local-only; the field stays editable).

## Two tabs

The analytics **token** lives in the header (auto-filled from `.env`); pick a scope with the tabs:

- **All customers** (default tab) — grounded over your whole base (`/analytics/ask-population`). No passport. It always grounds on base-wide totals (customer count + channel/direction breakdown), so **counting** questions ("how many customers do we have?") are exact; for **targeted** questions it adds the matching semantic cohort, and for **broad/overview** questions ("what are people interested in?") it falls back to a base-wide content sample — so it answers whether or not the question maps to a cohort. Each answer shows the base size and how big a cohort matched. The **cohort size** box (`/analytics/population`) is the raw "how many customers match this concept" companion.
- **This customer** — grounded over a single passport (`/analytics/ask`). The **passport id** field lives in this tab; it pulls that customer's semantic recall + registered context (CRM state), plus raw `Timeline` / `Context` / `Recall` inspection.

Answers from both tabs accumulate in the shared log below, each badged by scope.

## Use it

1. **All customers** tab (no passport) — click a question chip to drop it into the box (it doesn't ask on its own — tweak it, then **Ask all** or Enter), or type your own; evidence rows show how many customers each chunk reached. Use the **cohort size** box (with one-click example concepts) for a raw match count.
2. To go per-customer, open the integration demo, generate some activity for a visitor, and copy its **passport id**.
3. Switch to the **This customer** tab and paste that id into its **passport** field.
4. Click a question chip to prefill the box (then **Ask** or Enter), or type your own; expand **evidence** for the cited chunks. **Inspect** the raw memory with `Timeline`, `Context (CRM state)`, and `Recall` (with one-click example queries).

The chips are written to match what the [integration demo](../integration) (Brightsmile Dental) actually records — service reads (whitening, Invisalign, implants, pricing/insurance), CRM observations (registration, appointments, treatment plans, payment plans, emergencies), clinic-call transcripts, and callback requests — so they return grounded answers rather than "nothing matched". Base-wide examples: *"What treatments are patients most interested in?"*, *"How many patients have asked about teeth whitening?"*, *"What do patients ask about when they call the clinic?"*. Per-customer examples: *"Have they accepted or viewed a treatment plan?"*, *"Did they call the clinic or request a callback?"*. Recall/cohort concept chips (*teeth whitening*, *dental implants*, *Invisalign*, *payment plans*, *emergency appointment*) appear verbatim in the demo content.

## What it is (and isn't)

This is an **ask + inspect console**, not a tool-calling agent — each question is one grounded `/analytics/ask` (single passport) or `/analytics/ask-population` (whole base) call into the server's LLM, plus direct inspection of the retrieval primitives. A true agentic loop (chaining tools across passports) would be a server-side endpoint over the same `awareness.*` functions — a natural next step.

## Notes
- **Dev tool, not a prod surface.** It queries a customer's full memory, so it's gated by the analytics bearer token. Don't expose it publicly.
- It rides the server's AI (the `ai` facade), so answers are only as available as that provider key — same as `/analytics/ask`.
