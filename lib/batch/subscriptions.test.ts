import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { detectSubscriptions } from "./subscriptions";

describe("detectSubscriptions pagination", () => {
  it("finds recurring evidence that falls beyond the first 1,000 transactions", async () => {
    const transactions = [
      ...Array.from({ length: 1201 }, (_, index) => ({
        id: `row-${String(index).padStart(4, "0")}`,
        merchant_norm: "ONE-TIME SHOP",
        amount_cents: -100,
        currency: "USD",
        txn_date: `2024-01-${String((index % 31) + 1).padStart(2, "0")}`,
        transaction_kind: "expense" as const,
        transaction_kind_override: null,
      })),
      { id: "stream-1", merchant_norm: "STREAMCO", amount_cents: -1500, currency: "USD", txn_date: "2024-02-05", transaction_kind: "expense" as const, transaction_kind_override: null },
      { id: "stream-2", merchant_norm: "STREAMCO", amount_cents: -1500, currency: "USD", txn_date: "2024-03-05", transaction_kind: "expense" as const, transaction_kind_override: null },
      { id: "stream-3", merchant_norm: "STREAMCO", amount_cents: -1500, currency: "USD", txn_date: "2024-04-05", transaction_kind: "expense" as const, transaction_kind_override: null },
    ].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
    let start = 0;
    let end = 999;
    const query = {
      select: () => query,
      eq: () => query,
      lt: () => query,
      not: () => query,
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
    const upsert = vi.fn(async () => ({ error: null }));
    const update = vi.fn(() => ({
      eq: () => ({ eq: async () => ({ error: null }) }),
    }));
    const client = {
      from(table: string) {
        return table === "transactions"
          ? query
          : { upsert, update };
      },
    };

    const count = await detectSubscriptions(client as never, "user-1");

    expect(count).toBe(1);
    expect(upsert).toHaveBeenCalledWith(
      [expect.objectContaining({ merchant_norm: "STREAMCO", cadence_days: 30 })],
      { onConflict: "user_id,merchant_norm" },
    );
  });
});
