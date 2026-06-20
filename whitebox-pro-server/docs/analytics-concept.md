# The analytics concept — the composition layer (v1)

**Status:** Concept spec — decisions A1–A4 + B1–B3 settled (§10). Sits on top of
[selector.md](selector.md) (the query engine, built outside) and reuses
[temporal-facts.md](temporal-facts.md). Supersedes the earlier `analytics-dashboard`
note. No core code here — analytics is a plugin.

> **One line:** analytics is **composition** — an AI assembles **reports** (charts +
> answers) over the core query engine, the human curates, and any cohort on the board
> is one move from being an **audience**. The data and the activation are solved
> elsewhere; composition is the new surface, and it's its own plugin.

---

## 1. What it is — composition, its own plugin

Three layers, only the middle one is new:

| layer | owns | stateful? | built |
|---|---|---|---|
| core **QUERY** | resolve a selector / funnel → data; the saved-query store | no | outside |
| **analytics (composition)** | **reports · widgets · layout · the author loop · the UI** | **yes** | here |
| **audiences** | activate a people-cohort (delivery + keep-warm) | yes | plugin |

The analytics plugin is a **stateful orchestrator, not an engine.** It owns the
composition state and the UI; it **calls, never reimplements** core QUERY (chart
data), `/ask` (answers), and audiences (activation).

## 2. The unit model  *(A1)*

```
widget   →   report   →   home / library
```

- **widget** — one thing on the board: `{ query-ref, presentation, provenance }`.
- **report** — a named, ordered set of widgets answering a theme ("Onboarding health"
  = funnel + drop-off segments + trend + a narrative). The unit the AI assembles and
  the human saves.
- **home / library** — where saved reports (and named queries, §7) live.

Two real nouns: **widget** and **report**.

## 3. Widgets & presentations  *(A2)*

A widget references a **query** (the core resolves it) and renders it. The
presentation is constrained by what the query returns:

| query returns | presentation |
|---|---|
| a single value (`people` count, one metric) | **stat** |
| a metric grouped by time | **timeseries** (line / area / bar) |
| a metric by category | **breakdown** (bar / pie) |
| a funnel report | **funnel** |
| a `people` cohort or `knowledge` rows | **table** (a cohort table carries the *act* affordance, §4) |
| a question | **answer** (prose, via `/ask`) |

## 4. Three activations of a query — the view→act bridge

A saved query is the **durable spine**; the things that hang off it are thin:

```
audience = saved-query ref + delivery        — act
chart    = saved-query ref + presentation    — view (data)
answer   = saved-query ref (+question) + /ask — view (prose)
```

Saved queries are a **core primitive** (not owned by the composition plugin) so both
**widgets and audiences reference them**. Define a query once → a chart and an
audience can share it; edit it once → both move.

**So view→act is one move:** "make this chart's cohort an audience" = point an
audience at the chart's already-persisted query and attach a delivery. No
re-specifying, no special mechanism — the query is already there.

## 5. The AI-composition workflow  *(A3)*

Conversational → board:

1. **Human asks** — "how's onboarding doing?"
2. **AI plans + assembles** — runs queries (core QUERY), creates widgets, lays them
   into a *draft report*, and adds a narrative **answer** card.
