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
| Chat message | 2,000 characters |
| Tool-call loop | 5 total steps |
| Transaction tool result | At most 50 rows |
| Supabase history scan | 1,000-row pages, ordered scans |

The report is calendar-month-only and each account confirms one dataset currency (USD, PKR, EUR, or GBP). No FX conversion is applied. Full-month coverage requires explicit user confirmation plus a completed import whose recorded coverage spans the calendar month. A report remains blocked while a derivation revision is incomplete.

These are not a full rate-limit or abuse-control policy. No server-side request-rate quota or provider spend alert was verified. Add one before enabling public/deployed model traffic.

## Local setup, migrations, and recovery

```sh
pnpm install --frozen-lockfile
pnpm db:start
supabase migration up --local
pnpm dev
```

Apply forward migrations; do not use `pnpm db:reset` against a database containing work to preserve. The current local checkout has migrations through `20261028104500_redacted_analytics.sql` applied. In a separate disposable test environment, run:

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
