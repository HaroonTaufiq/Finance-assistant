import { describe, expect, it } from "vitest";
import { monthRange, monthsInRange } from "./months";

describe("monthly reporting periods", () => {
  it("includes each calendar month touched by an inclusive date range", () => {
    expect(monthsInRange("2024-12-15", "2025-02-01")).toEqual([
      "2024-12-01",
      "2025-01-01",
      "2025-02-01",
    ]);
  });

  it("returns an exclusive next-month boundary across year end", () => {
    expect(monthRange("2024-12-01")).toEqual({
      start: "2024-12-01",
      end: "2025-01-01",
    });
  });
});