3. **Human curates** — pin / edit / reorder / remove, ask a follow-up ("split by plan"
   → *mutates* the report, doesn't restart), or **act** ("target this drop-off").
4. **Save.**

Both the AI (over MCP) and the human (in the UI) edit the same report, so widgets
carry **provenance** (AI-drafted vs human-pinned) and can be **pinned/locked**. The
AI proposes; the human owns the saved board.

## 6. Fixed composition + the Review action  *(A4)*

A saved report's **composition is fixed** — the widget-set and layout don't change on
their own. Refresh splits by cost:

- **Charts** (deterministic) → **live**, socket-pushed, real-time. Always current.
- **Answers + any re-composition** (LLM) → only on the **Review** action: a button
  that re-runs the author pass — re-synthesizes the narrative and *proposes* widget
  changes the human curates (A3 again, on an existing report).

So there's no "adaptive mode" — a fixed report whose charts live-update, plus a
human-pulled **Review**. (The scheduled-Review case is v2, §9.)

## 7. Query organization  *(B1–B3)*

The mess-preventer is one distinction: **saved ≠ named.**

- **Saved** — every query is persisted and discoverable to the *system*. **Everything**
  is saved, including inline ones.
- **Named (library)** — a human-facing name in a catalog. Only some.

| # | rule |
|---|---|
| **B1** | **inline by default** — a query lives *inside* its widget/audience: persisted, private, unnamed, not in the library |
| **B2** | **library = explicit save + name only** — a query is cataloged only when you (or the AI, with your confirm) name it; nothing auto-accrues |
| **B3** | **small named library, light tags** — no folders, no where-used graph |

**Reuse never starts from the library** (so nothing needs to be pre-named):

1. **In-context** — reuse from the instance ("clone this chart," "make audience"); the
   query travels with the widget.
2. **AI dedup** — the AI searches *all persisted queries* (inline included) and reuses
   matches instead of minting near-dupes.
3. **Explicit** — name it now if you already know you'll want it by name.

Naming is the *consequence* of reuse, or a deliberate choice — never the precondition.

## 8. The composition MCP surface

The analytics-UI MCP = **composition verbs** (the agent's authoring toolkit), distinct
from core's **data verbs**:

- `create_chart({ query, presentation, title })` · `create_answer({ question, scope? })`
- `add_to_report` · `arrange` · `create_report` / `update_report`
- `review(report)` — re-run the author pass (§6)
- `save_query_to_library({ query, name, tags })` — promote (B2)
- `make_audience({ query, delivery })` — the view→act bridge (calls audiences)

Data verbs (`query` / `preview` / `ask`) come from **core**. The agent **searches
saved queries before creating** (dedup, §7).

## 9. v1 scope

**In v1:** store reports/widgets, the composition MCP, live charts, the Review button.
Single-user, no permissions.

**Out (v2):**
- **Scheduled reports** — fire `review` on a cadence (→ notify / email).
- **Shared / permissioned reports** — sharing + access control.

Both bolt on later without touching the model.

## 10. Decisions — settled

| # | decision | ✅ |
|---|---|---|
| **A1** | unit model | widget → report → home/library (two nouns) |
| **A2** | presentations | stat · timeseries · breakdown · funnel · table · answer |
| **A3** | authoring | AI proposes, human curates; widgets carry provenance + pin/lock |
| **A4** | saved-report composition | fixed; charts live; answers + re-compose via the **Review** action |
| **B1** | query scope | inline by default (persisted, private, unnamed) |
| **B2** | library | explicit save + name only (AI suggests, human confirms) |
| **B3** | organizing the named set | small library, light tags (no folders / where-used) |

## 11. Where it sits

```
core          QUERY engine + saved-query store        (data — stateless)
analytics     reports · widgets · author loop · UI     (composition — this plugin)
audiences     save a people-cohort + delivery          (activation)
```

Analytics is the **view + act** front end: the AI assembles a living board over core
QUERY, and any cohort on it is one move from an audience. It's the concrete form of
*"analytics becomes the UI"* — the composition layer, owning composition state and
nothing else.

## 12. Stack (v1)

Backend and AI **reuse the existing server stack**; only the frontend is new.

**Composition plugin (backend)** — Node · Express · Knex/Postgres (its own tables;
JSONB report/widget/query defs) · zod · Socket.IO (live) · MCP tools via `ctx`. Calls
core QUERY / `/ask` / audiences **in-process via `ctx`**, reimplements none. The AI
runtime is the existing **`ctx.ai`** facade (OpenAI today) driving a server-side
tool-use loop over the composition + query MCP verbs — no second AI provider.

**Dashboard UI (frontend, the only new piece)** — a Vite + Vue 3 SPA:

| concern | pick |
|---|---|
| app | **Vite + Vue 3 + TypeScript** (Composition API) |
| chrome · tables · forms | **PrimeVue** — incl. its **DataTable** for the `table` widget |
| dashboard canvas | **grid-layout-plus** (draggable/resizable; backs the `arrange` verb) |
| charts | **vue-echarts** — stat / timeseries / breakdown / **funnel** |
| server state | **@tanstack/vue-query** |
| ui state | **Pinia** |
| live | **socket.io-client** |

Division of labor: **PrimeVue** for chrome + tables + forms, **vue-echarts** for the
visual charts. The chat/compose box drives the server-side agent; the board updates as
the agent calls the composition verbs; charts stream live over WS.

---

**Build note:** this is the analytics **plugin** — its own state (reports/widgets/
named-queries-the-library) + the composition MCP + the live UI. It depends on core
QUERY (`/query`, `/preview`, `/ask`, saved queries) and on audiences (`make_audience`),
and reimplements neither.
