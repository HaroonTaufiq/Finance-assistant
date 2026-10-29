import { describe, expect, it, vi } from "vitest";
import {
  DatasetCurrencyMismatchError,
  ensureDatasetCurrency,
  LegacyMixedCurrencyError,
} from "./dataset-currency";

vi.mock("server-only", () => ({}));

interface CurrencyState {
  settings: { currency: string | null } | null;
  transactionCurrencies: (string | null)[];
  concurrentCurrency?: string;
  insertRaceCurrency?: string;
}

function client(state: CurrencyState) {
  return {
    from(table: string) {
      let action: "select" | "update" = "select";
      let updateValue: string | undefined;
      const filters = new Map<string, string | null>();
      const query = {
        select: () => query,
        eq(column: string, value: string) {
          filters.set(column, value);
          return query;
        },
        neq(column: string, value: string) {
          filters.set(`not-${column}`, value);
          return query;
        },
        is(column: string, value: null) {
          filters.set(`is-${column}`, value);
          return query;
        },
        limit: () => query,
        update(values: { currency: string }) {
          action = "update";
          updateValue = values.currency;
          return query;
        },
        insert(values: { currency: string }) {
          if (state.insertRaceCurrency) {
            state.settings = { currency: state.insertRaceCurrency };
            return Promise.resolve({ error: { message: "duplicate key" } });
          }
          if (state.settings) {
            return Promise.resolve({ error: { message: "duplicate key" } });
          }
          state.settings = { currency: values.currency };
          return Promise.resolve({ error: null });
        },
        async maybeSingle() {
          if (table === "financial_settings") {
            if (action === "update") {
              if (state.concurrentCurrency) {
                state.settings = { currency: state.concurrentCurrency };
              } else if (state.settings?.currency === null) {
                state.settings.currency = updateValue ?? null;
                return { data: { currency: state.settings.currency }, error: null };
              }
              return { data: null, error: null };
            }
            return { data: state.settings, error: null };
          }
          const queriedOtherCurrency = filters.get("not-currency");
          if (queriedOtherCurrency) {
            return {
              data: state.transactionCurrencies.some(
                (transactionCurrency) =>
                  transactionCurrency !== null && transactionCurrency !== queriedOtherCurrency,
              ) ? { id: "other-currency-row" } : null,
              error: null,
            };
          }
          return {
            data: state.transactionCurrencies.includes(null) ? { id: "null-currency-row" } : null,
            error: null,
          };
        },
      };
      return query;
    },
  };
}

describe("ensureDatasetCurrency", () => {
  it("creates a currency setting for a receipt-only account", async () => {
    const state: CurrencyState = { settings: null, transactionCurrencies: [] };
    await ensureDatasetCurrency(client(state) as never, "user-1", "PKR");
    expect(state.settings).toEqual({ currency: "PKR" });
  });

  it("fills a null legacy setting only after verifying its transactions use the selected currency", async () => {
    const state: CurrencyState = {
      settings: { currency: null },
      transactionCurrencies: ["USD", "USD"],
    };
    await ensureDatasetCurrency(client(state) as never, "user-1", "USD");
    expect(state.settings).toEqual({ currency: "USD" });
  });

  it("does not overwrite a currency confirmed concurrently", async () => {
    const state: CurrencyState = {
      settings: { currency: null },
      transactionCurrencies: [],
      concurrentCurrency: "EUR",
    };
    await expect(ensureDatasetCurrency(client(state) as never, "user-1", "USD"))
      .rejects.toBeInstanceOf(DatasetCurrencyMismatchError);
    expect(state.settings).toEqual({ currency: "EUR" });
  });

  it("blocks setting a single currency for legacy mixed or unknown-currency rows", async () => {
    for (const transactionCurrencies of [["USD", "EUR"], ["USD", null]]) {
      const state: CurrencyState = {
        settings: { currency: null },
        transactionCurrencies,
      };
      await expect(ensureDatasetCurrency(client(state) as never, "user-1", "USD"))
        .rejects.toBeInstanceOf(LegacyMixedCurrencyError);
      expect(state.settings).toEqual({ currency: null });
    }
  });

  it("accepts a concurrent first-setting insert only when it confirmed the same currency", async () => {
    const sameCurrency: CurrencyState = {
      settings: null,
      transactionCurrencies: [],
      insertRaceCurrency: "USD",
    };
    await ensureDatasetCurrency(client(sameCurrency) as never, "user-1", "USD");

    const conflictingCurrency: CurrencyState = {
      settings: null,
      transactionCurrencies: [],
      insertRaceCurrency: "EUR",
    };
    await expect(ensureDatasetCurrency(client(conflictingCurrency) as never, "user-1", "USD"))
      .rejects.toBeInstanceOf(DatasetCurrencyMismatchError);
  });
});
