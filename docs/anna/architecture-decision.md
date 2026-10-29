# Architecture decision and Anna integration gate

**Date:** 2026-10-28 | **Status:** Standalone architecture retained; Anna runtime integration is blocked and unverified.

## Decision

Keep the existing Next.js application, Supabase/Postgres persistence, row-level security, and pure TypeScript finance logic as the working standalone architecture. Do not rewrite the backend or treat Anna authentication as a Supabase identity.

No Anna app bundle, manifest, Executa, JWT exchange, or account-linking implementation is included. The Anna-facing architecture remains undecided until a documented, testable user-scoped persistence and identity path is available. Preserve the standalone product while the gate is open.

## Evidence reviewed

Official Anna documentation was consulted on 2026-10-28:

- [Anna App UI SDK](https://anna.partners/developers/apps/app-ui-sdk.md), updated 2026-10-23: `AnnaAppRuntime.connect()` binds an iframe window to a host-managed token and handles host token refresh. It documents the runtime storage proxy and says the production default is per-app storage for runtime state.
- [Anna App UI Host API](https://anna.partners/developers/apps/app-ui-host-api.md), updated 2026-10-23: documents RPC authorization and storage calls. Its storage method table lists `get({ key })`, `set({ key, value, ... })`, `delete({ key, ... })`, and `list({ prefix, cursor, limit })`. The same page describes the production default as APS `scope='app'`, `owner_id=window.app_id`.
- [Anna App Manifest](https://anna.partners/developers/apps/app-manifest.md), updated 2026-10-14: schema 3 can declare `storage.scopes.user = "rw"` and other storage capabilities.
- [Bundling Executas](https://anna.partners/developers/apps/app-bundling.md), updated 2026-04-22: UI assets use a static bundle pipeline; Executa dependencies are declared references, not bundled source.
- [Anna Developer Hub index](https://anna.partners/llms.txt): identifies the current app UI, Host API, manifest, CLI and storage references.

The docs establish an iframe runtime, host-bound token, and a user-scope declaration. The documented storage-call argument table does not establish how an app selects or addresses the user scope for private financial records. No documented Anna-to-Supabase identity bridge was found. The local environment does not contain `anna-app` or `uv`, and no Anna account/runtime session was configured.

## Rejected for now

- **Invented identity bridge:** rejected because it could authorize the wrong Anna user or trust a browser-supplied identity.
- **App-scoped APS for personal finance rows:** rejected because the documented default is app-owned scope, not an established per-user partition.
- **A native Anna rewrite without a runnable host:** deferred; it would not prove identity, storage scope, quotas, or user isolation.
- **Shipping the Next.js server as a static Anna bundle:** rejected; the app depends on authenticated server routes and Supabase.

## Gate to reopen

Obtain a configured Anna development account/runtime and CLI, then verify from current official documentation or a platform-confirmed example:

1. The exact supported storage API contract for per-user data, including the scope selection, ownership enforcement, pagination, quotas, and behavior after logout.
2. Whether the app can call the authenticated Supabase backend; if so, the supported identity/session exchange, issuer, audience, expiry, server-side ownership mapping, logout, and revocation behavior.
3. If the external backend is unsupported, the preselected fallback is a minimal Anna-native adapter over the same pure finance logic, while retaining the standalone backend.
4. A real synthetic import/read/report and two-user isolation journey in the configured Anna runtime.

Until then R1 and Anna-specific R7/R9 acceptance remain incomplete. No integration approval, Anna publication, or marketplace outcome is claimed.

## Rollback and impact

There is no Anna-specific production data path to roll back. The standalone app and its Supabase schema remain the only implemented persistence path. Any future Anna adapter must be separately reviewed and must not weaken RLS or replace the session-bound server client with a service-role or browser-owned identity.
