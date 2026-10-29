import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { getCurrentUser, getServerClient, runBatchForUser } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getServerClient: vi.fn(),
  runBatchForUser: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ getCurrentUser, getServerClient }));
vi.mock("@/lib/batch", () => ({ runBatchForUser }));
vi.mock("@/lib/db/user-write-lock", () => ({
  UserWriteLockBusyError: class UserWriteLockBusyError extends Error {},
  withUserWriteLock: (_client: unknown, _userId: string, operation: () => Promise<unknown>) => operation(),
}));
vi.mock("@/lib/db/dataset-currency", () => ({
  DatasetCurrencyMismatchError: class DatasetCurrencyMismatchError extends Error {},
  LegacyMixedCurrencyError: class LegacyMixedCurrencyError extends Error {},
  ensureDatasetCurrency: vi.fn(),
}));

import { POST } from "./route";
import { POST as retryReport } from "../../report/retry/route";

type Receipt = {
  id: string;
  status: string;
  linked_transaction_id: string | null;
};

type Transaction = {
  id: string;
  user_id: string;
  content_hash: string;
  txn_date: string;
  amount_cents: number;
  currency: string;
  merchant_norm: string | null;
  source_transaction_id: string | null;
};

function database() {
  const receipts = new Map<string, Receipt>();
  const jobs = new Map<string, {
    id: string;
    status: string;
    affected_months: string[];
    error_code: string | null;
  }>();
  const transactions: Transaction[] = [];
  let nextId = 0;
  let failReceiptUpdate = false;

  function from(table: string) {
    let action: "select" | "upsert" | "update" = "select";
    let values: Record<string, unknown> = {};
    const filters = new Map<string, unknown>();
    let upsertedTransaction: Transaction | null = null;
    const query: {
      select: (columns?: string) => typeof query;
      eq: (column: string, value: unknown) => typeof query | Promise<{ error: { message: string } | null }>;
      neq: (column: string, value: unknown) => typeof query;
      in: (column: string, values: unknown[]) => typeof query | Promise<{ error: { message: string } | null }>;
      is: (column: string, value: unknown) => typeof query;
      order: () => typeof query;
      range: (from: number, to: number) => Promise<{ data: unknown[]; error: null }>;
      maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
      single: () => Promise<{ data: unknown; error: { message: string } | null }>;
      upsert: (input: Record<string, unknown>) => typeof query;
      update: (input: Record<string, unknown>) => typeof query;
    } = {
      select() {
        return query;
      },
      eq(column, value) {
        filters.set(column, value);
        if (action === "update" && filters.size >= 2 && (table !== "import_jobs" || filters.has("id"))) {
          if (table === "receipts") {
            if (failReceiptUpdate) {
              failReceiptUpdate = false;
              return Promise.resolve({ error: { message: "injected receipt-link failure" } });
            }
            const receipt = receipts.get(String(filters.get("id")));
            if (receipt) Object.assign(receipt, values);
          } else if (table === "import_jobs") {
            const job = [...jobs.values()].find((candidate) => candidate.id === filters.get("id"));
            if (job) Object.assign(job, values);
          }
          return Promise.resolve({ error: null });
        }
        return query;
      },
      neq(column, value) {
        filters.set(`not-${column}`, value);
        return query;
      },
      in(column, items) {
        filters.set(`in-${column}`, items);
        if (action === "update" && table === "import_jobs") {
          for (const job of jobs.values()) {
            if ((items as string[]).includes(job.id)) Object.assign(job, values);
          }
          return Promise.resolve({ error: null });
        }
        return query;
      },
      is(column, value) {
        filters.set(column, value);
        return query;
      },
      order() {
        return query;
      },
      async range(from, to): Promise<{ data: unknown[]; error: null }> {
        if (table === "import_jobs") {
          const rows = [...jobs.values()].filter((job) =>
            !filters.has("not-status") || job.status !== filters.get("not-status"),
          );
          return { data: rows.slice(from, to + 1), error: null };
        }
        const rows = transactions.filter((transaction) =>
          ["txn_date", "amount_cents", "currency", "merchant_norm"].every((key) =>
            !filters.has(key) || transaction[key as keyof Transaction] === filters.get(key),
          ),
        );
        return { data: rows.slice(from, to + 1), error: null };
      },
      async maybeSingle() {
        if (table === "receipts") {
          return { data: receipts.get(String(filters.get("id"))) ?? null, error: null };
        }
        if (table === "import_jobs") {
          const job = jobs.get(String(filters.get("file_fingerprint")));
          return { data: job ?? null, error: null };
        }
        if (table === "transactions") {
          if (action === "upsert" && upsertedTransaction) {
            return { data: upsertedTransaction, error: null };
          }
          const transaction = transactions.find((candidate) => {
            for (const [key, value] of filters) {
              if (candidate[key as keyof Transaction] !== value) return false;
            }
            return true;
          });
          return { data: transaction ?? null, error: null };
        }
        throw new Error(`unexpected maybeSingle on ${table}`);
      },
      async single() {
        const job = jobs.get(String(values.file_fingerprint));
        return { data: job ?? null, error: null };
      },
      upsert(input) {
        action = "upsert";
        values = input;
        if (table === "import_jobs") {
          const fingerprint = String(input.file_fingerprint);
          const prior = jobs.get(fingerprint);
          const job = {
            id: prior?.id ?? `job-${jobs.size + 1}`,
            status: String(input.status),
            affected_months: input.affected_months as string[],
            error_code: typeof input.error_code === "string" ? input.error_code : null,
          };
          jobs.set(fingerprint, job);
        } else if (table === "transactions") {
          const hash = String(input.content_hash);
          const existing = transactions.find((transaction) => transaction.content_hash === hash);
          if (!existing) {
            upsertedTransaction = {
              ...(input as Omit<Transaction, "id">),
              id: `40000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
            };
            transactions.push(upsertedTransaction);
          } else {
            upsertedTransaction = null;
          }
        }
        return query;
      },
      update(input) {
        action = "update";
        values = input;
        return query;
      },
    };
    return query;
  }

  return {
    receipts,
    jobs,
    transactions,
    client: { from } as never,
    failNextReceiptUpdate() {
      failReceiptUpdate = true;
    },
    addReceipt(id: string) {
      receipts.set(id, { id, status: "pending", linked_transaction_id: null });
    },
  };
}

const userId = "00000000-0000-4000-8000-000000000001";
const fields = {
  merchant: "Coffee House",
  date: "2024-04-15",
  total_cents: 500,
  currency: "USD",
  lineItems: [],
  confidence: 1,
};

async function post(body: Record<string, unknown>) {
  const response = await POST(new NextRequest("http://localhost/api/receipts/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function postRetry() {
  const response = await retryReport();
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("receipt confirmation revisions", () => {
  let db: ReturnType<typeof database>;

  beforeEach(() => {
    db = database();
    getCurrentUser.mockResolvedValue({ id: userId });
    getServerClient.mockResolvedValue(db.client);
    runBatchForUser.mockReset().mockResolvedValue({});
  });

  it("keeps distinct identical receipts as separate purchases and replays each idempotently", async () => {
    const receiptIds = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
    ];
    receiptIds.forEach((id) => db.addReceipt(id));

    const first = await post({ receiptId: receiptIds[0], fields });
    expect(first.status).toBe(200);
    const conflict = await post({ receiptId: receiptIds[1], fields });
    expect(conflict.body).toMatchObject({
      conflict: { existingTransactions: [{ id: "40000000-0000-4000-8000-000000000001" }] },
    });

    const kept = await post({ receiptId: receiptIds[1], fields, resolveConflict: "keep" });
    expect(kept.status).toBe(200);
    expect(db.transactions).toHaveLength(2);
    expect(db.transactions[0]?.id).not.toBe(db.transactions[1]?.id);

    const multipleMatches = await post({ receiptId: receiptIds[2], fields });
    expect(multipleMatches.body).toMatchObject({
      conflict: {
        existingTransactions: [
          { id: "40000000-0000-4000-8000-000000000001" },
          { id: "40000000-0000-4000-8000-000000000002" },
        ],
      },
    });
    const merged = await post({
      receiptId: receiptIds[2],
      fields,
      resolveConflict: "merge",
      mergeTransactionId: "40000000-0000-4000-8000-000000000002",
    });
    expect(merged).toMatchObject({ status: 200, body: { transactionId: "40000000-0000-4000-8000-000000000002" } });
    expect(db.transactions).toHaveLength(2);

    for (const [index, id] of receiptIds.slice(0, 2).entries()) {
      const replay = await post({ receiptId: id, fields });
      expect(replay).toMatchObject({
        status: 200,
        body: { transactionId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` },
      });
    }
    expect(db.transactions).toHaveLength(2);
  });

  it("records a failed revision after transaction persistence and retries without duplicating it", async () => {
    const receiptId = "20000000-0000-4000-8000-000000000001";
    db.addReceipt(receiptId);
    db.failNextReceiptUpdate();

    const failed = await post({ receiptId, fields });
    expect(failed.status).toBe(503);
    expect(db.transactions).toHaveLength(1);
    expect([...db.jobs.values()][0]?.status).toBe("failed");
    expect(db.receipts.get(receiptId)?.status).toBe("pending");

    const retried = await post({ receiptId, fields });
    expect(retried.status).toBe(200);
    expect(db.transactions).toHaveLength(1);
    expect(db.receipts.get(receiptId)?.linked_transaction_id)
      .toBe("40000000-0000-4000-8000-000000000001");
    expect([...db.jobs.values()][0]?.status).toBe("complete");
  });

  it("makes persisted receipt data unavailable as a current report until derivation retry succeeds", async () => {
    const receiptId = "30000000-0000-4000-8000-000000000001";
    db.addReceipt(receiptId);
    runBatchForUser.mockRejectedValueOnce(new Error("injected rollup failure"));

    const failed = await post({ receiptId, fields });
    expect(failed.status).toBe(503);
    expect([...db.jobs.values()][0]?.status).toBe("failed");

    runBatchForUser.mockResolvedValueOnce({});
    const retried = await postRetry();
    expect(retried.status).toBe(200);
    expect([...db.jobs.values()][0]?.status).toBe("complete");
  });

  it("retries a failed receipt merge against its already linked transaction", async () => {
    const firstReceipt = "40000000-0000-4000-8000-000000000001";
    const mergedReceipt = "50000000-0000-4000-8000-000000000001";
    db.addReceipt(firstReceipt);
    db.addReceipt(mergedReceipt);
    const first = await post({ receiptId: firstReceipt, fields });
    expect(first.status).toBe(200);
    const conflict = await post({ receiptId: mergedReceipt, fields });
    const existingId = (conflict.body as {
      conflict: { existingTransactions: { id: string }[] };
    }).conflict.existingTransactions[0]!.id;

    runBatchForUser.mockRejectedValueOnce(new Error("injected merge derivation failure"));
    const mergeRequest = {
      receiptId: mergedReceipt,
      fields,
      resolveConflict: "merge",
      mergeTransactionId: existingId,
    };
    expect((await post(mergeRequest)).status).toBe(503);
    expect(db.receipts.get(mergedReceipt)?.linked_transaction_id).toBe(existingId);

    const retry = await post(mergeRequest);
    expect(retry).toMatchObject({ status: 200, body: { transactionId: existingId } });
    expect(db.transactions).toHaveLength(1);
    expect([...db.jobs.values()].find((job) => job.affected_months[0] === "2024-04-01" && job.id !== "job-1")?.status)
      .toBe("complete");
  });
});
