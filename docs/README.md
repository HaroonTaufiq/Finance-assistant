# Personal Finance Assistant

An AI-driven, multi-user financial companion. Users sign in, bring in their transaction history, and talk to an assistant in plain language about their money — including by uploading a photo of a receipt.

**Repo:** https://github.com/HaroonTaufiq/Finance-assistant · **Live demo:** unavailable; the previously listed deployment currently returns Vercel `DEPLOYMENT_NOT_FOUND`. A replacement must pass a synthetic import/report journey before promotion.

> This README is also the design note. It explains what was built, the decisions behind it, and what was deliberately left out under the 6-hour, single-sitting constraint.

---

## The one idea this is built on

A naive finance assistant pipes transaction rows into an LLM and asks it to reason. That fails on cost, latency, and scale at once, and breaks the moment a user has years of history (the data won't fit in context).

**So this system is built on one rule: raw transaction rows almost never enter the model's context.**

The LLM is a *router and orchestrator* over deterministic tools. Math happens in Postgres. Heavy analytics (recurring-charge detection, anomaly scoring, time-series rollups) are **precomputed offline at ingest**, not per request. The model translates a question into a typed tool call and narrates the result. Two structural consequences follow, and they shape the whole codebase:

- **Two planes.** A *write path* (offline: ingest → clean → precompute) and a *read path* (online: per-request, reads small pre-aggregated tables). They're separated in the code, not interleaved.
- **Tiered effort.** Requests route to the cheapest sufficient tool. A balance lookup is a SQL read; an unknown-merchant lookup earns a heavier agentic model with web access. Effort scales with the task, never uniformly.

The two planes and the routing tiers, in prose and the diagram below: the write
path runs once at ingest and fills small precomputed tables; the read path is a
cheap-model tool loop over those tables.

```
            WRITE PATH (offline, async)                 READ PATH (online, per request)
   CSV / mock bank → ingest (dedup, validate,      user → chat API → LLM orchestrator
   quarantine) → batch jobs (categorize,                         │  routes to typed tools
   detect subscriptions, score anomalies,                        ▼
   roll up by month)                               ┌─────────────────────────────────┐
            │                                       │ Tier 0  deterministic SQL        │
            ▼                                       │ Tier 1  precomputed reads        │
   ┌───────────────────────────────────┐           │ Tier 2  vision (receipt OCR)     │
   │ Postgres + row-level security      │ ◀── reads │ Tier 3  agentic + web search     │
   │ transactions (raw) · rollups ·     │  aggregates Tier 4  LLM synthesis            │
   │ subscriptions · anomalies ·        │           └─────────────────────────────────┘
   │ budgets · user_memory              │
   └───────────────────────────────────┘
```

---

## What's built

Mapping the product capabilities to what's implemented. All ten are built and the
project type-checks, builds, and passes its unit tests; **end-to-end runtime
verification requires live Supabase credentials + model API keys** (see “Running
it locally”). Status reflects code-complete, not a claim of a hosted demo.

| # | Capability | Status | How it works |
|---|---|---|---|
| 1 | Answer spending questions | ✅ | `getSpending` (rollups) / `getTransactions` — parameterized, bounded, no raw rows in context |
| 2 | Read a receipt from a photo | ✅ | Vision extraction → Zod validation → **confidence-gated confirm step** |
| 3 | Surface recurring subscriptions | ✅ | Cadence detection at ingest, stored in `subscriptions`, read on demand |
| 4 | Flag unusual activity | ✅ | z-score / new-merchant / category-spike, precomputed into `anomalies` |
| 5 | Compare across time | ✅ | `getTrend` over monthly `rollups` — the answer to "reason over long history" |
| 6 | Track a budget | ✅ | `budgets` + `getBudgetStatus`, warns near/over limit, applies exclusions |
| 7 | Look up unfamiliar charges | ✅ | `lookupMerchant` — agentic loop with Tavily web search |
| 8 | Summarise finances | ✅ | `summarizeFinances` over rollups, reasoning-tier model |
| 9 | Suggest where to cut back | ✅ | `suggestCutbacks` over rollups + subscriptions |
| 10 | Remember user context | ✅ | `user_memory` — deterministic rules reconfigure the budget query layer |

---

## Architecture & key decisions

### Tech stack

TypeScript end to end. **Next.js (App Router)** (frontend + API routes + streaming in one deployable), **Supabase** (Postgres + Auth + Storage + row-level security), **Vercel AI SDK** (model-agnostic tool-calling loop), **Zod** (one schema language for tool args, OCR output, and CSV validation), deployed on **Vercel**. Models are selected per tier behind environment variables (a cheap model for routing/narration, a vision model for OCR, a reasoning model for synthesis/agentic work), so swapping a provider is a one-line change.

### The decisions worth defending

**TypeScript over Python.** Python's data tooling (pandas) is genuinely nicer for the messy-CSV work, and it's the AI-native default. But for a 6-hour build that has to be a working streaming, multimodal, multi-user app, the single-language/single-repo path removes a second deploy and a pile of glue. The CSV cleaning here is a one-time ingest script — it doesn't need pandas. I optimized for shipping a working slice over ingest ergonomics.

**Typed tools, not text-to-SQL.** The orchestrator never emits SQL. It calls a fixed set of parameterized functions (`getSpending`, `getTrend`, …) that compile to safe, bounded queries. This closes an injection hole, caps per-query cost and latency (every query is range- and row-bounded), and makes the system's behavior predictable.

**Row-level security for isolation.** "Each user's data is private" is enforced at the database with RLS policies (`user_id = auth.uid()`), not in application code. App code can't accidentally leak across tenants, and the storage bucket for receipts is scoped the same way.

**Precomputed rollups for scale.** Long-history questions read a small monthly aggregate table, never the raw rows. The rollup table's size scales with *time periods*, not transaction count — so going from one month to several years, or from the sample data to 100× larger, leaves the read path untouched.

**A cheap model as the router.** The orchestrator runs the cheapest capable model and lets it select tools — routing is a classification task that small models do well. Only the tools that genuinely need reasoning (summaries, cut-back advice, merchant lookup) escalate to a stronger model internally.

### Cost & scale

The architecture is the cost story. The common case — a spending question — is a cheap-model call plus a short narration over a SQL result: well under a tenth of a cent per interaction. Receipt OCR on a cheap vision model is a fraction of a cent. The only genuinely expensive calls (plain-English summaries, cut-back advice on a reasoning-tier model) run over pre-aggregated rollups and are infrequent, landing around a cent or two. A naive design that feeds transaction history to a frontier model on every question costs one to two orders of magnitude more and breaks on long histories. Fixed infra is small and flat (managed Postgres + serverless hosting), and the read path keeps DB egress low by reading aggregates rather than raw rows.

### Edge cases handled

- **Messy CSV** (duplicates, missing fields, junk rows): validated per-row; bad rows are **quarantined** to an `ingest_errors` table and reported back as an import summary (`N added · M skipped, with reasons`) — never silently dropped. Dedup via a content hash makes re-uploading the same file idempotent.
- **Blurry / rotated / foreign-language receipt:** the vision model handles rotation and language; a confidence gate catches low-quality extractions and routes them to a user confirm step instead of recording a wrong amount; manual entry is the fallback.
- **Ambiguous question:** the assistant asks one focused clarifying question rather than guessing.
- **Unanswerable from data:** the assistant says so plainly and offers the closest supported answer instead of fabricating.
- **Contradicting sources (receipt vs. bank row):** near-duplicates are matched on date + amount + merchant and surfaced as a conflict to resolve, rather than double-counted.

---

## Assumptions

- A single base currency per user; amounts are stored as integer cents (no float drift). Multi-currency FX is out of scope.
- The provided sample CSV / mock endpoint stands in for a real bank connection.
- "Months" are the primary reporting period; weekly/daily rollups are supported by the schema but not surfaced.
- **Model tiers:** router/vision default to Gemini (Flash-Lite / Flash) and reasoning to Claude Sonnet — the cheapest-capable mix; all three are env-swappable (`ROUTER_MODEL` / `VISION_MODEL` / `REASONING_MODEL`).
- **Budget exclusions** apply to the budget whose category matches the rule's `from` (use `from='__all__'` for an overall budget); budgets evaluate against the *latest month with data*, so the historical sample CSV still tracks sensibly.
- **CSV headers** are auto-detected from common synonyms (date/amount or debit+credit, description/merchant/category); ambiguous `MM/DD` vs `DD/MM` dates assume US `MM/DD` unless the first field exceeds 12.
- The sample CSV (`fixtures/sample-transactions.csv`) is dated 2024; for the freshest demo of "this month" questions, upload data with recent dates.

---

## What was intentionally skipped, stubbed, or simplified

Scoping is part of the exercise; here's where the 6 hours did and didn't go.

- **Real bank integration** — uses the mock/CSV only.
- **Production job queue** — batch jobs run synchronously at ingest. In production they'd move to a dedicated worker (Inngest / Trigger.dev / `pg_cron`), because serverless functions are hostile to long-running work. The two-plane design makes that a clean extraction, not a rewrite.
- **ML-grade anomaly detection** — ships a z-score / rolling-baseline heuristic. The upgrade path (per-category seasonal models, embeddings for merchant clustering) is named but not built.
- **Multi-conversation management, dark-mode toggle, exhaustive tests** — simplified or omitted; unit tests cover the high-signal ingest cleaning + dedup + coercion paths (22 tests). Dark-mode tokens are defined but the toggle isn't wired.
- **Categorizer model fallthrough** — categorization is rules-first (merchant/keyword); the cheap-model batch pass for leftovers is a documented hook, not wired (rows simply stay `uncategorized`).
- **Conversation persistence** — each turn is stored, but multi-conversation threading UI is out of scope (one active conversation).
- **Sidebar "quick facts"** — static copy rather than live glances, per the UI scope.

---

## Challenges

A few things that took real thought:

- **Contracts-first to keep parallel work aligned.** The build was decomposed into modular PRDs (see `docs/prd/`) and shipped as one PR each. The highest-leverage decision was freezing all cross-module shapes in `lib/contracts` *before* writing features, so the ingest, agent, UI, and receipt streams bind to one schema set and can't drift. Tool outputs double as the UI card payloads (`ResultCardData`), which removed an entire mapping layer.

- **Supabase SSR + RLS binding.** The policies are only correct if the server client is bound to the user's JWT via cookies. Following the current `@supabase/ssr` pattern (`getAll`/`setAll`, `getUser()` not `getSession()` in server code, and a middleware that does nothing between client creation and `getUser`) is what makes `auth.uid()` resolve — getting it wrong fails silently.

- **Historical sample data vs "this month".** The sample CSV is from 2024 but the app runs in 2026, so budgets/“this month” anchored to the real calendar would read empty. Budgets anchor to the *latest month with data* instead, so the demo is meaningful without doctoring dates.

- **Bounded, precomputed reads.** Spending/trend tools read the monthly `rollups` table, never raw rows, and `getTransactions` is capped at 50 — so the model context stays tiny and cost/latency stay flat as data grows. The orchestrator loop is hard-capped (`stepCountIs`) so the cheap router can't spin on multi-step requests.

- **Receipt confidence gate.** Deciding that a receipt is *always* a draft requiring one explicit confirm (never auto-recorded), with low-confidence/missing fields flagged and a near-duplicate check against existing bank rows to avoid double-counting.

---

## Running it locally

**Prerequisites:** Node 20+, `pnpm`, a free Supabase project, and an API key for at least one model provider.

```bash
# 1. install
pnpm install

# 2. configure
cp .env.example .env.local
#   fill in: Supabase URL + anon key, a model provider key,
#   the ROUTER_MODEL / VISION_MODEL / REASONING_MODEL strings,
#   and a Tavily (or Exa) key for merchant lookup.

# 3. database
#   Open the Supabase SQL editor and run docs/schema.sql in full.
#   It creates all tables, RLS policies, the profile trigger,
#   and the private 'receipts' storage bucket.
#   Then disable "Confirm email" under Auth settings for the fastest demo
#   (or use the /auth/callback flow that's already wired).

# 4. run
pnpm dev
#   open http://localhost:3000, sign up, then upload the sample CSV
#   from the empty state to populate your account.
```

> **Note:** Supabase's free tier pauses a project after ~1 week of inactivity. If the demo looks empty or errors on load, resume the project in the Supabase dashboard.

### Local database (Docker)

No hosted project is required — the repo ships a local Supabase setup (Postgres, Auth,
Storage, Studio). Requires Docker and the Supabase CLI.

```bash
pnpm db:start          # boots the stack and applies supabase/migrations/
supabase status -o env # API_URL / ANON_KEY / SERVICE_ROLE_KEY for .env.local
```

Local ports are shifted to `5433x` (API `54331`, DB `54332`, Studio `54333`) so this
stack can run alongside another local Supabase project. `docs/schema.sql` is the current schema snapshot; ordered files in
`supabase/migrations/` are the source of schema history. Keep the snapshot aligned
with the final migrated schema. `pnpm db:reset` **deletes all local database data**
before applying migrations; use it only for a disposable database, never to apply
new schema changes to an existing development dataset.

### Environment variables

See `.env.example`. Model selection is per-tier via `ROUTER_MODEL`, `VISION_MODEL`, and `REASONING_MODEL` — change these to swap providers without touching code.

---

## Project structure

```
/app           Next.js routes — /chat, /login, /api/{chat,ingest,receipts,receipts/confirm}, /auth/*
/lib/agent     orchestrator, typed tools, model resolution, prompts
/lib/ingest    CSV parse, validation, dedup, pipeline
/lib/batch     rollups, subscription detection, anomaly scoring, categorization
/lib/db        Supabase client (single getCurrentUser touchpoint) + parameterized queries
/lib/contracts shared Zod schemas + inferred types (the cross-module source of truth)
/lib/memory    deterministic user rules
/lib/search    web-search adapter (Tavily)
/components    chat shell, result cards, receipt draft, onboarding, import summary
/types         shared TS types (mirror Zod)
fixtures/      sample-transactions.csv
docs/          design docs — this README, SPEC.md, UI_SPEC.md, schema.sql, the brief
docs/prd/      modular PRD decomposition (how the build was scoped)
```

---

## If this kept going (evolution paths)

- Move the write/batch plane to a dedicated worker + queue (the plane is already isolated).
- Replace the z-score heuristic with proper anomaly models and embedding-based merchant resolution.
- Swap Supabase Auth for Clerk/Auth0 if needed — it sits behind a single `getCurrentUser()` helper, so it's a contained change.
- Add weekly/daily rollups and richer budget periods (the schema already allows them).
