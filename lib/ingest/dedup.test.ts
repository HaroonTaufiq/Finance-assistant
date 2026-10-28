import { describe, expect, it } from "vitest";
import { parseTransactions } from "./parse";
import {
  OverlapReviewRequiredError,
  dedupeInBatch,
  resolveImportOverlaps,
} from "./dedup";

const userId = "user-1";

function parse(csv: string) {
  const result = parseTransactions(csv);
  expect(result.errors).toHaveLength(0);
  return result.valid;
}

describe("source-less import overlap review", () => {
  it("stages an overlap and applies explicit match-existing or keep-as-new choices", () => {
    const first = parse("Date,Description,Amount\n04/15/2024,COFFEE,-5.00\n");
    const history = dedupeInBatch(userId, first).rows.map((row, index) => ({
      ...row,
      id: `existing-${index}`,
      source_transaction_id: null,
      import_job_id: "job-first",
    }));
    const overlap = parse([
      "Date,Description,Amount",
      "04/15/2024,COFFEE,-5.00",
      "04/15/2024,BREAD,-4.00",
    ].join("\n"));

    let review: OverlapReviewRequiredError | undefined;
    try {
      resolveImportOverlaps({ userId, transactions: overlap, existing: history });
    } catch (error) {
      if (error instanceof OverlapReviewRequiredError) review = error;
      else throw error;
    }
    expect(review?.candidates).toHaveLength(1);
    expect(review?.candidates[0]).toMatchObject({
      date: "2024-04-15",
      amount_cents: -500,
      merchant: "COFFEE",
      existingCount: 1,
    });

    const match = resolveImportOverlaps({
      userId,
      transactions: overlap,
      existing: history,
      decisions: { [review!.candidates[0]!.key]: "match-existing" },
    });
    expect(match.rows.map((row) => row.merchant_norm)).toEqual(["BREAD"]);
    expect(match.matchedExisting).toBe(1);

    const keep = resolveImportOverlaps({
      userId,
      transactions: overlap,
      existing: history,
      decisions: { [review!.candidates[0]!.key]: "keep-as-new" },
    });
    expect(keep.rows.map((row) => row.merchant_norm)).toEqual(["COFFEE", "BREAD"]);
    expect(keep.rows[0]?.content_hash).not.toBe(history[0]?.content_hash);
  });

  it("keeps legitimate repeated purchases distinct and hashes them independently of file formatting", () => {
    const rows = parse([
      "Date,Description,Amount",
      "04/15/2024,COFFEE,-5.00",
      "04/15/2024,COFFEE,-5.00",
    ].join("\n"));
    const reordered = parse([
      "Date,Description,Amount",
      "04/15/2024,COFFEE,-5.00",
      "04/15/2024,COFFEE,-5.00",
    ].join("\r\n"));
    const first = dedupeInBatch(userId, rows);
    const second = dedupeInBatch(userId, reordered);

    expect(first.rows).toHaveLength(2);
    expect(new Set(first.rows.map((row) => row.content_hash)).size).toBe(2);
    expect(first.rows.map((row) => row.content_hash)).toEqual(
      second.rows.map((row) => row.content_hash),
    );
    expect(first.possibleDuplicates).toBe(1);
  });

  it("replays rows already persisted by the same failed job without reapplying overlap decisions", () => {
    const transactions = parse("Date,Description,Amount\n04/15/2024,COFFEE,-5.00\n");
    const currentJobRows = dedupeInBatch(userId, transactions).rows.map((row, index) => ({
      ...row,
      id: `job-row-${index}`,
      source_transaction_id: null,
      import_job_id: "job-retry",
    }));

    const result = resolveImportOverlaps({
      userId,
      transactions,
      existing: currentJobRows,
      retryJobId: "job-retry",
    });

    expect(result.rows).toHaveLength(0);
    expect(result.matchedExisting).toBe(1);
  });
});
