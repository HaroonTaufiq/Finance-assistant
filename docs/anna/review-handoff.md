# Reviewer handoff

**Date:** 2026-10-28 | **Branch:** `feat/anna-trusted-monthly-review` | **Latest validated code commit:** `57c7ed778b85192bc4fc4db4d54d249ecc7c73df` | **PR:** [#17](https://github.com/HaroonTaufiq/Finance-assistant/pull/17) (open; not merged). Evidence below was run against that code commit; a documentation-only follow-up records this handoff.

## Summary

This PR fixes all five required PR-review findings and advances the standalone monthly review journey: local CSV preview → authenticated persistence → exact monthly report → user correction → recomputed revision. It adds transactional rollup replacement, classification/sign validation, explicit source-less overlap decisions, per-user write serialization, revision-pinned explanations, corrected-result presentation, server-side AI quotas, and receipt manual-entry recovery.

No Anna app bundle or per-user Anna persistence path is implemented. No user interviews, beta, marketplace approval, official qualification, growth, or investment decision is claimed.

## PR #17 acceptance findings

| Finding | Resolution | Regression evidence |
|---|---|---|
| REV-1 — stale monthly categories / partial replacement | Each month is replaced atomically; categories absent after correction are removed, and database failure preserves the previous month. | `lib/batch/rollups.test.ts`; pgTAP replacement/failure assertions in `supabase/tests/rls_and_deletion.sql`. |
| REV-2 — transaction kind and sign ambiguity | Explicit kinds take precedence, transfers are classified regardless of sign, and contradictory expense/refund/income signs are quarantined. | `lib/ingest/parse.test.ts`. |
| REV-3 — source-less identity and multiplicity | Stable occurrence hashes no longer depend on file fingerprint; probable historical overlap requires explicit match-or-keep choices while identical in-file purchases retain multiplicity. | `lib/ingest/dedup.test.ts`; overlap/retry assertions in `lib/ingest/pipeline.test.ts`. |
| REV-4 — concurrent writes / wrong import completion | Durable per-user write lease serializes imports, correction, receipt confirmation, retry, subscription review and deletion; completion targets only the captured job IDs. | `lib/db/user-write-lock.test.ts`; late-job regression in `lib/ingest/pipeline.test.ts`; pgTAP lock ownership/concurrency assertions. |
| REV-5 — ungrounded or stale explanations | Shared report loader exposes currency, gross/refund/net/income, coverage, effective classifications, recurrence evidence and revision. Direct explanation actions pin and recheck revision; transaction tools and cards honor corrected category/kind and currency. | `lib/report/monthly.test.ts`, `lib/report/explanation.test.ts`, `lib/db/queries.test.ts`, `components/result-card.test.ts`. |

Additional recovery safeguards bound streamed chat bodies/context, apply database-backed AI request quotas and concurrency slots, and expose failed receipt extraction as explicit manual entry rather than a success-shaped empty extraction. Receipt confirmation is owner-scoped and idempotent.

## Selected follow-up review comments

Seven selected reviewer comments were checked against the current branch. Five needed additional changes: receipt-only users can choose and confirm a dataset currency; unset legacy settings are updated conditionally and only when existing transactions have no conflicting/missing currencies; the monthly report now renders above, rather than instead of, chat messages and receipt drafts; recurrence amount changes are rounded to integer cents; and unrecognized bank `Type` values fall back to category/sign inference. Two findings were already fixed in the preceding implementation: atomic rollup replacement and source-less occurrence hashes independent of the file fingerprint. The overlap regression now also uses a legacy fingerprint-dependent historical hash to prove decisions rely on identity evidence, not the old hash.

## Requirement coverage

| Requirement | Status | Evidence / remaining limit |
|---|---|---|
| R1 Architecture and supported identity | **Blocked** | [architecture-decision.md](./architecture-decision.md) records official docs and the missing per-user storage-call contract, Anna CLI/runtime/account, and backend identity bridge. Standalone remains usable; no Anna journey is claimed. |
| R2 Sample-first entry | **Implemented in standalone** | Synthetic March report, explicit sample-only state, deterministic totals/recurrence test, production-build desktop/mobile screenshots. Sample date is fixed and cannot switch into personal mode. |
| R3 Guided import | **Implemented; browser evidence predates this review-fix commit** | 4 MiB/10,000-row bounds; explicit currency/date order; local preview; mapping/coverage/counters; source-less match-or-keep review. Pipeline regressions cover retry and late-job isolation. |
| R4 Exact monthly report | **Implemented; exact output regression added** | Integer cents; gross/refund/net/income/unknown totals; coverage and prior-month comparison. `lib/report/monthly.test.ts` asserts exact totals, 16.7% comparison and revision stability. |
| R5 Recurring-charge review | **Implemented in standalone** | Three-observation evidence and uncertainty in sample; confirm/dismiss endpoints; pgTAP verifies a recomputation-style upsert preserves dismissal. No production accuracy claim. |
| R6 Correction and recomputation | **Implemented; aggregate and query regressions pass** | Effective category/kind overrides propagate to rollups and transaction results. Atomic replacement removes stale categories. The earlier authenticated browser run changed `MARKET ONE` to `other`; that browser journey was not repeated for this review-fix revision. |
| R7 Grounded AI explanation | **Partial** | Untrusted merchant/transaction prompt regression and explicit malformed cutback-output errors. Provider-failure/retry UI evidence is from the prior baseline; no live explanation was generated on this revision. |
| R8 Persistence, privacy, export, deletion, isolation | **Database checks pass; live object journey remains unverified** | pgTAP verifies account A/B isolation, owned write/AI slots, quota enforcement, deletion and atomic rollup behavior (33 assertions). The authenticated export/deletion browser run is prior-baseline evidence; real uploaded-object deletion and provider-backup erasure remain unverified. |
| R9 Responsive/accessibility | **Partial** | Standalone production sample screenshots at 1440×1100 and 390×844 are prior-baseline evidence; no responsive/browser check was rerun for this revision. Keyboard/assistive-technology audit and Anna app-window path remain outstanding. |
| R10 Analytics and cost controls | **Partial** | Constrained, pseudonymous allow-list; sample/personal modes; analytics RLS/deletion; database-backed 12-request/hour AI quota by default, configurable 1–60, and one active account AI request. No provider-spend alert, production cost baseline, or official Anna metric validation. |

## Reproduction

Follow [verification.md](./verification.md) for exact commands, local setup, fixture import, expected report values, correction, export, and deletion steps. Do not reset a database containing work to preserve. The synthetic CSV is [monthly-review.csv](./fixtures/monthly-review.csv).

## Verified checks on `57c7ed778b85192bc4fc4db4d54d249ecc7c73df`

- `pnpm test`: 22 files, 84 tests passed.
- `pnpm lint`: passed with no ESLint warnings/errors; Next 15 prints the `next lint` deprecation notice.
- `pnpm build`: production build passed on Next.js 15.5.19, including all app/API routes.
- `pnpm typecheck`: passed after the production build generated `.next/types`.
- `git diff --check`: passed.
- `supabase migration up --local`: local schema up to date through `20261028112000_delete_ai_request_slots.sql`; no database reset.
- `supabase test db supabase/tests/rls_and_deletion.sql --local`: 33 assertions passed.
- No authenticated browser journey or live model call was run for this selected-feedback follow-up. The browser evidence in the earlier handoff applies to the pre-fix baseline only; use the reproduction instructions to repeat it against this commit.

## Performance, cost, and limitations

- A mocked synthetic 1,201-row rollup regression crosses the Supabase 1,000-row page boundary and verifies the exact total. It is a correctness check, not an end-to-end import or hardware latency benchmark. No representative p95 benchmark was run.
- Local pgTAP executed 33 assertions in under one wall-clock second. This is not a production benchmark.
- No live AI/search call was made and no provider charge was incurred during this verification. Provider cost per user/run, storage cost, and deployed p95 remain unmeasured. The server quota is a request limit, not a monetary cap.
- Anna-specific authentication, per-user storage, app bundle, model invocation, and review submission remain blocked on the platform gate and provider credentials. `anna-app` and `uv` are unavailable in this environment.
- No interview, beta, user-retention, official qualification, marketplace, publication, or growth result is claimed.
- The full boundary and recovery notes are in [operations.md](./operations.md); architecture evidence is in [architecture-decision.md](./architecture-decision.md).

## Human/platform follow-up

1. Platform/owner: provide a configured Anna dev account/runtime/CLI and confirm the exact user-scope storage method contract or approved backend identity exchange.
2. Owner: review and authorize any external account activation, submission, outreach, deployment, or spend.
3. Reviewer: inspect the PR and reproduce the core standalone journey; update Notion only after review as planned.
4. Keep external-outcome issues open until actual evidence exists; coding completion is not approval or user demand.
