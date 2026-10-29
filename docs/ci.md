# Continuous integration

`.github/workflows/ci.yml` runs on pull requests targeting `main`, pushes to
`main`, and manual dispatch. Both jobs must pass before merging:

- **App checks:** frozen pnpm install, unit/route tests, lint, production build,
  then typecheck (the build generates Next's route types).
- **Database checks:** pinned Supabase CLI starts a fresh Docker stack, applies
  the forward migration chain, verifies migrations are current and runs the
  transactional pgTAP isolation/recovery suite. The runner's disposable data
  is removed afterward, including on failure.

Actions are pinned to commit SHAs. Workflow permissions are read-only, checkout
credentials are not persisted, and no repository secrets or linked Supabase
project are needed. The app build uses nonsecret placeholder configuration;
database tests use only the hosted runner's local synthetic data. Do not point
this workflow at a production database or add production provider credentials.

The workflow does not deploy, call live AI providers, validate Anna integration,
or substitute for authenticated browser acceptance. Local checks are documented
in `docs/anna/verification.md`; never run the CI cleanup command against a
developer database containing data to preserve.
