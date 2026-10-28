import { describe, expect, it } from "vitest";
import { aggregateMonthlyRollups } from "./rollup-math";
import { findRecurringCandidates } from "./recurrence";

const observations = [
  { id: "stream-jul", txn_date: "2026-07-05", merchant_norm: "STREAMCO", amount_cents: -1000 },
  { id: "stream-aug", txn_date: "2026-08-05", merchant_norm: "STREAMCO", amount_cents: -1000 },
  { id: "stream-sep", txn_date: "2026-09-05", merchant_norm: "STREAMCO", amount_cents: -1200 },
  { id: "grocery-jul", txn_date: "2026-07-10", merchant_norm: "GROCERY", amount_cents: -2000 },
  { id: "grocery-aug", txn_date: "2026-08-11", merchant_norm: "GROCERY", amount_cents: -2500 },
  { id: "grocery-sep", txn_date: "2026-09-12", merchant_norm: "GROCERY", amount_cents: -3000 },
].map((row) => ({ ...row, category: "uncategorized", currency: "USD", kind: "expense" as const }));

describe("recurring-charge evidence", () => {
  it("meets exact monthly totals and flags only the stable three-observation candidate", () => {
    const totals = new Map([
      ["2026-07", 3000],
      ["2026-08", 3500],
      ["2026-09", 4200],
    ]);
    for (const [month, expected] of totals) {
      const monthRows = observations.filter((row) => row.txn_date.startsWith(month));
      const [all] = aggregateMonthlyRollups(monthRows);
      expect(all?.total_spend_cents).toBe(expected);
    }

    const candidates = findRecurringCandidates(observations);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      merchant_norm: "STREAMCO",
      occurrence_count: 3,
      currency: "USD",
      uncertainty: "heuristic_pattern_not_verified",
      amount_change_cents: 200,
      evidence: [
        { transaction_id: "stream-jul", date: "2026-07-05", amount_cents: 1000 },
        { transaction_id: "stream-aug", date: "2026-08-05", amount_cents: 1000 },
        { transaction_id: "stream-sep", date: "2026-09-05", amount_cents: 1200 },
      ],
    });
  });

  it("does not detect a candidate from only two observations", () => {
    expect(findRecurringCandidates(observations.slice(0, 2))).toEqual([]);
  });

  it("rounds amount changes to integer cents when the prior median is fractional", () => {
    const candidate = findRecurringCandidates([
      { id: "first", txn_date: "2026-01-01", merchant_norm: "PLAN", amount_cents: -100, currency: "USD" },
      { id: "second", txn_date: "2026-02-01", merchant_norm: "PLAN", amount_cents: -101, currency: "USD" },
      { id: "third", txn_date: "2026-03-04", merchant_norm: "PLAN", amount_cents: -102, currency: "USD" },
    ]);

    expect(candidate).toHaveLength(1);
    expect(candidate[0]?.amount_change_cents).toBe(2);
    expect(Number.isInteger(candidate[0]?.amount_change_cents)).toBe(true);
  });
});
