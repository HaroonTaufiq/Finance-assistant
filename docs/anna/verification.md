# Verification record

Date: 2026-10-28. Verification revision: `a7e74638cc85a4bb4b42f71ac513f23205f3f4e8`. Database checks used the local development stack and synthetic data; no deployed Anna runtime or production data was used.

## Commands and outcomes

| Check | Result |
|---|---|
| `pnpm test` | Pass: 21 test files, 77 tests. |
| `pnpm lint` | Pass: no ESLint warnings/errors. Next 15 prints the `next lint` deprecation notice. |
| `pnpm build` | Pass: production build on Next.js 15.5.19; app and API routes compiled. |
| `pnpm typecheck` | Pass after the production build generated `.next/types`. |
| `git diff --check` | Pass. |
| `supabase migration up --local` | Pass: local schema is up to date through `20261028112000_delete_ai_request_slots.sql`; no reset was run. |
| `supabase test db supabase/tests/rls_and_deletion.sql --local` | Pass: 33 pgTAP assertions; transaction rolls back its synthetic records. |

The earlier authenticated report/correction browser journey and desktop/mobile sample screenshots were produced against the pre-review-fix baseline. They are historical evidence and were not repeated on `a7e74638cc85a4bb4b42f71ac513f23205f3f4e8`. The review-fix revision adds regressions for exact report values, revision stability, source-less import overlap, atomic month replacement and effective corrections. Re-run the authenticated browser steps below before treating the full journey as re-verified on the latest revision.

## Reproduce the import-to-recomputation journey

1. Install with `pnpm install --frozen-lockfile`; configure local Supabase and the standard app environment variables (names only are listed in [operations.md](./operations.md)).
2. Start the local database with `pnpm db:start`, apply forward migrations with `supabase migration up --local`, and start the app with `pnpm dev`. Do not reset a database containing work to preserve.
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
8. Use **Delete finance data** and accept the explicit confirmation. The sign-in account remains valid; `/api/report` returns `hasData: false`, and a fresh export contains zero transactions. New post-deletion sample/QA activity may create new redacted analytics rows.

The original browser run used an isolated synthetic account and exposed the export ordering issue for `subscriptions` (that table has no `created_at`); export now orders subscriptions by `merchant_norm`/`id`. The latest review-fix commit's current evidence is the automated regression suite and local database checks, not a repeated browser session.

## Other evidence

- `supabase/tests/rls_and_deletion.sql` creates two synthetic users inside a transaction, checks account-scoped reads, write-lock ownership, AI concurrency and quota enforcement, complete rollup replacement and failure preservation, subscription review-state preservation, deletion of account A's finance data and AI state, and survival of account B's data. The test rolls back.
- `lib/report/monthly.test.ts` asserts exact report totals (4,000-cent gross outflows, 500-cent refunds, 3,500-cent net spend and 100,000-cent income), a 500-cent/16.7% comparison, coverage, corrected transaction evidence and rejection of a mid-read revision change.
- `lib/batch/rollups.test.ts` aggregates 1,201 synthetic transactions across the Supabase 1,000-row pagination boundary and checks the exact total. This is a correctness regression, not a production or end-to-end import latency measurement.
- `lib/agent/chat-request.test.ts` covers streamed body byte limits, message/context limits, malformed turns and UUID conversation identifiers. `lib/contracts/receipts.test.ts` ensures provider failure is explicitly routed to manual entry rather than a success-shaped empty extraction.
- Prompt boundary tests cover malicious merchant/transaction text as untrusted evidence. Cutback-output tests verify malformed structured output raises an error rather than returning an empty success.
- No live model explanation was verified. The deterministic report remains independent of provider availability; direct explanation failures are surfaced with a retry path.
- Synthetic sample screenshots from the earlier baseline: [desktop](./screenshots/sample-review-desktop.png) and [mobile](./screenshots/sample-review-mobile.png).

## Performance, cost, and limitations

- The historical authenticated browser import used 6 rows; the review-fix revision has not been browser-benchmarked. The mocked 1,201-row rollup test is not a hardware latency measurement, and no representative p95 benchmark was run.
- Local pgTAP reported 33 assertions in under one wall-clock second. This is a correctness test, not a production latency target.
- No live model/search call was made for this review-fix verification, so no provider charge was incurred. Per-user storage cost, model cost and deployed p95 are unmeasured. The server AI quota is a request limit, not a spend cap or provider-spend alert.
- Anna CLI/runtime/account are unavailable. There is no Anna bundle, login/persistence/isolation journey or platform review.
- No interviews, beta participants, marketplace submission/approval, qualified-user metrics or growth outcomes were performed or claimed.
- Receipt-object deletion was not tested with an uploaded object in this review-fix run; SQL metadata and finance-data/AI-state deletion were tested. Provider backup erasure is outside the app's proof boundary.
