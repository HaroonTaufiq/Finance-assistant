# Verification record

Date: 2026-10-29
Branch: `feat/anna-trusted-monthly-review`
Current commit: `pending-final-commit`

## Commands run

| Check | Result |
|---|---|
| `pnpm test` | Pass: 23 test files, 92 tests |
| `pnpm lint` | Pass |
| `pnpm build` | Pass |
| `pnpm typecheck` | Pass |
| `git diff --check` | Pass |
| `supabase migration up --local` | Pass |
| `supabase test db supabase/tests/rls_and_deletion.sql --local` | Pass: 39 assertions |

## Current-build browser/UX checks

1. Started the rebuilt production artifact on port 3000 and a provider-disabled instance on port 3001.
2. Imported the six-row fixture in the signed-in browser; the report showed 4,000 gross outflows, 500 refunds, 3,500 net spend, 100,000 income, and 16.7% month comparison.
3. Corrected `MARKET ONE` from groceries to other; the report recomputed groceries to 3,000 cents and other to 1,000 cents without changing net spend.
4. Export returned 200 with the original category, user override, and `classification_source: "user"`. Deletion returned 200 and left report `hasData: false` and export transaction count zero.
5. On port 3001, a synthetic 1-pixel PNG produced the explicit manual-entry receipt draft without a live provider call; receipt data and file were deleted afterward.
6. At 390×844, document width remained 390 pixels and keyboard Tab focus was visible on report navigation.
7. The only browser console error was the expected missing favicon request.

## Performance evidence

- Current-build local single-run measurement: 1,000 synthetic rows imported in 775 ms and the authenticated report data load completed in 321 ms (AMD Ryzen 5 PRO 4650U, 12 logical CPUs, 30 GiB RAM).
- This is one local measurement, not a p95 or production benchmark.

## External dependencies and limits

- No live models or external finance providers were used in the acceptance checks.
- No Anna runtime, live platform account, or deployment environment was verified.
- This validation is limited to local synthetic data and the current build artifact.
