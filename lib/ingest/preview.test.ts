import { describe, expect, it } from "vitest";
import { parseTransactions } from "./parse";
import { countImportOverlaps } from "./preview";

describe("countImportOverlaps", () => {
  it("distinguishes stable source-ID duplicates from uncertain identical rows", () => {
    const csv = [
      "Date,Description,Amount,Account,Transaction ID",
      "04/15/2024,Coffee,-4.50,checking,tx-1",
      "04/15/2024,Coffee,-4.50,checking,tx-1",
      "04/16/2024,Coffee,-4.50,checking,",
      "04/16/2024,Coffee,-4.50,checking,",
    ].join("\n");
    const { valid } = parseTransactions(csv);

    expect(countImportOverlaps(valid)).toEqual({
      duplicateSourceIds: 1,
      possibleDuplicates: 1,
    });
  });
});
