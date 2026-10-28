import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getSpending, getTransactions } from "./queries";

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

  describe("getTransactions effective classifications", () => {
    it("filters and returns user-corrected category and kind rather than source values", async () => {
      const rows = [
        {
          id: "corrected",
          txn_date: "2024-04-15",
          merchant_norm: "MARKET",
          category: "groceries",
          category_override: "other",
          transaction_kind: "expense",
          transaction_kind_override: "transfer",
          amount_cents: -1000,
          currency: "PKR",
        },
        {
          id: "unchanged",
          txn_date: "2024-04-16",
          merchant_norm: "SHOP",
          category: "other",
          category_override: null,
          transaction_kind: "expense",
          transaction_kind_override: null,
          amount_cents: -500,
          currency: "PKR",
        },
      ];
      const client = {
        from() {
          const filters: [string, unknown][] = [];
          let limit = rows.length;
          const query = {
            select: () => query,
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return query;
            },
            ilike: () => query,
            gte: () => query,
            lte: () => query,
            order: () => query,
            limit(value: number) {
              limit = value;
              return query;
            },
            then(resolve: (result: { data: typeof rows; error: null }) => unknown) {
              const categoryFilter = filters.find(([column]) =>
                column === "category" || column === "category_override");
              const selected = rows.filter((row) =>
                !categoryFilter || row[categoryFilter[0] as "category" | "category_override"] === categoryFilter[1],
              ).slice(0, limit);
              return Promise.resolve({ data: selected, error: null }).then(resolve);
            },
          };
          return query;
        },
      };

      const result = await getTransactions(client as never, "user-1", {
        filters: { category: "other" },
        sort: "date_asc",
        limit: 10,
      });

      expect(result.rows).toEqual([
        {
          date: "2024-04-15",
          merchant: "MARKET",
          category: "other",
          kind: "transfer",
          amount_cents: -1000,
          currency: "PKR",
        },
        {
          date: "2024-04-16",
          merchant: "SHOP",
          category: "other",
          kind: "expense",
          amount_cents: -500,
          currency: "PKR",
        },
      ]);
    });
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
