# Operations and limits

## Configuration names

Provide configuration through the local/deployment secret manager. Never commit values:

- Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- Model selection: `ROUTER_MODEL`, `REASONING_MODEL`, `VISION_MODEL`.
- Provider credentials when enabling those features: `GOOGLE_GENERATIVE_AI_API_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`.

The service-role key is server-only. Request handlers use the session-bound Supabase client and RLS. Do not authorize using a browser-supplied user ID.

## Current enforced limits

| Input/read | Bound |
|---|---:|
| CSV upload | 4 MiB |
| CSV data rows | 10,000 |
| Receipt image | 4 MiB |
| Chat request body | 256 KiB, streamed and capped before parsing |
| Chat messages / context | 40 messages / 20,000 aggregate text characters |
| Latest chat message | 2,000 characters |
| Tool-call loop | 5 total steps |
| Transaction tool result | At most 50 rows |
| Supabase history scan | 1,000-row pages, ordered scans |
| Concurrent account writes | One durable 90-second account lease, renewed every 20 seconds while the handler is active |
| Concurrent account AI requests | One 45-second lease |
| AI requests per account | 12 per hour by default; `FINANCE_AI_REQUESTS_PER_HOUR` accepts 1–60 |

The report is calendar-month-only and each account confirms one dataset currency (USD, PKR, EUR, or GBP). No FX conversion is applied. Full-month coverage requires explicit user confirmation plus a completed import whose recorded coverage spans the calendar month. A report remains blocked while a derivation revision is incomplete.

Receipt-only accounts may establish dataset currency by selecting it in the receipt confirmation draft. If a legacy account has an unset currency and historical transactions contain mixed or missing currencies, the app blocks currency confirmation rather than guessing or converting those rows. This legacy state requires explicit data resolution before reporting.

The hourly AI quota applies to chat, report explanations, receipt extraction, and model-backed tools. It counts reservations even when a provider call fails. There is no provider-spend alert or hard monetary cap, and model-provider billing remains separate from this request quota. Review the configured quota and provider billing limits before enabling public/deployed model traffic.

## Local setup, migrations, and recovery

```sh
pnpm install --frozen-lockfile
pnpm db:start
supabase migration up --local
pnpm dev
```

Apply forward migrations; do not use `pnpm db:reset` against a database containing work to preserve. The current schema includes atomic rollup replacement/write-lock, import-overlap review, server-side AI quotas, AI-slot cleanup, and durable report-generation snapshots through `20261028121500_dataset_revision_snapshots.sql`.

The 90-second write lease is renewed by a Node timer every 20 seconds while the request event loop is responsive. Next route handlers that mutate financial data declare a 60-second `maxDuration` (30 seconds for receipt extraction). This metadata is enforced only by compatible hosting runtimes; local/self-hosted deployments do not get a hard request deadline from Next. The heartbeat protects long operations while the process remains live, but process pauses longer than the lease can allow lease expiry; if renewal fails, the request reports failure rather than claiming successful lock release. Keep local mutation requests bounded and do not treat the lease as a fencing token against a stalled process resuming after expiry. Database reports capture the durable generation before reads and verify it after reads, rejecting mixed snapshots.

The local verification previously ran 33 pgTAP assertions; the snapshot migration adds lock-generation/renewal assertions. In a separate disposable test environment, run:

```sh
supabase test db supabase/tests/rls_and_deletion.sql --local
pnpm test
pnpm lint
pnpm build
pnpm typecheck
```

Run typecheck after build because Next generates `.next/types` during build. Failed imports/corrections leave a failed revision and are not represented as a current report; use **Retry recomputation** after the underlying cause is corrected. Re-export before account deletion if a user needs a copy.

## Privacy and telemetry

Analytics accepts a constrained event allow-list, event key, mode, revision, source/campaign, duration, and enumerated error code. It does not accept transaction amounts, merchant text, descriptions, filenames, prompts, receipt contents, or financial payloads. The user hash is pseudonymous, not anonymous. Sample events use sample mode and must not be interpreted as acquisition or official Anna counts.

Review app logs and any future error-reporting integration for the same redaction boundaries before deployment. Never paste secrets, session URLs, personal statements, or account exports into issue trackers.

## Export, deletion, and rollback

- Export is machine-readable JSON with schema/version metadata and source fields, normalized transactions, overrides, reviews, and redacted events.
- Deletion requires exact UI confirmation, removes receipt objects first, then calls the user-scoped deletion RPC. If receipt removal fails, database records remain. The sign-in account is intentionally retained.
- The app cannot prove erasure from provider backups. State the limitation to the user.
- Schema changes are forward migrations. Roll back application code only when compatible with the migrated schema; use a reviewed compensating migration for schema changes. Never erase local or production data to recover a test.

## Deployment gate

Do not deploy/advertise the Anna edition until the R1 identity and per-user storage gate is resolved, provider keys are intentionally configured, rate/spend controls are reviewed, and the complete target runtime is tested. No production deployment is part of this verification record.
