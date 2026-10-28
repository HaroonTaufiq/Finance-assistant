import { describe, expect, it } from "vitest";
import { createSampleReport } from "./sample";

describe("synthetic monthly sample", () => {
  it("calculates exact totals, comparison, and evidence-backed recurrence", () => {
    const report = createSampleReport();

    expect(report.totals).toEqual({
      grossOutflowsCents: 9949,
      refundsCents: 500,
      netSpendCents: 9449,
      incomeCents: 300000,
      unknownInflowsCents: 1000,
    });
    expect(report.comparison).toMatchObject({
      priorMonth: "2024-02",
      priorNetSpendCents: 6499,
      deltaCents: 2950,
      deltaPercent: 45.4,
    });
    expect(report.subscriptions).toHaveLength(1);
    expect(report.subscriptions[0]).toMatchObject({
      merchant_norm: "STREAMCO",
      occurrence_count: 3,
      status: "active",
      evidence: [
        { date: "2024-01-05", amount_cents: 1499 },
        { date: "2024-02-05", amount_cents: 1499 },
        { date: "2024-03-05", amount_cents: 1499 },
      ],
    });
  });
});
