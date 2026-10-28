# Launch and research pack

Status: prepared materials only. No user outreach, beta, spend, marketplace submission, approval, or public campaign is claimed.

## Primary-function statement

**Find recurring-charge candidates and understand what changed in your spending—with evidence you can check.**

The initial audience is a hypothesis: people who can export transaction history and want a useful monthly review. It is not a validated segment or demand claim.

## Synthetic demo

Use the standalone sample page and the clearly synthetic [desktop screenshot](./screenshots/sample-review-desktop.png) or [mobile screenshot](./screenshots/sample-review-mobile.png).

1. Open `/sample`; point out the “SAMPLE ONLY” banner and that no sample data is saved to a personal account.
2. Show March gross outflows $99.49, refunds $5.00, net spend $94.49, income $3,000.00, and unclassified inflows $10.00.
3. Compare February's $64.99 net spend with March's +$29.50 / +45.4% change.
4. Inspect the STREAMCO candidate: three observations, listed dates/amounts, and the explicit `heuristic_pattern_not_verified` label.
5. Explain that the personal import flow is available in standalone, but Anna identity/storage integration is not configured or verified.

## Privacy and import FAQ

- **Does the sample use real account data?** No. It is synthetic and clearly labeled.
- **What happens to my CSV?** After import confirmation, it is stored with the signed-in Finance Assistant account and used for deterministic reports. The preview runs locally before upload.
- **Is the raw CSV sent to chat models?** Not by default. A user-requested transaction-specific answer may send selected dates, merchant labels, categories, amounts, and currencies. Merchant lookup and receipt extraction disclose selected data to their configured providers when requested.
- **Can I correct a classification?** Yes. Corrections preserve original fields, record overrides, and recompute the affected month before the report revision is marked complete.
- **Can I export or delete data?** JSON export is available. Explicitly confirmed deletion removes app-owned finance rows and receipt objects where possible but retains the sign-in account. Provider backup erasure is not claimed.
- **Does a recurring candidate prove a subscription?** No. It is an evidence-backed heuristic candidate; the UI shows observed transactions and uncertainty.
- **Does a month without records mean zero spending?** No. Coverage labels describe observed or user-confirmed export scope.

## Platform questions before an Anna submission

1. Which documented Anna host API call and arguments select per-user APS storage for a UI app, and what are the exact quotas and pagination guarantees?
2. Is an Anna app-window token supported for a Supabase-authenticated backend? If so, what is the approved exchange and how are ownership, expiry, logout, and revocation enforced?
3. Which app SDK/CLI versions, form factors, review requirements, and submission path are currently supported?
4. What provider invocation, user-consent, and cost disclosures are required for an app that uses its own backend?

## Interview and beta protocol (not executed)

Ask participants to narrate their most recent monthly review using only a synthetic export first. Observe whether they can:

- Explain what the full-month coverage label means.
- Locate the evidence behind a recurring-charge candidate.
- Distinguish gross outflows, refunds, net spend, income, and unknown inflows.
- Correct one category and verify the report changes.
- Describe what data is stored, sent to providers, exported, and deleted.

Do not ask leading questions such as “Would you use this?” as the primary signal. Record task completion, errors, participant wording, and observed hesitation. Only count real sessions with consent and protect their data. No participants or outcomes are included here.

## Campaign and release plan (zero spend)

1. Resolve the Anna identity/storage gate and obtain human/platform review.
2. Reproduce the complete configured Anna journey and verify the exact release artifact.
3. Obtain explicit owner authorization before outreach, submission, or publishing.
4. Share a demo/FAQ only after those gates; use attributable links and keep sample/QA events separate from official metrics.
5. Set paid-acquisition budget to zero until the owner explicitly sets one and actual unit costs are measured.

No campaign has been launched; no marketplace approval or program eligibility is implied.
