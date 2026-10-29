export type RollupTransaction = {
  amount_cents: number;
  category: string;
  kind?: "expense" | "refund" | "income" | "transfer" | "unknown";
};

export type RollupAggregate = {
  category: string;
  total_spend_cents: number;
  total_refund_cents: number;
  net_spend_cents: number;
  total_income_cents: number;
  total_unknown_inflow_cents: number;
  txn_count: number;
};

type Totals = Omit<RollupAggregate, "category">;

function emptyTotals(): Totals {
  return {
    total_spend_cents: 0,
    total_refund_cents: 0,
    net_spend_cents: 0,
    total_income_cents: 0,
    total_unknown_inflow_cents: 0,
    txn_count: 0,
  };
}

export function aggregateMonthlyRollups(
  transactions: readonly RollupTransaction[],
): RollupAggregate[] {
  const perCategory = new Map<string, Totals>();
  const all = emptyTotals();

  for (const transaction of transactions) {
    const category = perCategory.get(transaction.category) ?? emptyTotals();
    const amount = transaction.amount_cents;
    const kind = transaction.kind ?? (amount < 0 ? "expense" : "unknown");

    if (kind === "expense") {
      category.total_spend_cents += -amount;
      all.total_spend_cents += -amount;
    } else if (kind === "refund") {
      category.total_refund_cents += amount;
      all.total_refund_cents += amount;
    } else if (kind === "income") {
      category.total_income_cents += amount;
      all.total_income_cents += amount;
    } else if (kind === "unknown" && amount > 0) {
      category.total_unknown_inflow_cents += amount;
      all.total_unknown_inflow_cents += amount;
    }

    category.net_spend_cents =
      category.total_spend_cents - category.total_refund_cents;
    all.net_spend_cents = all.total_spend_cents - all.total_refund_cents;
    category.txn_count += 1;
    all.txn_count += 1;
    perCategory.set(transaction.category, category);
  }

  return [
    { category: "__all__", ...all },
    ...[...perCategory].map(([category, totals]) => ({ category, ...totals })),
  ];
}
