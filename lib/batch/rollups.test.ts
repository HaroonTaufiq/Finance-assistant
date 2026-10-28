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
    let replaced: Record<string, unknown>[] = [];
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
      from() {
        return query;
      },
      rpc(_name: string, args: { p_rows: Record<string, unknown>[] }) {
        replaced = args.p_rows;
        return Promise.resolve({ error: null });
      },
    };

    await recomputeRollups(client as never, "user-1", ["2024-04-01"]);

    expect(replaced.find((row) => row.category === "__all__")).toMatchObject({
      total_spend_cents: 120100,
      txn_count: 1201,
    });
  });

  it("replaces a corrected month with only its current categories", async () => {
    const transactions = [{
      id: "last-grocery-row",
      amount_cents: -1000,
      category: "groceries",
      category_override: "other",
      txn_date: "2024-04-15",
      currency: "USD",
      transaction_kind: "expense" as const,
      transaction_kind_override: null,
    }];
    let replaced: Record<string, unknown>[] = [];
    const query = {
      select: () => query,
      eq: () => query,
      gte: () => query,
      lt: () => query,
      order: () => query,
      range: () => query,
      then: (resolve: (result: { data: typeof transactions; error: null }) => unknown) =>
        Promise.resolve({ data: transactions, error: null }).then(resolve),
    };
    const client = {
      from: () => query,
      rpc(_name: string, args: { p_rows: Record<string, unknown>[] }) {
        replaced = args.p_rows;
        return Promise.resolve({ error: null });
      },
    };

    await recomputeRollups(client as never, "user-1", ["2024-04-01"]);

    expect(replaced.map((row) => row.category).sort()).toEqual(["__all__", "other"]);
    expect(replaced.find((row) => row.category === "__all__")).toMatchObject({
      total_spend_cents: 1000,
      txn_count: 1,
    });
  });

  it("fails the revision when the atomic month replacement fails", async () => {
    const transactions = [{
      id: "row",
      amount_cents: -100,
      category: "dining",
      category_override: null,
      txn_date: "2024-04-15",
      currency: "USD",
      transaction_kind: "expense" as const,
      transaction_kind_override: null,
    }];
    const query = {
      select: () => query,
      eq: () => query,
      gte: () => query,
      lt: () => query,
      order: () => query,
      range: () => query,
      then: (resolve: (result: { data: typeof transactions; error: null }) => unknown) =>
        Promise.resolve({ data: transactions, error: null }).then(resolve),
    };
    const client = {
      from: () => query,
      rpc: () => Promise.resolve({ error: { message: "injected replacement failure" } }),
    };

    await expect(recomputeRollups(client as never, "user-1", ["2024-04-01"]))
      .rejects.toThrow("injected replacement failure");
  });
});
