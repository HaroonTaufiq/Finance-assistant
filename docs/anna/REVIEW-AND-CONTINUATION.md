# Engineering review and continuation decisions
Date: 2026-10-28
Reviewed checkout: f0ce31699194b45093d31e0c55b779d473472c86, plus current uncommitted setup.
Scope: recent baseline commits 362df4a/f0ce316, current financial read/write paths, and readiness against Implementation PRD v1.0. Review findings below are code-path analysis unless explicitly identified as a command result; no database failure injection or deployed Anna acceptance was run.

## Quality judgment
The recent change is a sound, small baseline improvement. Pure rollup math and calendar helpers are now testable, fixed fixture expectations are useful, and the baseline document distinguishes checks from runtime evidence. The extraction largely preserves existing behavior. I found no demonstrated regression introduced by that extraction.

It is not implementation of the Anna PRD. There is no Anna app bundle or configured browser acceptance suite in this checkout, and all 18 project issues remain Backlog. The broader finance application still has correctness and recovery gaps. A passing unit suite does not establish that importing, storing, querying and explaining the same history is correct.

Fresh checks run during this review:
- pnpm test: passed, four files / 26 tests.
- pnpm lint: passed; next lint emits a deprecation notice but works in the installed version. It is not presently a failing release check.
- pnpm build: passed.
- pnpm typecheck: passed after build, sequentially.

## Findings to fix before accepting a real import/report flow
### FND-1 — P1: retry can preserve incomplete derived data
lib/ingest/pipeline.ts inserts transactions before running the batch step. If the batch fails, transactions remain. Re-upload ignores those duplicates, imported becomes zero, and the imported > 0 gate skips recomputation. A retry can therefore look successful while derived data remains incomplete or stale.

Required regression: inject failure after row persistence but before successful derivation; retry the same import; verify it repairs the derived revision and only then exposes a completed report. Preserve user overrides and prevent double-counting.

### FND-2 — P1: unpaginated history reads can silently truncate results
supabase/config.toml sets max_rows = 1000. The history/month scans in lib/batch/rollups.ts and recurring detection in lib/batch/subscriptions.ts do not paginate. A supported import above the cap can produce incomplete rollups and recurrence evidence while looking successful. This is an existing read-path gap; the new pure-math test does not exercise it.

Required regression: at least 1,201 transactions in one reporting month, plus multiple months/merchants across page boundaries. Verify exact totals/counts and recurrence over all supported rows. Use paginated reads with deterministic ordering or database-side aggregation; do not merely raise the server cap.

### FND-3 — P1: arbitrary date inputs are mislabeled as exact range totals
lib/db/queries.ts getSpending maps input dates to touched monthly rollups and echoes the original dates in its result. A one-day request can return the entire month's spend. Baseline tests document the helper but do not fix or reject unsupported report semantics.

Required regression: April 15–15 must never return full April labeled as that day. V1 decision below is monthly-only reporting: reject/clarify partial-day requests, or implement an exact-day path if needed later. Do not silently expand dates.

### FND-4 — P1: refund/currency semantics remain unsafe for the promised report
aggregateMonthlyRollups treats all positive values as income; its input has no transaction kind or currency. Current month aggregation does not partition/filter currency, and getSpending labels the result USD. The parser accepts currency values, so imported mixed currencies can be combined unless rejected before persistence.

Required regression: separate expense, refund, income and transfer; reject mixed/unsupported currency at preview/commit; keep same-currency totals exact. No live FX in v1.

### FND-5 — P2: same-content transactions can be discarded
lib/ingest/dedup.ts hashes user/date/amount/merchant/description, without currency or source account/transaction identity. Two legitimate identical purchases can be collapsed. Build stable import/source identity and a reviewable ambiguity policy rather than treating a matching normalized tuple as proof of duplication.

