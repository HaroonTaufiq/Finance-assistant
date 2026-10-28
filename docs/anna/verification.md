# Verification record

Date: 2026-10-28. All database and browser checks below used the local development stack and synthetic data; no deployed Anna runtime or production data was used.

## Commands and outcomes

| Check | Result |
|---|---|
| `pnpm test` | Pass: 13 test files, 45 tests. |
| `pnpm lint` | Pass: no ESLint warnings/errors. The installed Next 15 `next lint` command prints its deprecation notice. |
| `pnpm build` | Pass: production build on Next.js 15.5.19; app and API routes compiled. |
| `pnpm typecheck` | Pass when run after the production build has generated `.next/types`. |
| `git diff --check` | Pass. |
| `supabase migration up --local` | Pass: applied `20261028104500_redacted_analytics.sql`; local database reports up to date. |
| `supabase test db supabase/tests/rls_and_deletion.sql --local` | Pass: 19 pgTAP assertions; transaction rolls back its synthetic records. |

The report/correction journey ran in the local Next.js development server against the local Supabase stack. The sample-only journey was also loaded from the production build at 390×844 and 1440×1100. Mobile sample view had `documentWidth=380` at `viewportWidth=390`, no document-level horizontal overflow, and a disabled date picker showing March 2024.

## Reproduce the import-to-recomputation journey

1. Install with `pnpm install --frozen-lockfile`; configure local Supabase and the standard app environment variables (names only are listed in [operations.md](./operations.md)).
2. Start the local database with `pnpm db:start`, apply forward migrations with `supabase migration up --local`, and start the app with `pnpm dev`.
3. Create and sign in to a disposable local account at `/login`.
4. In the chat import card, select [monthly-review.csv](./fixtures/monthly-review.csv). Choose USD and month/day/year. The preview should show 6 rows, 6 valid, 0 invalid, observed dates `2024-01-01` to `2024-02-29`. Confirm the explicit coverage checkbox and import.
5. The import summary should report 6 added and 0 skipped. The persisted February report should show:

   | Measure | Expected |
   |---|---:|
   | Gross outflows | 4,000 cents |
   | Refunds | 500 cents |
   | Net spend | 3,500 cents |
   | Income | 100,000 cents |
   | Unknown inflows | 0 cents |
   | January comparison | +500 cents / +16.7% |

6. In February's transaction table, change `MARKET ONE` from `groceries` to `other` and save. Wait for the new revision. Net spend remains 3,500 cents; the category totals recompute to groceries 3,000 cents, other 1,000 cents, and refunds -500 cents.
7. Fetch the authenticated `/api/data/export` endpoint. It should return 200 and the transaction's original `category: "groceries"` alongside `category_override: "other"` and `classification_source: "user"`.
8. Use **Delete finance data** and accept the explicit confirmation. The current sign-in remains valid; `/api/report` returns `hasData: false`, and a fresh export contains zero transactions. New post-deletion sample/QA activity may create new redacted analytics rows.

This was exercised in a browser with an isolated synthetic account. The export request initially exposed an ordering bug for `subscriptions` (that table has no `created_at`); the export now orders subscriptions by `merchant_norm`/`id`, and the same authenticated export returned 200 with the source and override fields above.

## Other evidence

- `supabase/tests/rls_and_deletion.sql` creates two synthetic users inside a transaction, checks account-scoped reads, checks that a recurring-candidate upsert preserves a dismissal, invokes the authenticated deletion RPC for account A, checks its financial tables are empty, and verifies account B's transactions and analytics remain. The test rolls back.
- The exact synthetic sample report is covered by `lib/anna/sample.test.ts`; its expected March net spend is 9,449 cents, income 300,000 cents, and unknown inflows 1,000 cents. STREAMCO is explicitly a three-observation heuristic candidate.
- Prompt boundary tests cover malicious merchant/transaction text as untrusted evidence. Cutback-output tests verify malformed structured output raises an error rather than returning an empty success.
- The browser's evidence-explanation path was tested with missing model provider keys. The deterministic report remained available, the UI displayed a failure and retry action, and a retry stayed in the failure state. No successful live model explanation was verified.
- Synthetic sample screenshots: [desktop](./screenshots/sample-review-desktop.png) and [mobile](./screenshots/sample-review-mobile.png).

## Performance, cost, and limitations

- The authenticated browser import used 6 rows; no representative 1,000-row p95 benchmark was run. Existing pagination/regression tests include reads beyond the Supabase 1,000-row default cap, but that is not a hardware performance measurement.
- Local pgTAP reported 19 tests in under one wall-clock second. This is a correctness test, not a production latency target.
- No model/search provider key was configured for this run, so no external model/search calls or provider charges were incurred. Per-user storage cost, model cost, and deployed p95 are unmeasured.
- Anna CLI/runtime/account were unavailable. There is no Anna bundle, login/persistence/isolation journey, or platform review.
- No interviews, beta participants, marketplace submission/approval, qualified-user metrics, or growth outcomes were performed or claimed.
- Receipt-object deletion was not tested with an uploaded object in this run; SQL metadata and financial-data deletion were tested. Provider backup erasure is outside the app's proof boundary.
