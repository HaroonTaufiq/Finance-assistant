import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSpending, getSubscriptions } = vi.hoisted(() => ({
  getSpending: vi.fn(),
  getSubscriptions: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/queries", () => ({ getSpending, getSubscriptions }));

import { getMonthlyReport } from "./monthly";

function client(finalRevision = "revision-current") {
  return {
    from(table: string) {
      const filters = new Map<string, unknown>();
      let selected = "";
      const query = {
        select(columns: string) {
          selected = columns;
          return query;
        },
        eq(column: string, value: unknown) {
          filters.set(column, value);
          return query;
        },
        neq(column: string, value: unknown) {
          filters.set(`not-${column}`, value);
          return query;
        },
        gte(column: string, value: unknown) {
          filters.set(`gte-${column}`, value);
          return query;
        },
        lte(column: string, value: unknown) {
          filters.set(`lte-${column}`, value);
          return query;
        },
        lt(column: string, value: unknown) {
          filters.set(`lt-${column}`, value);
          return query;
        },
        order: () => query,
        limit: () => query,
        async maybeSingle() {
          if (table === "import_jobs" && filters.has("not-status")) {
            return { data: null, error: null };
          }
          if (table === "financial_settings") {
            return { data: { currency: "USD" }, error: null };
          }
          if (table === "transactions" && selected === "txn_date") {
            return { data: { txn_date: "2024-02-29" }, error: null };
          }
          if (table === "import_jobs" && selected.includes("completed_at")) {
            return {
              data: { id: "revision-current", completed_at: "2024-03-01T00:00:00Z" },
              error: null,
            };
          }
          if (table === "import_jobs" && selected === "id") {
            return { data: { id: finalRevision }, error: null };
          }
          throw new Error(`unexpected maybeSingle query: ${table} (${selected})`);
        },
        async range() {
          if (table === "rollups") {
            return {
              data: [
                { category: "groceries", total_spend_cents: 3000, total_refund_cents: 0, net_spend_cents: 3000 },
                { category: "other", total_spend_cents: 1000, total_refund_cents: 0, net_spend_cents: 1000 },
              ],
              error: null,
            };
          }
          if (table === "transactions") {
            return {
              data: [{
                id: "txn-1",
                txn_date: "2024-02-15",
                amount_cents: -1000,
                currency: "USD",
                merchant_raw: "Market One",
                merchant_norm: "MARKET ONE",
                category: "groceries",
                transaction_kind: "expense",
                category_override: "other",
                transaction_kind_override: null,
              }],
              error: null,
            };
          }
          if (table === "import_jobs" && filters.has("coverage_confirmed")) {
            const start = filters.get("lte-coverage_start");
            return {
              data: [{ id: start === "2024-02-01" ? "current-coverage" : "prior-coverage" }],
              error: null,
            };
          }
          throw new Error(`unexpected range query: ${table} (${selected})`);
        },
      };
      return query;
    },
  };
}

describe("canonical monthly report loader", () => {
  beforeEach(() => {
    getSpending.mockReset();
    getSubscriptions.mockReset();
    getSpending.mockImplementation(async (_client, _userId, input) => ({
      gross_outflows_cents: input.startDate === "2024-02-01" ? 4000 : 3500,
      refunds_cents: input.startDate === "2024-02-01" ? 500 : 500,
      net_spend_cents: input.startDate === "2024-02-01" ? 3500 : 3000,
      total_income_cents: 100000,
      unknown_inflows_cents: 0,
    }));
    getSubscriptions.mockResolvedValue({
      subscriptions: [{
        merchant_norm: "STREAMCO",
        occurrence_count: 3,
        uncertainty: "medium",
        evidence: [],
      }],
    });
  });

  it("returns exact currency, coverage, comparison, and correction-effective evidence", async () => {
    const report = await getMonthlyReport(client() as never, "user-1", "2024-02");
    expect(report).toMatchObject({
      hasData: true,
      month: "2024-02",
      currency: "USD",
      coverage: {
        status: "user_confirmed_complete",
        observedFrom: "2024-02-15",
        observedTo: "2024-02-15",
      },
      totals: {
        grossOutflowsCents: 4000,
        refundsCents: 500,
        netSpendCents: 3500,
        incomeCents: 100000,
        unknownInflowsCents: 0,
      },
      comparison: {
        priorMonth: "2024-01",
        priorNetSpendCents: 3000,
        deltaCents: 500,
        deltaPercent: 16.7,
      },
      revision: { id: "revision-current" },
      transactions: [{ category: "groceries", category_override: "other" }],
    });
    expect(getSpending).toHaveBeenCalledTimes(2);
  });

  it("rejects a report if its revision changes while the snapshot is loading", async () => {
    await expect(
      getMonthlyReport(client("revision-late") as never, "user-1", "2024-02"),
    ).rejects.toThrow("revision changed while loading");
  });
});