### FND-6 — P2: setup is not yet a clean reproducible delivery
The Supabase setup and package scripts are uncommitted. The added ignore pattern is ..commandcode/* and does not ignore the actual .commandcode/ directory (confirmed with git check-ignore). This is a typo, not proof of secret exposure. Inspect filenames/content safely before committing any agent configuration; do not include credentials.

## Decisions settled for the coding agent
These supersede open product choices in the earlier baseline. Implement them without another planning-only turn.

1. **Product:** monthly transaction-history review, led by recurring-charge candidates and spending changes. No investment advice, bank sync, FX, pet or billing expansion.
2. **Architecture default:** retain Supabase/Postgres, the existing Next.js backend and pure domain logic. Build a separate static responsive Anna UI/adapters; do not attempt to ship Next server routes as a static bundle. Do not rewrite the existing standalone app into APS merely to be platform-native.
3. **Authentication:** prove a documented supported Anna-to-backend identity or explicit account-linking path before calling integration verified. No invented JWT trust, browser-owned user IDs or service-role shortcuts. Routine implementation details are delegated to the agent. If the retained-backend path is genuinely unsupported after a one-engineering-day feasibility spike, record evidence and build a minimal native-Anna adapter against the same domain interfaces, preserving the standalone backend. This fallback is preselected, not a request for another architecture meeting.
4. **Reporting:** calendar months in the user-selected report, with actual coverage labels. This month is the current month. Latest imported month must be explicitly labeled. Partial-day requests get a limitation/clarification in v1; no misleading whole-month answer.
5. **Financial semantics:** gross outflows, confirmed refunds, net spend and income are separate. Transfers are excluded when mapped/confirmed. Unknown positive inflows stay unclassified. Net spend may be negative. Preserve source values and user override provenance.
6. **Currencies:** USD, PKR, EUR and GBP, one currency per user's report dataset initially; confirm it at import and reject mismatch. No automatic conversion or historical revaluation.
7. **Bounds:** launch CSV limit 4 MB and 10,000 data rows, enforced at trusted boundaries. Page through all supported records. Measure the PRD's 1,000-row performance target; a limit is not permission to silently truncate.
8. **Duplicates:** prefer stable source transaction IDs scoped by account/currency. Without IDs, preserve legitimate row multiplicity and expose uncertain overlap for review. Retrying the same confirmed import must be idempotent.
9. **Recurrence:** three occurrences minimum for detection; never treat recurrence alone as a verified subscription. Show dates/amounts, sample count and uncertainty. Confirm/dismiss survives re-import. Missing observations are not proof of cancellation. Latest observed amount changes may be flagged with evidence; no guaranteed savings claims.
10. **Corrections and recovery:** immutable source/provenance plus explicit overrides; versioned derived results. A report is complete only when all derivations for that revision succeed. Retry repairs failed work; every warning/explanation is invalidated or regenerated consistently.
11. **AI:** grounded explanation over bounded report context, optional for arithmetic/report availability. Deterministic calculations remain visible during provider failure. No imported descriptions/notes sent by default. Audit legacy raw-row tool paths before exposing them in Anna.
12. **UI:** sample first, then preview → confirmed import → immediate report → evidence/corrections. Responsive and keyboard-accessible, direct explanation actions, clear progress/retry. No styling approval needed; use a restrained report-oriented design consistent with the existing app.
13. **Storage/schema:** use existing local Supabase for isolated development, with a separate test dataset/database where needed. Use forward migrations for schema history; keep docs/schema.sql an aligned snapshot, not an independently diverging definition. Do not reset existing data.
14. **Delivery:** coherent reviewable PRs, full verification evidence and a reviewer handoff. Work through engineering requirements without waiting for user interviews or program answers when independent work remains. Do not merge, publish, send outreach, accept legal terms or buy services without applicable authorization.
15. **Evidence:** no invented users, interviews, approval, payouts or MAU. Prepare materials and record exact external actions. Keep Notion updates with the reviewing agent after implementation review.

## Next delivery sequence
A. Preserve current work, fix setup typo, finish the reproducible baseline and add failure/pagination/period/refund fixtures.
B. Ship the first complete personal-data slice: preview → idempotent/recoverable import → exact monthly report → classification correction → recomputed report. Add a sample entry and browser evidence.
C. Finish recurrence evidence/review state, data export/deletion/isolation, grounded explanation and limits.
D. Prove and package the selected Anna integration; rerun exact-release and standalone journeys.
E. Finish analytics, launch/review assets, documented cost/performance, PRD requirement-to-test matrix and reviewer handoff.
A complete slice is a checkpoint, not permission to stop if other authorized engineering work remains.

## Copyable continuation prompt
Read the Linear Implementation PRD and this review/decision record in full. You are implementing Finance Assistant — Anna Edition in project P-HAR-2, not preparing another plan. You do not need Notion access.

Inspect current HEAD, dirty files, repository instructions and full Linear issues HAR-19 through HAR-36. Preserve unrelated work and build on the existing baseline. Apply the settled decisions in this record and the PRD; do not ask again about product scope, refund/period/currency semantics, routine UI choices or the default architecture.

Start with FND-1 through FND-6 and meaningful regressions, then execute the complete engineering PRD in coherent slices. In particular, prove import failure recovery, totals beyond the 1,000-row API cap, monthly date semantics and refund/currency classification. Deliver a real configured vertical slice before expanding features. Continue through remaining authorized work rather than ending after a plan, baseline, test-only refactor or single milestone.

Use current official platform documentation for the integration; never invent identity bridges or bypass user isolation. If external access is missing, record the exact blocked check and continue independent domain, UI, adapter, fixture and documentation work. Implement the preselected fallback only when the primary path is demonstrably unsupported, and record evidence.

Run relevant unit, integration and browser tests, lint, build and typecheck; report real results. Keep Linear statuses and PR links current. Do not mark interviews, beta recruitment, marketplace approval or growth complete without real evidence. Prepare their materials and leave precise owner/platform dependencies.

Finish with reviewable PR(s) and docs/anna/review-handoff.md covering commit SHA, run instructions, R1–R10 evidence, fixture results, configured Anna/standalone journeys, cost/performance and unresolved limitations. Do not merge your own work. Ask only for an unavoidable external authorization/credential/legal/spend decision after making the action concrete; routine engineering decisions are delegated. The reviewing agent will review the resulting work and update Notion afterward.
