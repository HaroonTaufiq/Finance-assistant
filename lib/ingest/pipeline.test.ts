import { beforeEach, describe, expect, it, vi } from "vitest";

const { getServerClient, runBatchForUser } = vi.hoisted(() => ({
  getServerClient: vi.fn(),
  runBatchForUser: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ getServerClient }));
vi.mock("@/lib/batch", () => ({ runBatchForUser }));

import { ingestCsv } from "./pipeline";

describe("ingestCsv recovery", () => {
  const savedHashes = new Set<string>();
  const jobs = new Map<
    string,
    { id: string; affected_months: string[]; status: string; coverage_confirmed: boolean }
  >();

  beforeEach(() => {
    savedHashes.clear();
    jobs.clear();
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
            select: () => ({
              eq: () => ({
                neq: async () => ({
                  data: [...jobs.values()]
                    .filter((job) => job.status !== "complete")
                    .map(({ affected_months }) => ({ affected_months })),
                  error: null,
                }),
              }),
            }),
            update(input: { status: string }) {
              return {
                eq: () => ({
                  neq: async () => {
                    for (const [key, job] of jobs) {
                      if (job.status !== "complete") jobs.set(key, { ...job, status: input.status });
                    }
                    return { error: null };
                  },
                }),
              };
            },
          };
        }
        if (table === "transactions") {
          return {
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
