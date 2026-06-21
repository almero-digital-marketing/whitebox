<p align="center">
  <img src="whitebox.svg" alt="WhiteBox" width="320" />
</p>

<p align="center"><strong>The AI-native marketing data brain.</strong></p>

# WhiteBox

WhiteBox builds **one living memory of every customer** — everything they read on your
site, every email they opened, every call they had, every text, plus their current state
in your CRM — all tied to a single person. Then it lets you **ask plain‑language questions
about your customers and turn the answers into audiences and action.**

No more stitching together a pixel that sees one session, an email tool that sees opens,
a call log that sees calls, and a CRM that sees deals. WhiteBox keeps the whole picture of
each person in one place, and makes it answerable.

> You target on **understanding** — and every person an answer surfaces comes with a
> plain, human‑readable *"why."* Nothing is a black‑box guess.

---

## What you can ask

Ask in plain language. A few examples of what WhiteBox can answer:

**🧑 Understand one customer**
- *"What does this customer care about? Have they raised any concerns?"*
- *"Brief me on this account before the call — what have we talked about?"*

**🎯 Find the right people (and turn them into an audience)**
- *"Who's at risk of churning?"*
- *"Which Pro customers have been reading about competitors?"*
- *"Everyone who visited pricing twice in the last 30 days but hasn't bought."*
- *"Who downgraded their plan after a support call?"*

**📉 Spot where people drop off**
- *"Who started a trial and activated, but didn't purchase within 14 days?"*
- *"Who's stuck halfway through onboarding right now?"*

**📈 See the big picture**
- *"What are customers asking about most this month?"*
- *"Purchases per week."*  ·  *"Engagement by channel."*  ·  *"How many people heard about the new feature?"*

---

## What you do with the answers

- **Get a grounded answer.** A plain‑language summary you can drop into a dashboard or a
  *"brief me on this customer"* button — citing the actual email, call or page it came
  from, never an invented guess.
- **Build an audience.** Turn any of those questions into a living segment and push it to
  **Meta, TikTok or Google** to retarget. It **keeps itself warm**: as people qualify they
  join, and a win‑back audience *empties itself* as they convert.
- **Let your AI assistant do it.** Everything is reachable by an AI agent (over MCP), so an
  assistant can pull a customer's history, answer, and act — all on the same memory.

---

## Where the data comes from

Switch on the channels you use; each one quietly feeds the same per‑customer memory:

| | channel | what it remembers |
|---|---|---|
| 🌐 | **Web** | what each visitor actually read, watched and engaged with — not just page views |
| ✉️ | **Email** | sends, opens, clicks and replies (transactional + bulk) |
| 💬 | **SMS** | sends, replies, opt‑outs |
| 📞 | **Voice** | inbound calls matched back to the visitor, recorded and transcribed |
| 🗂️ | **CRM** | subscriptions, deals, plan, status — the structured state from whatever systems you already run |

Everyone is **one identity**: an email, a phone number, a login and a web visit all merge
into a single customer, so a call, a click and a reply belong to the same person.

---

## Want the details?

**Operators & marketers:** start with the **[documentation](docs/)** —
[overview](docs/01-overview.md) · [core ideas](docs/02-concepts.md) ·
[getting started](docs/03-getting-started.md) ·
[asking & querying](docs/05-awareness-and-querying.md) ·
[channels](docs/07-channels.md).

**Developers:** WhiteBox is a focused backend you reach over **HTTP or MCP** — it owns
customer touchpoints and the memory of them; your app stays separate and never imports its
internals. It's an npm‑workspaces monorepo (Node · Express · Postgres + pgvector); each
channel is its own plug‑in package.

<details>
<summary><strong>Packages & connectors</strong></summary>

### Server · Node.js · Express · BullMQ · Postgres + pgvector

| package | what it does |
|---|---|
| [`whitebox-pro-server`](whitebox-pro-server) | Core: HTTP server, the two customer memories (semantic + structured), the query engine, identity, sessions, MCP, plugin loader |
| [`whitebox-pro-server-plugin-mail`](server-plugin-mail) | Email — outbound (transactional + bulk), inbound, tracking, suppressions |
| [`whitebox-pro-server-plugin-sms`](server-plugin-sms) | SMS — send, replies, opt‑outs, delivery receipts |
| [`whitebox-pro-server-plugin-voip`](server-plugin-voip) | Voice — call tracking, recording, transcription |
| [`whitebox-pro-server-plugin-crm`](server-plugin-crm) | CRM — webhook ingestion of customer state into the memory |
| [`whitebox-pro-server-plugin-engagement`](server-plugin-engagement) | Web — text / image / video engagement tracking |
| [`whitebox-pro-server-plugin-analytics`](server-plugin-analytics) | Ask & recall over the customer memory |
| [`whitebox-pro-server-plugin-audiences`](server-plugin-audiences) | Turn a question into a living ad‑network audience |

### Client · browser SDK

| package | what it does |
|---|---|
| [`whitebox-pro-client`](whitebox-pro-client) | Core: transport, identity, consent, plugin host |
| [`whitebox-pro-client-plugin-engagement`](client-plugin-engagement) | Reading / viewing / watching trackers |
| [`whitebox-pro-client-plugin-mail`](client-plugin-mail) · [`-voip`](client-plugin-voip) · [`-conversions`](client-plugin-conversions) · [`-crm`](client-plugin-crm) | Contact forms · trackable numbers · conversion events · client observations |

### Integrations (their own repos)

Ad networks (Meta / Google / TikTok), email providers (Mailgun / Postmark), SMS providers
(Twilio / Mobica) and MCP auth (Auth0) live in **their own repos** outside this monorepo and
compose into config like a plugin. They live in a sibling directory (default
`../whitebox-pro-integrations/`, override with `WB_INTEGRATIONS_DIR`); clone the ones you
need and link them:

```bash
git clone <integration-repo> ../whitebox-pro-integrations/whitebox-pro-adnetworks-meta
npm install          # postinstall links present integrations; a no-op when there are none
```

</details>

<details>
<summary><strong>Develop</strong></summary>

```bash
npm install          # one install wires every workspace (no npm link)
npm test             # run all package suites
npm test --workspace=whitebox-pro-server-plugin-mail   # one package
```

Tests spin up a throwaway Neon branch per run — copy `.env.test.example` to `.env.test`.
Server runtime config lives in `whitebox-pro-server/whitebox.config.js` (copy from
`whitebox.config.example.js`). Both are gitignored — never commit real secrets.

Full operator & integrator guide: **[docs/](docs/)**.

</details>

## License

UNLICENSED — © Almero Digital Marketing.
