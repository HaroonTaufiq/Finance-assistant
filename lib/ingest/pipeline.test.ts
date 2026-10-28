import { beforeEach, describe, expect, it, vi } from "vitest";

const { getServerClient, runBatchForUser } = vi.hoisted(() => ({
  getServerClient: vi.fn(),
  runBatchForUser: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ getServerClient }));
vi.mock("@/lib/batch", () => ({ runBatchForUser }));

import { ingestCsv } from "./pipeline";
import { OverlapReviewRequiredError, type ExistingSourceLessTransaction } from "./dedup";

describe("ingestCsv recovery", () => {
  const savedHashes = new Set<string>();
  const jobs = new Map<
    string,
    { id: string; affected_months: string[]; status: string; coverage_confirmed: boolean }
  >();
  let existingTransactions: ExistingSourceLessTransaction[] = [];

  beforeEach(() => {
    savedHashes.clear();
    jobs.clear();
    existingTransactions = [];
    getServerClient.mockReset();
    runBatchForUser.mockReset();

    getServerClient.mockResolvedValue({
      from(table: string) {
        if (table === "financial_settings") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { currency: "USD" }, error: null }),
              }),
            }),
            insert: async () => ({ error: null }),
          };
        }
        if (table === "import_jobs") {
          return {
            upsert(input: {
              file_fingerprint: string;
              affected_months: string[];
              status: string;
              coverage_confirmed: boolean;
            }) {
              const prior = jobs.get(input.file_fingerprint);
              const job = {
                id: prior?.id ?? `job-${jobs.size + 1}`,
                affected_months: input.affected_months,
                status: input.status,
                coverage_confirmed: input.coverage_confirmed,
              };
              jobs.set(input.file_fingerprint, job);
              return {
                select: () => ({ single: async () => ({ data: { id: job.id }, error: null }) }),
              };
            },
            select: () => {
              const filters: [string, unknown][] = [];
              const builder = {
                eq(column: string, value: unknown) {
                  filters.push([column, value]);
                  return builder;
                },
                neq: async (column: string, value: unknown) => ({
                  data: [...jobs.values()]
                    .filter((job) => column !== "status" || job.status !== value)
                    .map(({ id, affected_months }) => ({ id, affected_months })),
                  error: null,
                }),
                maybeSingle: async () => {
                  const fingerprint = filters.find(([column]) => column === "file_fingerprint")?.[1];
                  const job = typeof fingerprint === "string" ? jobs.get(fingerprint) : undefined;
                  return {
                    data: job
                      ? { id: job.id, status: job.status, review_decisions: {} }
                      : null,
                    error: null,
                  };
                },
              };
              return builder;
            },
            update(input: { status: string }) {
              return {
                eq: () => ({
                  in: async (_column: string, ids: string[]) => {
                    for (const [key, job] of jobs) {
                      if (ids.includes(job.id)) jobs.set(key, { ...job, status: input.status });
                    }
                    return { error: null };
                  },
                }),
              };
            },
          };
        }
        if (table === "transactions") {
          const query = {
            select: () => query,
            eq: () => query,
            gte: () => query,
            lte: () => query,
            order: () => query,
            range: async () => ({ data: existingTransactions, error: null }),
          };
          return {
            ...query,
            upsert(rows: { content_hash: string; txn_date: string }[]) {
              return {
                async select() {
                  const data = rows.filter((row) => {
                    if (savedHashes.has(row.content_hash)) return false;
                    savedHashes.add(row.content_hash);
                    return true;
                  });
                  return { data, error: null };
                },
              };
            },
          };
        }
        return { insert: async () => ({ error: null }) };
      },
      rpc: async (name: string) => ({
        data: name === "acquire_user_write_lock" ? true : true,
        error: null,
      }),
    });
  });

  it("recomputes persisted months after a failed batch when every row is now a duplicate", async () => {
    const csv = "Date,Description,Amount\n04/15/2024,Corner Shop,-12.00\n";
    runBatchForUser
      .mockRejectedValueOnce(new Error("derived write failed"))
      .mockResolvedValueOnce({ rollups: 1, subscriptions: 0, anomalies: 0, categorized: 0 });

    const args = {
      userId: "user-1",
      csv,
      currency: "USD" as const,
      dateOrder: "MDY" as const,
      coverageConfirmed: false,
    };
    await expect(ingestCsv(args)).rejects.toThrow("derived write failed");
    expect(savedHashes.size).toBe(1);

    const retry = await ingestCsv(args);

    expect(retry).toMatchObject({ imported: 0, duplicates: 1 });
    expect(runBatchForUser).toHaveBeenCalledTimes(2);
    expect(runBatchForUser).toHaveBeenLastCalledWith("user-1", {
      affectedMonths: ["2024-04-01"],
    });
    expect([...jobs.values()][0]?.status).toBe("complete");
  });

  it("does not complete an import job created after its derivation snapshot", async () => {
    runBatchForUser.mockImplementationOnce(async () => {
      jobs.set("late-may", {
        id: "job-late-may",
        affected_months: ["2024-05-01"],
        status: "processing",
        coverage_confirmed: false,
      });
      return { rollups: 1, subscriptions: 0, anomalies: 0, categorized: 0 };
    });

    await ingestCsv({
      userId: "user-1",
      csv: "Date,Description,Amount\n04/15/2024,April coffee,-12.00\n",
      currency: "USD",
      dateOrder: "MDY",
      coverageConfirmed: false,
    });

    expect(jobs.get("late-may")?.status).toBe("processing");
    expect([...jobs.values()].find((job) => job.affected_months.includes("2024-04-01"))?.status)
      .toBe("complete");
  });

  it("does not persist an uncertain overlap until the user chooses match or keep", async () => {
    existingTransactions = [{
      id: "prior-coffee",
      content_hash: "previous-hash",
      txn_date: "2024-04-15",
      amount_cents: -500,
      currency: "USD",
      source_account_id: null,
      merchant_norm: "COFFEE",
      description: "COFFEE",
      source_transaction_id: null,
      import_job_id: "prior-job",
    }];
    const args = {
      userId: "user-1",
      csv: "Date,Description,Amount\n04/15/2024,COFFEE,-5.00\n04/16/2024,BREAD,-4.00\n",
      currency: "USD" as const,
      dateOrder: "MDY" as const,
      coverageConfirmed: false,
    };
    const result = await ingestCsv(args).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(OverlapReviewRequiredError);
    if (!(result instanceof OverlapReviewRequiredError)) {
      throw new Error("expected an overlap decision to be required");
    }
    expect(jobs.size).toBe(0);
    expect(savedHashes.size).toBe(0);

    const summary = await ingestCsv({
      ...args,
      overlapDecisions: { [result.candidates[0]!.key]: "match-existing" },
    });

    expect(summary).toMatchObject({ imported: 1, duplicates: 1, possibleDuplicates: 0 });
    expect(savedHashes.size).toBe(1);
    expect([...jobs.values()][0]?.status).toBe("complete");
  });

  it("rejects a second currency before inserting any transaction", async () => {
    const csv = "Date,Description,Amount\n04/15/2024,Coffee Shop,-12.00\n";

    await expect(
      ingestCsv({
        userId: "user-1",
        csv,
        currency: "EUR",
        dateOrder: "MDY",
        coverageConfirmed: false,
      }),
    ).rejects.toThrow(/dataset uses USD/i);

    expect(savedHashes.size).toBe(0);
    expect(runBatchForUser).not.toHaveBeenCalled();
  });

  it("does not claim complete coverage when rows were quarantined", async () => {
    const csv = "Date,Description,Amount\n04/15/2024,Coffee Shop,-12.00\nnot-a-date,Missing date,-8.00\n";

    await ingestCsv({
      userId: "user-1",
      csv,
      currency: "USD",
      dateOrder: "MDY",
      coverageConfirmed: true,
    });

    expect([...jobs.values()][0]?.coverage_confirmed).toBe(false);
  });
});
