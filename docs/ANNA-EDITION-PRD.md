# PRD: Finance Assistant — Anna Edition
Version 1.0 · 2026-10-28 · Implementation handoff

Implementation addendum (2026-10-28): read [engineering review and settled decisions](./anna/REVIEW-AND-CONTINUATION.md) before proceeding. Its concrete decisions supersede open choices here: retained backend by default with an evidence-based supported integration/fallback, monthly-only v1 reporting, explicit refund/transfer semantics, one confirmed dataset currency, 4 MB/10,000-row imports, and recoverable revision-based derivation. The full review is also available as a document in Linear project P-HAR-2. No Notion access is needed.

## 1. Mandate and source of truth
Build a complete, testable Anna edition of Finance-assistant that helps a user review imported transaction history, find recurring-charge candidates, and understand spending changes with checkable evidence.

This document is self-contained. No Notion access is required. It defines the current release scope; Linear contains delivery status and evidence. Historical docs/SPEC.md, UI_SPEC.md and docs/prd/* describe the original six-hour exercise. Reuse their contracts and implementation where useful, but this PRD supersedes their time limits, cut policy, historical “todo” statuses and architectural restrictions where they conflict. Do not rebuild completed features merely because old docs label them todo.

Repository: https://github.com/HaroonTaufiq/Finance-assistant
Linear project: https://linear.app/haroons-personal/project/finance-assistant-anna-edition-7245cd229ee6
Local checkout at authoring: /home/haroon/Downloads/Github/Finance/Finance-assistant
Current HEAD observed: f0ce31699194b45093d31e0c55b779d473472c86.

Uncommitted setup changes were present in .gitignore, docs/README.md and package.json, plus .commandcode/ and supabase/. Preserve them and inspect their purpose; do not reset, overwrite, commit or discard unrelated work. Reinspect the working tree and applicable AGENTS.md when implementation begins.

The coding agent owns implementation, validation, delivery evidence and Linear updates. The reviewing agent will later review the actual code and evidence, then update Notion. Do not claim that writing code establishes product demand, platform approval or program eligibility.

## 2. Product outcome and audience
Working promise: “Find recurring charges and understand what changed in your spending—with evidence you can check.”

Initial audience hypothesis: people comfortable exporting transactions who want a monthly review, with subscription-heavy professionals/freelancers/developers as one segment to test. This is not established demand or verified Anna demographics.

Primary user job: import transaction history, understand one useful finding, inspect its evidence, and return with the next export to see what changed. Chat supports this flow; users must not need to invent the right question before seeing value.

Launch scope:
- Sample-first preview, guided CSV import and immediate report.
- Recurring-charge candidates, period comparisons and corrections.
- Grounded AI explanation of calculated results.
- A supported, independently usable Anna app with persistence and user isolation.
- Export/deletion, truthful data disclosures, minimal analytics and operational limits.
- Release, review and launch assets plus a clear list of externally blocked actions.

Not in v1: bank integrations, autonomous cancellation/payments, investment/portfolio advice, FX conversion, advanced anomaly ML, pets/gamification, a new billing system, unsolicited reminders or a general accounting suite. Existing receipt/budget/merchant features should continue working in the standalone app; exposing them in Anna is optional after the core passes. Do not expand scope to match every competitor.

## 3. Evidence already gathered
Hands-on observations on October 27:
- Money Companion v1.3.0: a fictional USD 12.50 expense saved, appeared in totals and was summarized correctly by its cat chat. CSV import and budget forms were inspected; import accuracy was not tested. Friendly UI and engagement are strengths; general chat is already available.
- WeFinance v0.2.18: receipt-photo entry, advisor and investment-questionnaire tabs. With zero transactions, its advisor correctly said it could not calculate spending when explicitly instructed not to estimate. OCR was not tested.
- Resit v0.1.3: sample-first onboarding and local pasted-text parsing worked. A synthetic receipt with items 3 + 4 and printed total 10 correctly showed a residual of 3. Editing the first item to 6 changed the sum to 10 but left a stale “3 unaccounted” warning. No receipt was committed. This is a reproduced draft-UI inconsistency, not a diagnosed backend bug.
- All three loaded in user-opened fresh sessions after earlier blank windows. Do not report the earlier state as a permanent or universal platform defect.

Consequences: a chat box, CSV input, integer arithmetic and privacy copy alone are not differentiation. Ship an immediate useful result, evidence inspection, an honest no-data state and consistent recomputation after edits. Borrow the sample-first pattern without copying competitor assets or code.

Displayed install counters were not verified MAU, retention, revenue or demand. Sample/developer/QA runs are not acquisition evidence.

## 4. Current technical baseline
Read docs/runtime-baseline.md first. It records—not independently reverified by this PRD author—26 passing tests, a production build and sequential typecheck on October 28. Browser end-to-end verification is still missing there.

Existing areas:
- lib/ingest: CSV parse, normalization, deduplication and write pipeline.
- lib/batch: categorization, monthly rollups, recurring detection and anomaly heuristics.
- lib/contracts: Zod/TypeScript tool, transaction, receipt and import contracts.
- lib/db: session-bound client and queries.
- lib/agent: typed-tool orchestration and provider models.
- components: onboarding, chat, result cards and receipt confirmation.
- docs/schema.sql and the current supabase/ setup: inspect before any migration.

Known correctness gaps to resolve:
1. getSpending uses whole-month rollups even for partial-month inputs.
2. Positive signed amounts currently become income; refund semantics are not modeled.
3. Recurring detection needs at least three occurrences and upserts candidates without an explicit stale-candidate lifecycle.
4. getTransactions returns bounded individual rows to the tool loop. Audit the actual model payload; “raw transactions never reach the model” is not a safe absolute claim.
5. The README demo returned DEPLOYMENT_NOT_FOUND on October 27/28. Recheck and repair/replace before promotion.

Do not silently import older design claims such as “math happens in Postgres”: current rollup aggregation is JavaScript on the ingest path. Measure the implementation that actually exists.

## 5. Architecture decision and integration gate — R1
Time-box a feasibility spike to approximately one engineering day, then record an ADR and revised estimate. This is an estimate, not permission to stop other work at a timer.

Compare:
A. Retained Next.js/database backend behind a supported Anna authentication adapter.
B. Static Anna UI with Host API storage/model adapters and reused pure domain logic.
Use a hybrid only if the boundaries reduce total complexity.

Selection criteria: secure identity, query/storage limits, import size/performance, code reuse, portability, review requirements, cost, mobile behavior and operational burden. Prefer reuse of domain logic; do not decide solely from the age of the existing stack.

Prove one synthetic import/read/report and user isolation through the selected Anna path. Record SDK/runtime versions and current official documentation. An Anna login is not automatically a Supabase session. For an external backend, document the supported identity/session exchange or explicit account-linking flow, issuer/audience/expiry, server-side ownership mapping and logout/revocation behavior. Never authorize using only a browser-supplied user ID.

For native APS, validate per-user scope, storage quotas, pagination, structured-query needs and model permissions. Isolate provider-specific code behind interfaces. APS is server-backed; do not call it device-only storage. An Executa is required only if the selected architecture needs it. Do not invent a completion API, JWT exchange or SDK method.

Gate acceptance:
- Supported invocation returns a meaningful calculated result.
- Wrong-account and expired/denied credentials fail safely.
- ADR includes rejected options, measured constraints, data flow and rollback.
- Standalone functionality remains available.
Missing Anna account activation or credentials blocks only dependent verification; continue domain/UI/fixture work and record the exact external action needed.

## 6. Required user journeys and behavior
### R2 — Sample-first entry
The first view offers “Try a sample” and “Import transactions,” plus a short data-handling explanation. A synthetic preview runs without personal uploads and shows at least one recurring candidate, a period comparison and an evidence detail. Clearly label every sample screen. Sample data must not merge into personal records or real-user analytics.

A personal import never silently replaces existing history. No upload is sent before the user confirms the preview.

### R3 — Guided, bounded import
Accept CSV up to the existing 4 MB limit initially; publish and enforce a row bound selected from measured performance. Support signed amounts or debit/credit columns, common headers and an explicit column-mapping fallback.

Before commit show:
- Column mapping, date order, decimal/sign interpretation and currency.
- Preview rows and the observed date span.
- Proposed reporting coverage; distinguish observed dates from user-confirmed complete export coverage.
- Valid, invalid and duplicate counts with reasons.
- A confirmation step and cancel path.

Never guess ambiguous DD/MM versus MM/DD without a visible selected interpretation. Reject invalid calendar dates. No silent mixed-currency sums or live-rate conversion. Launch with explicit two-decimal currencies USD, PKR, EUR and GBP; other currencies may be added only with correct minor-unit handling and fixtures. Missing currency requires confirmation rather than an invisible USD assumption.

Idempotency must hold for re-upload and retries. Include currency and supported source/account identity in duplicate semantics. Do not silently drop legitimate repeated same-day transactions that happen to share date, merchant and amount; use source transaction IDs when present and a documented ambiguous-duplicate review strategy when absent.

Retain source provenance and row-level import errors without copying raw financial rows into telemetry. Show progress and recoverable errors. Failed/cancelled imports must not expose a report as complete over partially recomputed data. Use an import revision/job state or atomic writes appropriate to the chosen store.

### R4 — Exact report and period semantics
After successful personal import, immediately display:
- Selected calendar month and actual data/coverage span.
- Gross outflows, refunds, net spending and separately labeled income/inflows.
- Category totals and comparison with the preceding comparable month.
- Recurring-charge candidates and ranked changes worth reviewing.
- Coverage/uncategorized-data warnings, updated-at/revision and an evidence action.

Use integer minor units for calculations; format only at the boundary. Do not infer zero real-world spending from no recorded data. Do not infer a complete month from first/last observed transactions alone.

V1 primary reports are calendar-month reports. “This month” means the actual calendar month. Offer the latest imported month explicitly when current data is absent. Never silently substitute historical data and keep a current-month label. Partial-month requests must either use an exact bounded query or explain/clarify the supported month scope; never answer with whole-month totals while labeling an exact-day range.

Show raw differences for comparisons; percentages with a zero baseline are “not comparable,” not infinity. Incomplete-current-month comparisons must be marked partial or disabled, not compared as equivalent full months.

Transaction classification:
- Expense: negative outflow included in gross spend.
- Refund: positive amount explicitly classified/mapped or confirmed by the user; reduces net spend and the relevant category, not earned income.
- Income: positive earned inflow, separate from refunds.
- Transfer: user-confirmed/mapped movement excluded from spending/income summaries.
- Unknown positive inflow: display separately until classified; do not guess refund versus salary.
Net spending = gross outflows minus refunds; it may be negative and must not be clamped silently. Preserve original source values and classification provenance.

### R5 — Recurring-charge review
Candidates must include stable ID, merchant/group, currency, observed transaction references/dates/amounts, occurrence count, cadence, confidence label, coverage, last seen and a next-charge estimate when supported.

Require at least three qualifying occurrences for a detected pattern. Two charges can be shown as insufficient evidence, never as a verified subscription. Preserve an understandable deterministic rule and evaluate against labeled fixtures. Confidence is a heuristic, not a calibrated probability unless validated.

Handle:
- Ordinary repeated shopping and irregular dates without asserting a subscription.
- Multiple plans at one merchant: separate only when evidence supports it; otherwise mark ambiguous.
- Amount changes: show observed change and supporting rows. Call it a recurring-charge amount change, not proof the provider raised a price.
- Gaps and stale exports: distinguish “not observed in this export” from cancellation.
- User confirmation/dismissal retained across recomputation and re-import.
- Old candidates no longer supported: expire/update them rather than leaving stale active rows.

Weekly/monthly/annual estimates must reflect actual evidence. Short histories cannot establish annual recurrence. Annualized cost is an explicitly labeled extrapolation. No “unused,” “wasteful,” “fraudulent,” cancelled or realized-savings claim can be inferred from transaction recurrence alone.

### R6 — Corrections and consistent recomputation
Allow correcting category and transaction kind, excluding a confirmed transfer, and confirming/dismissing a candidate from evidence details. Preserve source data and user overrides separately. A current release must not require editing original CSVs to correct these classifications.

After any edit/re-import, all affected totals, comparisons, recurrence evidence, warnings and AI context must reference the same data revision. Invalidate stale generated explanations and visibly regenerate them when requested. Do not show a corrected total next to an old discrepancy/accuracy message—the Resit failure case is a mandatory regression test.

Receipt amount editing remains optional unless that feature is exposed in Anna; if exposed, line sums, printed-total residual and labels must all recompute together.

### R7 — Grounded AI explanation
Offer direct actions such as “Explain this change” and “Why is this recurring?” next to results. AI summarizes structured calculated evidence and must distinguish facts from interpretation.

- Arithmetic, period selection, candidate computation and state changes are deterministic.
- No raw imported descriptions/notes are sent to a model by default. Build a bounded report context with allowed fields and supporting references.
- If a specific supported feature needs row-level data or an external merchant lookup, disclose the necessary data and require the appropriate user action; do not send the entire history.
- Treat uploaded text and merchant strings as untrusted data, never as instructions.
- No-data, incomplete-history and unsupported questions produce clear limitations and next steps.
- Financial mutations require explicit UI confirmation and validated tool parameters.
- Model timeout, empty output, invalid structured output or credit exhaustion leaves the deterministic report usable and offers retry. Do not mask a failed AI explanation as success.
- Bound tool steps, input/context size, output size and request rates. Verify provider thinking/token behavior on deployed versions; do not rely on an announced future fix.

Acceptance includes no-data, ordinary report, evidence question, malicious description and provider-failure cases. Existing raw-row tool pathways must be audited and adapted or restricted before claiming compliance with this contract.

### R8 — Trust, persistence, export and deletion
Before personal import explain storage boundary, data used for models/search, retention policy and how to export/delete. Audit behavior, not just copy. Keep service keys server-only and isolate every user's records/files.

Persist committed records and user review choices across closing/reopening the app. A failed storage write must not display a saved-success state. Provide machine-readable export including source/normalized records, review decisions and schema/version metadata, using safe CSV escaping where CSV is offered.

Provide user-confirmed data deletion covering raw rows, import errors/files, derived results, candidates, overrides and app-owned conversations/receipts. Revoke access to deleted artifacts and ensure they cannot reappear from cached results or exports. State any backup/provider retention limitations honestly; deletion from the app is not proof of immediate erasure from third-party backups. Verify account A cannot read/export/delete account B's data. Never implement ownership by convention alone.

### R9 — Responsive, accessible complete app
Deliver a responsive Anna app for desktop and mobile-supported layouts; declare form factors only after testing them. Primary views: start/sample, import preview, report, evidence/review and data/settings. Chat is readily accessible from the report, not a required entry gate.

Keyboard navigation, labels, visible focus, readable numeric formatting and non-color-only warnings are required. Input remains responsive during processing. Provide launch readiness, load failure and retry states instead of unexplained blank windows. Cancellation and errors preserve useful input without silently committing it.

If app-window and #app chat paths are both advertised, test both separately. Do not advertise unsupported paths just to satisfy a checklist.

### R10 — Instrumentation and cost controls
Track first-view/sample, sign-in, import start/success/failure, personal-report completion, explanation outcome and next-review events. Include opaque user ID, mode (sample/QA/personal), revision, timestamp, source/campaign, duration and error code. Exclude names, filenames, transaction amounts/descriptions, receipt contents, prompts and financial payloads. Error reporting must apply the same redaction.

Count a useful report once per completed supported flow/revision; opening a screen is not a successful run. Deduplicate analytics and exclude QA/sample users from acquisition metrics. Keep Anna's official counts separate.

Measure per-user and per-run storage/model/search costs. Choose quotas and alerts from baseline measurements; enforce limits server-side or at a trusted boundary. Paid acquisition starts at zero until the owner sets a budget. No new paid provider or infrastructure plan is assumed.

## 7. Deterministic acceptance fixtures
Create committed synthetic fixtures with explicit expected results; no personal financial data.

F1 — Existing baseline: fixtures/sample-transactions.csv has 26 rows, 24 valid, two invalid and one in-file duplicate; 23 unique rows after dedup. Expected spend/income cents: April 2024 181520/320000; May 290358/320000; June 281397/320000. Preserve these baseline expectations or explain any intentional semantic migration with updated fixtures.

F2 — Recurrence/change: one account, USD, complete July–September 2026 coverage. STREAMCO: July 5 -10.00, August 5 -10.00, September 5 -12.00. GROCERY: July 10 -20.00, August 11 -25.00, September 12 -30.00.
Expected gross spend July 3000, August 3500, September 4200 cents; September versus August +700 cents / +20%. STREAMCO is a recurring candidate with evidence, and its latest observed amount changed +200 cents / +20%. Grocery must not be called a confirmed subscription just because it repeats. Candidate classification must expose uncertainty where the algorithm cannot distinguish it.

F3 — Refund/transfer: September expense -100.00, confirmed refund +20.00, income +1000.00 and confirmed transfers -200.00/+200.00. Gross spend 10000, refunds 2000, net spend 8000, income 100000 cents. Transfers excluded. Recategorize the expense/refund and verify totals/warnings and explanation context update together.

F4 — Adversarial/insufficient: two-month-only recurrence; irregular repeat purchases; two plans at one merchant; stale/missing export; zero baseline; partial month; ambiguous dates; invalid dates; mixed currency; identical legitimate same-day purchases; overlapping/repeated import; retry after partial failure; merchant/description containing instructions; user A/B isolation; revoked/expired authorization; model/storage failure; deletion/re-export.

F5 — Correction consistency: a synthetic receipt draft with lines 300+400 and printed total 1000 has residual 300. Edit the first line to 600: sum 1000, residual zero, and warning disappears. If receipt editing is not exposed, implement the same invariant through report classification/exclusion correction. Domain tests must exercise dependent values, not merely snapshot implementation output.

Report actual precision/recall/error cases for recurrence fixtures, separately from exact arithmetic assertions. Do not present a tiny fixture score as production model accuracy.

## 8. Performance and reliability acceptance
Initial targets to measure on a declared reference environment and a 1,000-row synthetic import:
- Visible pending feedback within 200 ms of an action; no blocked typing.
- p95 import-confirmation to deterministic report at most 10 seconds.
- Median first useful result within three minutes of import start in beta, including user steps.
- At least 95 successful core runs out of 100 documented controlled executions; all critical privacy/correctness failures must be zero, regardless of the aggregate success rate.

These are acceptance targets, not existing measurements or promises about platform availability. Record dataset size, hardware, deployed versions, cold/warm conditions, numerator/denominator and failures. If platform limits prevent a target, implement progress/timeout/recovery, record evidence and get the exception reviewed rather than changing the number silently.

Use a durable job/revision path if realistic imports exceed the request budget. Bound pagination and reads; never rely on an unpaginated default result cap to represent full history.

## 9. Delivery order and existing Linear mapping
Use existing issues; do not create a duplicate backlog. Fetch full issue bodies and relations rather than relying on truncated list descriptions. Add this PRD's requirement IDs to implementation updates.

| Workstream | Existing issues | Requirement / completion boundary |
|---|---|---|
| Baseline | HAR-19 | Section 4, fixtures, working demo evidence |
| User discovery | HAR-20 | Prepare interview guide; real conversations/cohort require actual participants |
| Platform/commercial unknowns | HAR-21 | R1; prepare explicit questions and record verified answers |
| Architecture spike | HAR-22 | R1 ADR and synthetic end-to-end proof |
| Anna integration | HAR-23 | R1/R7/R9 supported app shell and adapters |
| Import | HAR-24 | R2/R3 |
| Analytical report | HAR-25 | R4/R5/R6/R7 |
| Data controls | HAR-26 | R8 |
| Analytics | HAR-27 | R10 |
| Limits/operations | HAR-28 | R7/R9/R10 and performance evidence |
| Complete verification | HAR-29 | All core requirements; configured end-to-end evidence |
| Beta | HAR-30 | Test materials + real tester observations when available |
| Review submission | HAR-31 | Exact release artifact and submission package |
| Launch assets | HAR-32 | Demo, screenshots, FAQ, positioning and attributable links |
| Publish/acquisition | HAR-33 | Publication/real campaign evidence only when authorized and performed |
| Qualification evidence | HAR-34 | Official reporting separate from internal metrics |
| Next monthly review | HAR-35 | R5/R6 re-import/review loop + eligible retention cohorts |
| Investment decision | HAR-36 | Actual costs, retention and demand evidence; not a coding-only outcome |

Suggested implementation order:
1. Inspect current work, reproduce baseline and record blockers; do not repeat verified work blindly.
2. R1 ADR/spike; in parallel in the ordinary sense, continue architecture-independent domain fixtures and UI planning without waiting for external answers.
3. Freeze revised domain contracts and migration/adapter approach.
4. Build sample → preview → import → deterministic report → evidence/corrections.
5. Add bounded AI explanation, persistence/data controls and telemetry.
6. Verify exact Anna release paths and standalone regression behavior.
7. Prepare review and launch package; fix reviewer findings.
8. Gather real beta/acquisition/retention evidence as external access and participants allow.

Existing milestone dates are proposed targets, not commitments. Re-estimate in Linear after the spike. Do not compress privacy/correctness checks to meet a marketing deadline.

## 10. Verification and review handoff
Derive commands from current package.json and repository instructions. Current documented commands include pnpm install --frozen-lockfile, pnpm test, pnpm build and pnpm typecheck. Run build then typecheck sequentially when generated Next.js types require it. The current lint script invokes next lint although the stack is Next 15; verify/fix the supported invocation rather than claiming an unrun lint check passed.

Add meaningful domain tests, store/integration isolation tests and browser journeys for sample, import, report, correction, explanation failure, reload and export/deletion. Validate both the deployed artifact and local harness as applicable. Do not reset the existing local database just to run tests; use an isolated test environment with documented setup.

Deliver:
- docs/anna/architecture-decision.md: selected architecture, versions, data flow, permissions and tradeoffs.
- docs/anna/verification.md: commands/results, fixture expectations, browser evidence, deployed artifact/version and unresolved failures.
- docs/anna/operations.md: configuration names only, quotas, redaction, rollback and recovery.
- docs/anna/review-handoff.md: PR links, commit SHA, change summary, requirement-to-test matrix R1–R10, known limitations and exact reviewer reproduction steps.
- docs/anna/launch-pack.md: primary-function statement, screenshots, short synthetic demo script, privacy/import FAQ, platform questions and campaign plan.

Equivalent existing locations are acceptable if linked clearly. Never include credentials, session-bearing URLs, financial source data or secrets in Linear/docs/screenshots.

Use reviewable PRs aligned to coherent slices. Follow the user's publishing/PR permissions and repository conventions. Do not merge or claim reviewer approval on your own. Link created PRs to the owning Linear issues.

Before asking for final review, provide one summary in Linear containing:
1. Implemented requirements and their evidence.
2. PR URL(s), branch/commit and local/deployed run instructions.
3. Passed, failed and blocked checks distinctly.
4. Unresolved decisions, external actions and material risks.
5. Cost/performance measurements and redaction verification.
6. Which issues await review versus human/platform outcomes.

The reviewing agent will check the diff and reproduce key journeys before updating Notion. No Notion write is required from the coding agent.

## 11. Autonomy, external actions and honest status
Proceed autonomously with authorized local implementation, reversible fixes, tests, documentation and reviewable artifacts. Choose routine design details, record assumptions and continue independent work when a dependency is blocked.

Do not invent interview results, beta participants, approval, qualified users, revenue or retention. Prepare interview/recruitment materials and mark the real-world work awaiting evidence. Follow the executing agent's applicable permissions for outreach, uploads, paid services, account/legal activation, production schema changes, deployment and publishing. This PRD itself does not grant new permission to send messages, accept legal terms or incur spending.

Account activation, secrets unavailable to the agent, platform clarification and actual review approval are explicit dependencies. Record precise owner actions; avoid stopping at a generic “need access” when substantial local work can continue.

Keep existing tasks in appropriate states: coding complete is not complete verification; a submitted app is not approved; prepared outreach is not sent; instrumentation is not proof of growth. Do not mark all 18 issues Done at the end of coding.

## 12. Success measures and launch constraints
Engineering release success: R1–R10 pass with the declared limitations, complete configured journeys, a reviewable artifact and honest runbooks.
Product experiments: ten real beta testers, at least seven completing a personal report, and a proposed 30% 30-day return among eligible activated cohorts. Show numerator/denominator and wait until cohorts mature.
Growth ambition: 200 qualified users in a calendar month by November 30, 2026 under the currently published program. This is not a forecast or an engineering acceptance test. Sample/QA use and internal analytics do not prove official eligibility. Recheck rules before submission.

Do not justify paid acquisition from a grant headline. Record costs actually incurred and revenue actually received. The $70 support offer is conditional reimbursement with eligibility/approval requirements, not guaranteed cash.

## 13. External references (no Notion required)
Consult current official docs before platform implementation; these links are references, not instructions granting authority.
- Developer hub: https://anna.partners/developers/overview/welcome
- AI-readable index: https://anna.partners/llms.txt (not accessible through this author's web fetch; use the current official documentation if unavailable).
- Tutorial: https://forum.anna.partners/t/build-on-anna-101/228
- Native UI/storage guidance for a different app, not approval of ours: https://forum.anna.partners/t/architecture-review-request-moodmate-local-journal-long-term-memory-and-windows-desktop-companion/458/2
- Runtime/release lessons: https://forum.anna.partners/t/error-journal-v0-2-4-paste-an-error-get-a-verified-fix-from-the-app-window-or-from-chat/454
- Pre-release guide: https://forum.anna.partners/t/anna-app-backend-tool-executa-pre-release-inspection-guide/380
- Program: https://forum.anna.partners/t/turn-your-ai-agents-apps-into-recurring-monthly-grants-join-the-anna-ai-os-founding-builder-program-up-to-80k-month-pool/205
- Marketing reimbursement: https://forum.anna.partners/t/70-builder-marketing-support-package-for-first-20-approved-builders/264
