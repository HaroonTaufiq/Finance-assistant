import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { recomputeRollups } from "./rollups";

describe("recomputeRollups pagination", () => {
  it("includes every transaction above the PostgREST 1,000-row cap", async () => {
    const transactions = Array.from({ length: 1201 }, (_, index) => ({
      id: `row-${String(index).padStart(4, "0")}`,
      amount_cents: -100,
      category: "dining",
      txn_date: `2024-04-${String((index % 30) + 1).padStart(2, "0")}`,
      currency: "USD",
      transaction_kind: "expense" as const,
    }));
    let upserted: Record<string, unknown>[] = [];
    let start = 0;
    let end = 999;
    const query = {
      select: () => query,
      eq: () => query,
      gte: () => query,
      lt: () => query,
      order: () => query,
      range(from: number, to: number) {
        start = from;
        end = to;
        return query;
      },
      then(resolve: (result: { data: typeof transactions; error: null }) => unknown) {
        return Promise.resolve({
          data: transactions.slice(start, Math.min(end + 1, start + 1000)),
          error: null,
        }).then(resolve);
      },
    };
    const client = {
      from(table: string) {
        if (table === "transactions") return query;
        return {
          upsert(rows: Record<string, unknown>[]) {
            upserted = rows;
            return Promise.resolve({ error: null });
          },
        };
      },
    };

    await recomputeRollups(client as never, "user-1", ["2024-04-01"]);

    expect(upserted.find((row) => row.category === "__all__")).toMatchObject({
      total_spend_cents: 120100,
      txn_count: 1201,
    });
  });
});
