import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dedupeInBatch } from "@/lib/ingest/dedup";
import { parseTransactions } from "@/lib/ingest/parse";
import { aggregateMonthlyRollups } from "./rollup-math";

const fixture = readFileSync(
  new URL("../../fixtures/sample-transactions.csv", import.meta.url),
  "utf8",
);

describe("aggregateMonthlyRollups", () => {
  it("matches fixed monthly totals after quarantining errors and deduplicating", () => {
    const parsed = parseTransactions(fixture);
    const { rows, inFileDuplicates } = dedupeInBatch("user-1", parsed.valid);
    const expected = new Map([
      ["2024-04", { spend: 189943, income: 320000, count: 10 }],
      ["2024-05", { spend: 290358, income: 320000, count: 8 }],
      ["2024-06", { spend: 281397, income: 320000, count: 6 }],
    ]);

    expect(parsed.errors).toHaveLength(2);
    expect(rows).toHaveLength(24);
    expect(inFileDuplicates).toBe(0);
    expect(dedupeInBatch("user-1", parsed.valid).possibleDuplicates).toBe(1);

    for (const [month, totals] of expected) {
      const monthTransactions = rows
        .filter((row) => row.txn_date.startsWith(month))
        .map((row) => ({ ...row, kind: row.transaction_kind }));
      const all = aggregateMonthlyRollups(monthTransactions).find(
        (row) => row.category === "__all__",
      );

      expect(all).toEqual({
        category: "__all__",
        total_spend_cents: totals.spend,
        total_refund_cents: 0,
        net_spend_cents: totals.spend,
        total_income_cents: totals.income,
        total_unknown_inflow_cents: 0,
        txn_count: totals.count,
      });
    }
  });

  it("keeps positive credits separate from negative spending", () => {
    const [all] = aggregateMonthlyRollups([
      { amount_cents: -1250, category: "dining" },
      { amount_cents: 500, category: "income", kind: "income" },
    ]);

    expect(all).toEqual({
      category: "__all__",
      total_spend_cents: 1250,
      total_refund_cents: 0,
      net_spend_cents: 1250,
      total_income_cents: 500,
      total_unknown_inflow_cents: 0,
      txn_count: 2,
    });
  });

  it("keeps expenses, refunds, income, transfers, and unknown inflows distinct", () => {
    const [all] = aggregateMonthlyRollups([
      { amount_cents: -10000, category: "shopping", kind: "expense" },
      { amount_cents: 2000, category: "shopping", kind: "refund" },
      { amount_cents: 100000, category: "income", kind: "income" },
      { amount_cents: -20000, category: "transfers", kind: "transfer" },
      { amount_cents: 20000, category: "transfers", kind: "transfer" },
      { amount_cents: 5000, category: "uncategorized", kind: "unknown" },
    ]);

    expect(all).toEqual({
      category: "__all__",
      total_spend_cents: 10000,
      total_refund_cents: 2000,
      net_spend_cents: 8000,
      total_income_cents: 100000,
      total_unknown_inflow_cents: 5000,
      txn_count: 6,
    });
  });
});
