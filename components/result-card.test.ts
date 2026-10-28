import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResultCard } from "./result-card";

describe("currency-aware report result cards", () => {
  it.each([
    ["PKR", "PKR"],
    ["EUR", "€"],
  ])("labels gross, refunds, and net spend in %s", (currency, expectedSymbol) => {
    const html = renderToStaticMarkup(createElement(ResultCard, {
      data: {
        kind: "spending",
        total_cents: 10000,
        gross_outflows_cents: 12000,
        refunds_cents: 2000,
        net_spend_cents: 10000,
        total_income_cents: 50000,
        unknown_inflows_cents: 0,
        currency,
        period: { start: "2024-04-01", end: "2024-04-30" },
        groupBy: null,
        breakdown: [],
      },
    }));

    expect(html).toContain("Gross outflows");
    expect(html).toContain("Refunds");
    expect(html).toContain("Net spend");
    expect(html).toContain(expectedSymbol);
    expect(html).not.toContain("$");
  });

  it("renders a corrected transaction with its actual currency and effective classification", () => {
    const html = renderToStaticMarkup(createElement(ResultCard, {
      data: {
        kind: "transactions",
        rows: [{
          date: "2024-04-15",
          merchant: "MARKET",
          category: "other",
          kind: "transfer",
          amount_cents: -10000,
          currency: "EUR",
        }],
        hasMore: false,
      },
    }));

    expect(html).toContain("other · transfer");
    expect(html).toContain("€");
    expect(html).not.toContain("$");
  });
});
