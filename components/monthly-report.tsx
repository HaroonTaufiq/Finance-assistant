"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createSampleReport } from "@/lib/anna/sample";
import { recordAnalyticsEvent } from "@/lib/analytics/client";

type Report = {
  hasData: boolean;
  month?: string;
  monthLabel?: string;
  currency?: string | null;
  coverage?: {
    status: "user_confirmed_complete" | "observed_transactions_only";
    observedFrom: string | null;
    observedTo: string | null;
  };
  totals?: {
    grossOutflowsCents: number;
    refundsCents: number;
    netSpendCents: number;
    incomeCents: number;
    unknownInflowsCents: number;
  };
  categories?: {
    category: string;
    total_spend_cents: number;
    total_refund_cents: number;
    net_spend_cents: number;
  }[];
  comparison?: {
    priorMonth?: string;
    priorNetSpendCents?: number;
    deltaCents?: number;
    deltaPercent?: number | null;
    unavailableReason?: string;
  };
  subscriptions?: {
    merchant_norm: string;
    status: "active" | "confirmed";
    cadence_days: number | null;
    avg_amount_cents: number;
    currency: string;
    occurrence_count: number;
    evidence: { transaction_id: string; date: string; amount_cents: number }[];
    uncertainty: string;
    amount_change_cents: number | null;
  }[];
  transactions?: {
    id: string;
    txn_date: string;
    amount_cents: number;
    currency: string;
    merchant_raw: string | null;
    merchant_norm: string | null;
    category: string;
    transaction_kind: string;
    category_override: string | null;
    transaction_kind_override: string | null;
  }[];
  revision?: { id: string; completed_at: string | null } | null;
  updatedAt?: string | null;
};

type Draft = { category: string; kind: string };
type ExplanationTopic =
  | { kind: "change" }
  | { kind: "recurring"; merchant: string };

function money(cents: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(cents / 100);
}

function coverageText(report: Report): string {
  if (report.coverage?.status === "user_confirmed_complete") {
    return "You confirmed this export covers the full calendar month.";
  }
  const { observedFrom, observedTo } = report.coverage ?? {};
  return observedFrom && observedTo
    ? `Observed transactions: ${observedFrom} to ${observedTo}. Full-month coverage is not confirmed.`
    : "No imported transactions were observed for this calendar month.";
}

