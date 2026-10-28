import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseTransactions } from "./parse";
import { dedupeInBatch, contentHash } from "./dedup";

const fixture = readFileSync(
  new URL("../../fixtures/sample-transactions.csv", import.meta.url),
  "utf8",
);

describe("parseTransactions (sample fixture)", () => {
  const result = parseTransactions(fixture);

  it("validates the well-formed rows (incl. the duplicate as valid)", () => {
    expect(result.valid.length).toBe(24);
  });

  it("requires explicit interpretation for an ambiguous locale date when configured", () => {
    const csv = "Date,Description,Amount\n04/05/2024,Coffee,-4.50\n";
    expect(parseTransactions(csv, "csv", { dateOrder: null }).valid).toHaveLength(0);
    expect(parseTransactions(csv, "csv", { dateOrder: "DMY" }).valid[0]?.txn_date).toBe(
      "2024-05-04",
    );
  });

  it("quarantines the missing-amount and junk rows, never drops them", () => {
    expect(result.errors.length).toBe(2);
    const reasons = result.errors.map((e) => e.reason);
    expect(reasons).toContain("missing or unparseable amount");
    expect(reasons).toContain("missing or unparseable date");
  });

  it("parses decorated amounts to signed cents", () => {
    const oliveGarden = result.valid.find((t) => t.merchant_norm === "OLIVE GARDEN");
    expect(oliveGarden?.amount_cents).toBe(-5420); // ($54.20)
    const costco = result.valid.find((t) => t.merchant_norm === "COSTCO");
    expect(costco?.amount_cents).toBe(-120455); // -1,204.55
  });

  it("normalizes merchants so variants cluster", () => {
    const wholeFoods = result.valid.filter((t) => t.merchant_norm === "WHOLE FOODS MARKET");
    expect(wholeFoods.length).toBe(4); // incl. the duplicate
  });
});

describe("dedupeInBatch", () => {
  it("preserves same-content rows and reports their overlap as uncertain", () => {
    const { valid } = parseTransactions(fixture);
    const { rows, inFileDuplicates, possibleDuplicates } = dedupeInBatch("user-1", valid);
    expect(inFileDuplicates).toBe(0);
    expect(possibleDuplicates).toBe(1);
    expect(rows.length).toBe(24);
  });

  it("produces a stable, user-scoped content hash", () => {
    const { valid } = parseTransactions(fixture);
    const a = dedupeInBatch("user-1", valid).rows[0]!;
    const b = dedupeInBatch("user-1", valid).rows[0]!;
    expect(a.content_hash).toBe(b.content_hash);
    // Different user -> different hash for the same transaction.
    const other = contentHash("user-2", valid[0]!);
    expect(other).not.toBe(a.content_hash);
  });

  it("preserves identical purchases when no stable source transaction ID exists", () => {
    const csv = [
      "Date,Description,Amount",
      "04/15/2024,Coffee Shop,-4.50",
      "04/15/2024,Coffee Shop,-4.50",
    ].join("\n");
    const { valid } = parseTransactions(csv);
    const firstImport = dedupeInBatch("user-1", valid);
    const retry = dedupeInBatch("user-1", valid);

    expect(firstImport.rows).toHaveLength(2);
    expect(firstImport.rows.map((row) => row.content_hash)).toEqual(
      retry.rows.map((row) => row.content_hash),
    );
    expect(firstImport.inFileDuplicates).toBe(0);
  });
});

describe("normalizeRow column detection", () => {
  it("handles separate debit/credit columns", () => {
    const csv =
      "Date,Description,Debit,Credit\n" +
      "01/05/2024,Coffee,4.50,\n" +
      "01/06/2024,Refund,,10.00\n";
    const { valid, errors } = parseTransactions(csv);
    expect(errors.length).toBe(0);
    expect(valid[0]?.amount_cents).toBe(-450); // debit -> spend
    expect(valid[1]?.amount_cents).toBe(1000); // credit -> income
  });

  it("reports a clear error when essential columns are absent", () => {
    const csv = "Foo,Bar\n1,2\n3,4\n";
    const { valid, errors } = parseTransactions(csv);
    expect(valid.length).toBe(0);
    expect(errors.length).toBe(2);
    expect(errors[0]?.reason).toMatch(/could not detect/);
  });

  it("uses explicit mappings when source headers are not recognized", () => {
    const csv = "Posted At,Value,Payee\n2024-01-05,-4.50,Coffee\n";
    const { valid, errors } = parseTransactions(csv, "csv", {
      dateOrder: "MDY",
      columnMapping: { date: "Posted At", amount: "Value", merchant: "Payee" },
    });

    expect(errors).toHaveLength(0);
    expect(valid[0]).toMatchObject({
      txn_date: "2024-01-05",
      amount_cents: -450,
      merchant_norm: "COFFEE",
    });
  });
});
