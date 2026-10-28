export type RollupTransaction = {
  amount_cents: number;
  category: string;
};

export type RollupAggregate = {
  category: string;
  total_spend_cents: number;
  total_income_cents: number;
  txn_count: number;
};

type Totals = Omit<RollupAggregate, "category">;

export function aggregateMonthlyRollups(
  transactions: readonly RollupTransaction[],
): RollupAggregate[] {
  const perCategory = new Map<string, Totals>();
  const all: Totals = { total_spend_cents: 0, total_income_cents: 0, txn_count: 0 };

  for (const transaction of transactions) {
    const category = perCategory.get(transaction.category) ?? {
      total_spend_cents: 0,
      total_income_cents: 0,
      txn_count: 0,
    };
    const amount = transaction.amount_cents;

    if (amount < 0) {
      category.total_spend_cents += -amount;
      all.total_spend_cents += -amount;
    } else {
      category.total_income_cents += amount;
      all.total_income_cents += amount;
    }

    category.txn_count += 1;
    all.txn_count += 1;
    perCategory.set(transaction.category, category);
  }

  return [
    { category: "__all__", ...all },
    ...[...perCategory].map(([category, totals]) => ({ category, ...totals })),
  ];
}