export function MonthlyReport({
  embedded = false,
  initialSample = false,
}: {
  embedded?: boolean;
  initialSample?: boolean;
}) {
  const [report, setReport] = useState<Report | null>(() =>
    initialSample ? createSampleReport() : null,
  );
  const [sampleMode, setSampleMode] = useState(initialSample);
  const [month, setMonth] = useState(() =>
    initialSample ? createSampleReport().month ?? "" : "",
  );
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(!initialSample);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryRequired, setRetryRequired] = useState(false);
  const [explanation, setExplanation] = useState<{ revisionId: string; text: string } | null>(null);
  const [explanationError, setExplanationError] = useState<string | null>(null);
  const [explanationTopic, setExplanationTopic] = useState<ExplanationTopic | null>(null);
  const [explaining, setExplaining] = useState(false);
  const requestId = useRef(0);
  const firstViewTracked = useRef(false);
  const completedReports = useRef(new Set<string>());

  const refresh = useCallback(async (selectedMonth: string | null) => {
    const request = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const query = selectedMonth ? `?month=${encodeURIComponent(selectedMonth)}` : "";
      const response = await fetch(`/api/report${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not load monthly report");
      if (request !== requestId.current) return;
      const next = payload as Report;
      setReport(next);
      setExplanation(null);
      setExplanationError(null);
      setExplanationTopic(null);
      setSampleMode(false);
      if (next.month) setMonth(next.month);
      setDrafts(
        Object.fromEntries(
          (next.transactions ?? []).map((transaction) => [
            transaction.id,
            {
              category:
                transaction.category_override ??
                transaction.category ??
                "uncategorized",
              kind:
                transaction.transaction_kind_override ??
                transaction.transaction_kind ??
                "unknown",
            },
          ]),
        ),
      );
      setRetryRequired(false);
    } catch (caught) {
      if (request !== requestId.current) return;
      setError(caught instanceof Error ? caught.message : "Could not load monthly report");
      setRetryRequired(/not current|needs recovery|pending/i.test(caught instanceof Error ? caught.message : ""));
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, []);

  async function explain(topic: ExplanationTopic) {
    if (!report?.month || !report.revision?.id) return;
    const revisionId = report.revision.id;
    const startedAt = performance.now();
    setExplanationTopic(topic);
    setExplanation(null);
    setExplanationError(null);
    setExplaining(true);
    try {
      const response = await fetch("/api/report/explanation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ month: report.month, revisionId, topic }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not explain this report");
      if (result.revisionId !== revisionId) {
        throw new Error("The report changed while the explanation was being prepared. Refresh and retry.");
      }
      setExplanation({ revisionId, text: result.text });
      void recordAnalyticsEvent({
        eventKey: `explanation-success:${crypto.randomUUID()}`,
        eventName: "explanation_succeeded",
        mode: "personal",
        revision: revisionId,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not explain this report";
      setExplanationError(message);
      void recordAnalyticsEvent({
        eventKey: `explanation-failure:${crypto.randomUUID()}`,
        eventName: "explanation_failed",
        mode: "personal",
        revision: revisionId,
        durationMs: Math.round(performance.now() - startedAt),
        errorCode: "unknown",
      });
    } finally {
      setExplaining(false);
    }
  }

  useEffect(() => {
    if (!firstViewTracked.current) {
      firstViewTracked.current = true;
      void recordAnalyticsEvent({
        eventKey: `first-view:${crypto.randomUUID()}`,
        eventName: "first_view",
        mode: initialSample ? "sample" : "personal",
      });
      if (initialSample) {
        void recordAnalyticsEvent({
          eventKey: `sample-view:${crypto.randomUUID()}`,
          eventName: "sample_view",
          mode: "sample",
          revision: "sample-only",
        });
      }
    }
    if (!initialSample) void refresh(null);
  }, [initialSample, refresh]);

  useEffect(() => {
    const revision = report?.revision?.id;
    if (!report?.hasData || sampleMode || !revision || !report.month) return;
    const reportKey = `${revision}:${report.month}`;
    if (completedReports.current.has(reportKey)) return;
    completedReports.current.add(reportKey);
    void recordAnalyticsEvent({
      eventKey: `report:${reportKey}`,
      eventName: "report_completed",
      mode: "personal",
      revision,
    });
  }, [report, sampleMode]);

  async function saveCorrection(transactionId: string) {
    const draft = drafts[transactionId];
    if (!draft) return;
    setBusy(transactionId);
    setError(null);
    try {
      const response = await fetch(`/api/transactions/${transactionId}/correction`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const result = await response.json();
      if (!response.ok) {
        setRetryRequired(result.retryRequired === true);
        throw new Error(result.error ?? "Could not save correction");
      }
      await refresh(month || null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save correction");
    } finally {
      setBusy(null);
    }
  }

  async function retryRecompute() {
    setBusy("retry");
    setError(null);
    try {
      const response = await fetch("/api/report/retry", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not recompute report");
      await refresh(month || null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not recompute report");
    } finally {
      setBusy(null);
    }
  }

  async function reviewSubscription(merchant: string, status: "confirmed" | "dismissed") {
    setBusy(merchant);
    setError(null);
    try {
      const response = await fetch(`/api/subscriptions/${encodeURIComponent(merchant)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not save recurring-candidate review");
      await refresh(month || null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save recurring-candidate review");
    } finally {
      setBusy(null);
    }
  }

  const currency = report?.currency ?? "USD";
  const visibleCategories = (report?.categories ?? []).filter(
    (row) => row.total_spend_cents > 0 || row.total_refund_cents > 0,
  );
  const categoryOptions = [
    ...new Set([
      "uncategorized",
      ...visibleCategories.map((row) => row.category),
      "other",
    ]),
  ];

  return (
    <main className={`${embedded ? "px-1 py-2" : "min-h-screen px-4 py-6 sm:px-8"} bg-bg text-text`}>
      <div className="mx-auto max-w-5xl">
        {!embedded && <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-text-faint">Finance Assistant</p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Monthly review</h1>
          </div>
          <Link className="rounded border border-border px-3 py-2 text-sm hover:bg-surface" href="/chat">
            Back to chat
          </Link>
        </header>}

        {sampleMode && (
          <aside className="mt-5 rounded border border-accent/40 bg-[color:var(--accent-soft)] p-3 text-sm">
            SAMPLE ONLY — synthetic transactions, calculations and candidates. Nothing here is saved
            to your account or included in personal activity.
            <Link href="/chat" className="ml-2 underline">Import your own transactions</Link>
          </aside>
        )}

        {error && (
          <div role="alert" className="mt-5 rounded border border-danger/40 bg-danger/5 p-3 text-sm">
            <p>{error}</p>
            {retryRequired && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void retryRecompute()}
                className="mt-2 rounded bg-accent px-3 py-2 text-white disabled:opacity-50"
              >
                {busy === "retry" ? "Recomputing…" : "Retry recomputation"}
              </button>
            )}
          </div>
        )}

        {loading && <p className="mt-8 text-sm text-text-muted">Loading your report…</p>}
        {!loading && report && !report.hasData && (
          <section className="mt-8 rounded border border-border bg-surface p-6">
            <h2 className="font-medium">Import transactions to begin</h2>
            <p className="mt-2 text-sm text-text-muted">
              Reports are calculated from your persisted transaction history.
            </p>
            <Link className="mt-4 inline-block rounded bg-accent px-3 py-2 text-sm text-white" href="/chat">
              Import a CSV
            </Link>
            <Link className="ml-3 mt-4 inline-block rounded border border-border px-3 py-2 text-sm" href="/sample">
              Try a synthetic sample
            </Link>
          </section>
        )}

        {!loading && report?.hasData && report.totals && (
          <>
            <section className="mt-6 flex flex-wrap items-end justify-between gap-4">
              <div>
                <label htmlFor="report-month" className="block text-xs text-text-muted">
                  Calendar month
                </label>
                <input
                  id="report-month"
                  type="month"
                  value={month}
                  disabled={sampleMode}
                  onChange={(event) => {
                    if (sampleMode || !event.target.value) return;
                    void recordAnalyticsEvent({
                      eventKey: `next-review:${event.target.value}:${crypto.randomUUID()}`,
                      eventName: "next_review",
                      mode: "personal",
                      revision: report.revision?.id ?? null,
                    });
                    void refresh(event.target.value);
                  }}
                  className="mt-1 rounded border border-border bg-surface px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-text-faint">{report.monthLabel}</p>
              </div>
              <p className="max-w-xl text-sm text-text-muted">{coverageText(report)}</p>
            </section>

            <section aria-label="Monthly totals" className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {[
                ["Gross outflows", report.totals.grossOutflowsCents],
                ["Refunds", report.totals.refundsCents],
                ["Net spend", report.totals.netSpendCents],
                ["Income", report.totals.incomeCents],
                ["Unclassified inflows", report.totals.unknownInflowsCents],
              ].map(([label, amount]) => (
                <article key={label} className="rounded border border-border bg-surface p-4">
                  <h2 className="text-xs text-text-muted">{label}</h2>
                  <p className="mt-2 font-display text-xl font-semibold">
                    {money(Number(amount), currency)}
                  </p>
                </article>
              ))}
            </section>

            <section className="mt-6 grid gap-4 lg:grid-cols-2">
              <article className="rounded border border-border bg-surface p-4">
                <h2 className="font-medium">Category breakdown</h2>
                {visibleCategories.length === 0 ? (
                  <p className="mt-3 text-sm text-text-muted">No categorized activity in this month.</p>
                ) : (
                  <ul className="mt-3 divide-y divide-border">
                    {visibleCategories.map((row) => (
                      <li key={row.category} className="flex justify-between gap-3 py-2 text-sm">
                        <span className="capitalize">{row.category}</span>
                        <span className="tnum">{money(row.net_spend_cents, currency)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </article>

              <article className="rounded border border-border bg-surface p-4">
                <h2 className="font-medium">Compared with prior month</h2>
                {report.comparison?.deltaCents != null ? (
                  <>
                    <p className="mt-2 text-sm text-text-muted">
                      {report.comparison.priorMonth}: {money(report.comparison.priorNetSpendCents ?? 0, currency)}
                    </p>
                    {!sampleMode && (
                      <button
                        type="button"
                        disabled={explaining || !report.revision?.id}
                        onClick={() => void explain({ kind: "change" })}
                        className="mt-3 inline-block text-sm text-accent underline disabled:opacity-50"
                      >
                        {explaining && explanationTopic?.kind === "change"
                          ? "Explaining…"
                          : "Explain this change"}
                      </button>
                    )}
                    <p className="mt-1 font-display text-xl font-semibold">
                      {report.comparison.deltaCents > 0 ? "+" : ""}
                      {money(report.comparison.deltaCents, currency)}
                      {report.comparison.deltaPercent != null && (
                        <span className="ml-2 text-sm font-normal">
                          ({report.comparison.deltaPercent > 0 ? "+" : ""}
                          {report.comparison.deltaPercent}%)
                        </span>
                      )}
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-text-muted">
                    Comparison unavailable: {report.comparison?.unavailableReason === "current_month_is_partial"
                      ? "the current month is still partial."
                      : "both months need user-confirmed full-month coverage."}
                  </p>
                )}
              </article>
            </section>

            <section className="mt-6 rounded border border-border bg-surface p-4">
              <h2 className="font-medium">Recurring candidates</h2>
              {(report.subscriptions ?? []).length === 0 ? (
                <p className="mt-3 text-sm text-text-muted">No recurring candidates meet the evidence threshold yet.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {report.subscriptions?.map((candidate) => (
                    <li key={candidate.merchant_norm} className="rounded border border-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="font-medium">{candidate.merchant_norm}</p>
                          <p className="mt-1 text-xs text-text-muted">
                            {money(candidate.avg_amount_cents, candidate.currency)} · {candidate.occurrence_count} observations
                            {candidate.status === "confirmed" ? " · confirmed" : ""}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          {!sampleMode && candidate.status !== "confirmed" && (
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => void reviewSubscription(candidate.merchant_norm, "confirmed")}
                              className="rounded bg-accent px-3 py-2 text-xs text-white disabled:opacity-50"
                            >
                              Confirm
                            </button>
                          )}
                          {!sampleMode && <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void reviewSubscription(candidate.merchant_norm, "dismissed")}
                            className="rounded border border-border px-3 py-2 text-xs text-text-muted disabled:opacity-50"
                          >
                            Dismiss
                          </button>}
                        </div>
                      </div>
                      <p className="mt-2 text-xs text-text-faint">{candidate.uncertainty}</p>
                      <ol className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                        {candidate.evidence.map((entry) => (
                          <li key={entry.transaction_id}>
                            {entry.date}: {money(entry.amount_cents, candidate.currency)}
                          </li>
                        ))}
                      </ol>
                      {!sampleMode && (
                        <button
                          type="button"
                          disabled={explaining || !report.revision?.id}
                          onClick={() => void explain({
                            kind: "recurring",
                            merchant: candidate.merchant_norm,
                          })}
                          className="mt-2 inline-block text-xs text-accent underline disabled:opacity-50"
                        >
                          {explaining && explanationTopic?.kind === "recurring" &&
                          explanationTopic.merchant === candidate.merchant_norm
                            ? "Explaining…"
                            : "Explain this candidate"}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {(explanationError || explanation) && (
              <section className="mt-4 rounded border border-border bg-surface p-4" aria-live="polite">
                <h2 className="font-medium">Report explanation</h2>
                {explanationError ? (
                  <>
                    <p className="mt-2 text-sm text-danger">{explanationError}</p>
                    <p className="mt-1 text-xs text-text-muted">
                      The deterministic report remains available. Provider calls are optional.
                    </p>
                    {explanationTopic && (
                      <button
                        type="button"
                        disabled={explaining}
                        onClick={() => void explain(explanationTopic)}
                        className="mt-2 text-sm text-accent underline disabled:opacity-50"
                      >
                        Retry explanation
                      </button>
                    )}
                  </>
                ) : explanation ? (
                  <>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-text">{explanation.text}</p>
                    <p className="mt-2 text-xs text-text-faint">
                      Based on report revision {explanation.revisionId.slice(0, 8)}.
                    </p>
                  </>
                ) : null}
              </section>
            )}

            <section className="mt-6 rounded border border-border bg-surface p-4">
              <h2 className="font-medium">Review transactions</h2>
              <p className="mt-1 text-xs text-text-muted">
                Corrections change your classification while preserving the original imported fields.
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[700px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-text-muted">
                      <th className="p-2">Date</th>
                      <th className="p-2">Merchant</th>
                      <th className="p-2">Amount</th>
                      <th className="p-2">Category</th>
                      <th className="p-2">Kind</th>
                      <th className="p-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.transactions?.map((transaction) => {
                      const draft = drafts[transaction.id];
                      const kindOptions =
                        transaction.amount_cents < 0
                          ? ["expense", "transfer"]
                          : ["refund", "income", "transfer", "unknown"];
                      return (
                        <tr key={transaction.id} className="border-b border-border">
                          <td className="p-2">{transaction.txn_date}</td>
                          <td className="p-2">{transaction.merchant_raw ?? transaction.merchant_norm ?? "Unknown"}</td>
                          <td className="p-2 tnum">{money(transaction.amount_cents, transaction.currency)}</td>
                          <td className="p-2">
                            <select
                              disabled={sampleMode}
                              aria-label={`Category for ${transaction.merchant_norm ?? transaction.id}`}
                              value={draft?.category ?? transaction.category}
                              onChange={(event) =>
                                setDrafts((existing) => ({
                                  ...existing,
                                  [transaction.id]: {
                                    category: event.target.value,
                                    kind: draft?.kind ?? transaction.transaction_kind,
                                  },
                                }))
                              }
                              className="rounded border border-border bg-bg px-2 py-1"
                            >
                              {[...new Set([...categoryOptions, draft?.category ?? transaction.category])].map((category) => (
                                <option key={category} value={category}>{category}</option>
                              ))}
                            </select>
                          </td>
                          <td className="p-2">
                            <select
                              disabled={sampleMode}
                              aria-label={`Kind for ${transaction.merchant_norm ?? transaction.id}`}
                              value={draft?.kind ?? transaction.transaction_kind}
                              onChange={(event) =>
                                setDrafts((existing) => ({
                                  ...existing,
                                  [transaction.id]: {
                                    category: draft?.category ?? transaction.category,
                                    kind: event.target.value,
                                  },
                                }))
                              }
                              className="rounded border border-border bg-bg px-2 py-1"
                            >
                              {kindOptions.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                            </select>
                          </td>
                          <td className="p-2">
                            {!sampleMode && (
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => void saveCorrection(transaction.id)}
                              className="rounded border border-border px-2 py-1 text-accent disabled:opacity-50"
                            >
                              {busy === transaction.id ? "Saving…" : "Save"}
                            </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
            {!sampleMode && <section className="mt-6 rounded border border-border bg-surface p-4">
              <h2 className="font-medium">Your data</h2>
              <p className="mt-1 text-xs text-text-muted">
                Export includes source rows, normalized transactions, overrides, reports and review decisions.
                Deletion removes finance records and receipt files but keeps your sign-in account.
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                <a
                  href="/api/data/export"
                  className="rounded border border-border px-3 py-2 text-sm text-accent hover:bg-bg"
                >
                  Download JSON export
                </a>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={async () => {
                    if (!window.confirm("Delete all finance data and receipt files? Your sign-in account will remain.")) {
                      return;
                    }
                    setBusy("delete");
                    setError(null);
                    try {
                      const response = await fetch("/api/data/delete", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ confirmation: "DELETE MY FINANCE DATA" }),
                      });
                      const result = await response.json();
                      if (!response.ok) throw new Error(result.error ?? "Could not delete finance data");
                      await refresh(null);
                    } catch (caught) {
                      setError(caught instanceof Error ? caught.message : "Could not delete finance data");
                    } finally {
                      setBusy(null);
                    }
                  }}
                  className="rounded border border-danger/40 px-3 py-2 text-sm text-danger disabled:opacity-50"
                >
                  {busy === "delete" ? "Deleting…" : "Delete finance data"}
                </button>
              </div>
            </section>}
            <p className="mt-4 text-xs text-text-faint">
              Revision: {report.revision?.id ?? "none"}{report.updatedAt ? ` · updated ${report.updatedAt}` : ""}
            </p>
          </>
        )}
      </div>
    </main>
  );
}
