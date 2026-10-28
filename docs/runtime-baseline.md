# Runtime and correctness baseline

Baseline recorded on 2026-10-28 for HAR-19. Checks use the repository's synthetic
CSV fixture; no secret values or personal financial data are recorded here.

## Environment

- Node.js: `v24.21.0`
- pnpm: `9.15.2`
- Vitest: `2.1.9`
- Next.js: `15.5.19`
- A local Supabase development stack is running. This baseline does not reset or
  modify its database.

## Reproduction

From the repository root, install from the lockfile and run:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

Results on this baseline:

- Before adding the baseline cases, `pnpm test` passed 2 files / 22 tests.
- `pnpm typecheck`: passed when run after the production build. An initial
  concurrent run failed because Next.js was generating `.next/types` at the
  same time; the sequential rerun passed.
- Initial `pnpm build`: passed with a non-fatal Edge Runtime warning about
  `process.version` in the Supabase client dependency.
- The repository has no Playwright configuration or browser journey tests yet.

After adding the baseline cases, `pnpm test` passed 4 files / 26 tests,
`pnpm typecheck` passed, and `pnpm build` passed.

## Synthetic fixture expectations

`fixtures/sample-transactions.csv` has 26 data rows: 24 valid rows and 2
quarantined rows. The repeated Whole Foods row has no source transaction ID,
so the import now preserves both occurrences and flags one as an uncertain
overlap instead of silently assuming it is a duplicate. The baseline therefore
contains 24 persisted transactions. Payroll rows are explicitly categorized as
income; other positive inflows remain unclassified. Expected gross outflows and
explicit income in signed cents are:

| Month | Spend (cents) | Income (cents) | Unique rows |
|---|---:|---:|---:|
| 2024-04 | 189943 | 320000 | 10 |
| 2024-05 | 290358 | 320000 | 8 |
| 2024-06 | 281397 | 320000 | 6 |

These are deterministic aggregation expectations, not evidence that the full
authenticated import/report path ran against the database. Refunds, transfers,
income, and unknown inflows are now separate rollup dimensions; do not compare
their totals to the earlier signed-amount-only baseline without noting this
intentional semantic correction.

## Runtime evidence and open blockers

- On 2026-10-28, `https://finance-assistant-fawn.vercel.app/` returned HTTP 404
  with Vercel error `DEPLOYMENT_NOT_FOUND`. No replacement deployment has been
  verified; the public demo is a promotion blocker.
- The current automated suite covers parsing, normalization, deduplication,
  signed-amount aggregation, and calendar-month selection. It does not exercise
  authenticated import, database persistence, reports, receipt OCR, chat, or
  deletion end to end.
- The fixture contains no refund row. The current signed-amount model places
  positive amounts in income, so whether refunds should reduce reported spend
  remains an explicit product/correctness decision before an exact report can
  be accepted.
- `getSpending` reads whole monthly rollups for every calendar month touched by
  its input date range. Partial-month date ranges therefore include the entire
  first and last month. Confirm that month-level semantics are intended, or
  change the query/read model before presenting such requests as exact-day
  totals.
- Receipt OCR and chat require model-provider configuration. Run those journeys
  only after credentials are provided, using synthetic data and a test account.
