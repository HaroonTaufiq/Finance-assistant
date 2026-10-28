# Reviewer handoff

**Date:** 2026-10-28 | **Branch:** `feat/anna-trusted-monthly-review` | **Commit and PR:** pending review artifact creation.

## Summary

This branch advances the standalone monthly review journey: local CSV preview → authenticated persistence → exact monthly report → user correction → recomputed revision. It adds import/recovery and pagination regressions, report/sample pages, classification/review actions, JSON export and confirmed deletion, redacted analytics, operational/launch documentation, and the Anna integration decision gate.

No Anna app bundle or per-user Anna persistence path is implemented. No user interviews, beta, marketplace approval, official qualification, growth, or investment decision is claimed.

## Requirement coverage

| Requirement | Status | Evidence / remaining limit |
|---|---|---|
| R1 Architecture and supported identity | **Blocked** | [architecture-decision.md](./architecture-decision.md) records official docs and the missing per-user storage-call contract, Anna CLI/runtime/account, and backend identity bridge. Standalone remains usable; no Anna journey is claimed. |
| R2 Sample-first entry | **Implemented in standalone** | Synthetic March report, explicit sample-only state, deterministic totals/recurrence test, production-build desktop/mobile screenshots. Sample date is fixed and cannot switch into personal mode. |
| R3 Guided import | **Implemented and exercised locally** | 4 MiB/10,000-row bounds; explicit currency/date order; local preview; mapping/coverage/counters; six-row synthetic authenticated browser import. |
| R4 Exact monthly report | **Implemented and exercised locally** | Integer cents; gross/refund/net/income/unknown totals; coverage and prior-month comparison; browser report matched fixture values exactly. |
| R5 Recurring-charge review | **Implemented in standalone** | Three-observation evidence and uncertainty in sample; confirm/dismiss endpoints; pgTAP verifies a recomputation-style upsert preserves dismissal. No production accuracy claim. |
| R6 Correction and recomputation | **Implemented and exercised locally** | Changed `MARKET ONE` to `other`; new revision recomputed category rollups while net spend stayed exact. Export retained original category and user override provenance. |
| R7 Grounded AI explanation | **Partial** | Untrusted merchant/transaction prompt regression and explicit malformed cutback-output errors. Provider failure and retry UI were exercised; successful live explanation is blocked because no model keys were configured. |
| R8 Persistence, privacy, export, deletion, isolation | **Implemented; local checks pass** | Export route returned 200; confirmed deletion left login active and export empty; pgTAP 18 assertions check account A/B RLS and deletion. Receipt-object deletion with a real uploaded object and provider-backup erasure remain unverified. |
| R9 Responsive/accessibility | **Partial** | Standalone production sample tested at 1440×1100 and 390×844; mobile had no document horizontal overflow. Keyboard/assistive-technology audit and Anna app-window path remain outstanding. |
| R10 Analytics and cost controls | **Partial** | Constrained, pseudonymous allow-list; sample/personal modes; analytics RLS/deletion. No production cost baseline, rate quota, alert, or official Anna metric validation. |

## Reproduction

Follow [verification.md](./verification.md) for exact commands, local setup, fixture import, expected report values, correction, export, and deletion steps. Do not reset a database containing work to preserve. The synthetic CSV is [monthly-review.csv](./fixtures/monthly-review.csv).

## Verified checks

- `pnpm test`: 13 files, 45 tests passed.
- `pnpm lint`: passed with no ESLint warnings/errors; Next 15 prints a deprecation notice for `next lint`.
- `pnpm build`: passed on Next.js 15.5.19.
- `pnpm typecheck`: passed after build generated `.next/types`.
- `git diff --check`: passed.
- `supabase migration up --local`: pending redacted-analytics migration applied; local schema up to date.
- `supabase test db supabase/tests/rls_and_deletion.sql --local`: 19 assertions passed.
- Browser: authenticated six-row CSV import, exact report, category correction/revision, export preserving original+override, explicit deletion and empty re-export; production-build synthetic sample at desktop/mobile sizes.
- Browser model failure: provider keys absent; error and retry UI verified. No successful model response or provider cost is reported.

## Performance, cost, and limitations

- Tested import size: six synthetic data rows. Pagination regressions cover reads beyond 1,000 rows, but no 1,000-row reference-hardware p95 benchmark was run.
- Local pgTAP executed 18 assertions in under one wall-clock second. This is not a production benchmark.
- No external AI/search call was made and no provider charge was incurred in this verification. Storage/model cost per user/run and deployed p95 remain unmeasured.
- Anna-specific authentication, persistence, app bundle, model invocation, and review submission are blocked on the platform gate. `anna-app` and `uv` are unavailable in this environment.
- No interview, beta, user-retention, official qualification, marketplace, publication, or growth result is claimed.
- The full boundary and recovery notes are in [operations.md](./operations.md); architecture evidence is in [architecture-decision.md](./architecture-decision.md).

## Human/platform follow-up

1. Platform/owner: provide a configured Anna dev account/runtime/CLI and confirm the exact user-scope storage method contract or approved backend identity exchange.
2. Owner: review and authorize any external account activation, submission, outreach, deployment, or spend.
3. Reviewer: inspect the PR and reproduce the core standalone journey; update Notion only after review as planned.
4. Keep external-outcome issues open until actual evidence exists; coding completion is not approval or user demand.
