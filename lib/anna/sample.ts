import { aggregateMonthlyRollups } from "@/lib/batch/rollup-math";
import { findRecurringCandidates } from "@/lib/batch/recurrence";

export const SAMPLE_TRANSACTIONS = [
  { id: "sample-jan-stream", txn_date: "2024-01-05", amount_cents: -1499, currency: "USD", merchant_norm: "STREAMCO", category: "subscriptions", transaction_kind: "expense" },
  { id: "sample-feb-stream", txn_date: "2024-02-05", amount_cents: -1499, currency: "USD", merchant_norm: "STREAMCO", category: "subscriptions", transaction_kind: "expense" },
  { id: "sample-mar-stream", txn_date: "2024-03-05", amount_cents: -1499, currency: "USD", merchant_norm: "STREAMCO", category: "subscriptions", transaction_kind: "expense" },
  { id: "sample-feb-grocery", txn_date: "2024-02-07", amount_cents: -5000, currency: "USD", merchant_norm: "WHOLE FOODS", category: "groceries", transaction_kind: "expense" },
  { id: "sample-mar-grocery", txn_date: "2024-03-07", amount_cents: -8000, currency: "USD", merchant_norm: "WHOLE FOODS", category: "groceries", transaction_kind: "expense" },
  { id: "sample-mar-coffee", txn_date: "2024-03-11", amount_cents: -450, currency: "USD", merchant_norm: "COFFEE SHOP", category: "dining", transaction_kind: "expense" },
  { id: "sample-mar-refund", txn_date: "2024-03-12", amount_cents: 500, currency: "USD", merchant_norm: "WHOLE FOODS", category: "groceries", transaction_kind: "refund" },
  { id: "sample-mar-payroll", txn_date: "2024-03-15", amount_cents: 300000, currency: "USD", merchant_norm: "PAYROLL", category: "income", transaction_kind: "income" },
  { id: "sample-mar-transfer", txn_date: "2024-03-16", amount_cents: 30000, currency: "USD", merchant_norm: "SAVINGS TRANSFER", category: "transfer", transaction_kind: "transfer" },
  { id: "sample-mar-unknown", txn_date: "2024-03-18", amount_cents: 1000, currency: "USD", merchant_norm: "UNKNOWN CREDIT", category: "uncategorized", transaction_kind: "unknown" },
] as const;

export function createSampleReport() {
  const marchTransactions = SAMPLE_TRANSACTIONS.filter((row) => row.txn_date.startsWith("2024-03"));
  const februaryTransactions = SAMPLE_TRANSACTIONS.filter((row) => row.txn_date.startsWith("2024-02"));
  const marchRollups = aggregateMonthlyRollups(
    marchTransactions.map((row) => ({
      amount_cents: row.amount_cents,
      category: row.category,
      kind: row.transaction_kind,
    })),
  );
  const februaryRollups = aggregateMonthlyRollups(
    februaryTransactions.map((row) => ({
      amount_cents: row.amount_cents,
      category: row.category,
      kind: row.transaction_kind,
    })),
  );
  const totals = marchRollups.find((row) => row.category === "__all__")!;
  const priorTotals = februaryRollups.find((row) => row.category === "__all__")!;
  const deltaCents = totals.net_spend_cents - priorTotals.net_spend_cents;
  const candidates = findRecurringCandidates(
    SAMPLE_TRANSACTIONS.filter(
      (row) => row.merchant_norm === "STREAMCO",
    ),
  ).map((candidate) => ({ ...candidate, status: "active" as const }));

  return {
    hasData: true,
    month: "2024-03",
    monthLabel: "SAMPLE · March 2024 · synthetic data",
    currency: "USD",
    coverage: {
      status: "observed_transactions_only" as const,
      observedFrom: "2024-03-05",
      observedTo: "2024-03-18",
    },
    totals: {
      grossOutflowsCents: totals.total_spend_cents,
      refundsCents: totals.total_refund_cents,
      netSpendCents: totals.net_spend_cents,
      incomeCents: totals.total_income_cents,
      unknownInflowsCents: totals.total_unknown_inflow_cents,
    },
    categories: marchRollups.filter(
      (row) => row.category !== "__all__" && (row.total_spend_cents > 0 || row.total_refund_cents > 0),
    ),
    comparison: {
      priorMonth: "2024-02",
      priorNetSpendCents: priorTotals.net_spend_cents,
      deltaCents,
      deltaPercent: Number(((deltaCents / priorTotals.net_spend_cents) * 100).toFixed(1)),
    },
    subscriptions: candidates,
    transactions: marchTransactions.map((row) => ({
      ...row,
      merchant_raw: row.merchant_norm,
      category_override: null,
      transaction_kind_override: null,
    })),
    revision: { id: "sample-only", completed_at: null },
    updatedAt: null,
  };
}
