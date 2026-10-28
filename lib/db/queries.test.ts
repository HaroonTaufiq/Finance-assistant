import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getSpending } from "./queries";

function rollupClient() {
  const rows = [
    {
      period_start: "2024-04-01",
      category: "__all__",
      total_spend_cents: 181520,
      total_refund_cents: 0,
      net_spend_cents: 181520,
      total_income_cents: 320000,
      total_unknown_inflow_cents: 0,
      currency: "USD",
    },
  ];
  const query = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    in() {
      return this;
    },
    neq() {
      return this;
    },
    then(resolve: (result: { data: typeof rows; error: null }) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    },
  };
  return {
    from(table: string) {
      if (table === "import_jobs") {
        return {
          select: () => ({
            eq: () => ({
              neq: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      return query;
    },
  };
}

describe("getSpending calendar-month semantics", () => {
  it("rejects a one-day request instead of labeling a whole month as an exact range", async () => {
    await expect(
      getSpending(rollupClient() as never, "user-1", {
        startDate: "2024-04-15",
        endDate: "2024-04-15",
      }),
    ).rejects.toThrow(/full calendar month/i);
  });

  it("accepts a complete calendar month range", async () => {
    const report = await getSpending(rollupClient() as never, "user-1", {
      startDate: "2024-04-01",
      endDate: "2024-04-30",
    });

    expect(report.period).toEqual({ start: "2024-04-01", end: "2024-04-30" });
    expect(report.total_cents).toBe(181520);
  });
});
