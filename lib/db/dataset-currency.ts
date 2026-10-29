import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export class DatasetCurrencyMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`This dataset uses ${expected}; ${actual} is not supported`);
    this.name = "DatasetCurrencyMismatchError";
  }
}

export class LegacyMixedCurrencyError extends Error {
  constructor() {
    super(
      "Existing transactions use multiple currencies. Resolve the legacy mixed-currency data before confirming one dataset currency; amounts are never converted automatically.",
    );
    this.name = "LegacyMixedCurrencyError";
  }
}

/**
 * Confirm a dataset currency once. Conditional updates avoid overwriting a
 * value that another request confirmed after this request's initial read.
 */
export async function ensureDatasetCurrency(
  supabase: SupabaseClient,
  userId: string,
  currency: string,
): Promise<void> {
  const { data: settings, error: settingsError } = await supabase
    .from("financial_settings")
    .select("currency")
    .eq("user_id", userId)
    .maybeSingle();
  if (settingsError) {
    throw new Error(`dataset currency lookup failed: ${settingsError.message}`);
  }

  const existingCurrency = settings?.currency as string | null | undefined;
  if (existingCurrency) {
    if (existingCurrency !== currency) {
      throw new DatasetCurrencyMismatchError(existingCurrency, currency);
    }
    return;
  }

  await assertLegacyRowsMatchCurrency(supabase, userId, currency);

  if (settings) {
    const { data: updated, error } = await supabase
      .from("financial_settings")
      .update({ currency, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .is("currency", null)
      .select("currency")
      .maybeSingle();
    if (error) throw new Error(`dataset currency setup failed: ${error.message}`);
    if (updated?.currency === currency) return;

    const confirmedCurrency = await readCurrency(supabase, userId);
    if (confirmedCurrency === currency) return;
    if (confirmedCurrency) {
      throw new DatasetCurrencyMismatchError(confirmedCurrency, currency);
    }
    throw new Error("Dataset currency changed concurrently; retry this request");
  }

  const { error: insertError } = await supabase
    .from("financial_settings")
    .insert({ user_id: userId, currency });
  if (!insertError) return;

  const confirmedCurrency = await readCurrency(supabase, userId);
  if (confirmedCurrency === currency) return;
  if (confirmedCurrency) {
    throw new DatasetCurrencyMismatchError(confirmedCurrency, currency);
  }
  throw new Error(`dataset currency setup failed: ${insertError.message}`);
}

async function assertLegacyRowsMatchCurrency(
  supabase: SupabaseClient,
  userId: string,
  currency: string,
): Promise<void> {
  const { data: otherCurrency, error: currencyError } = await supabase
    .from("transactions")
    .select("id")
    .eq("user_id", userId)
    .neq("currency", currency)
    .limit(1)
    .maybeSingle();
  if (currencyError) {
    throw new Error(`legacy transaction currency check failed: ${currencyError.message}`);
  }
  if (otherCurrency) throw new LegacyMixedCurrencyError();

  const { data: missingCurrency, error: missingCurrencyError } = await supabase
    .from("transactions")
    .select("id")
    .eq("user_id", userId)
    .is("currency", null)
    .limit(1)
    .maybeSingle();
  if (missingCurrencyError) {
    throw new Error(`legacy transaction currency check failed: ${missingCurrencyError.message}`);
  }
  if (missingCurrency) throw new LegacyMixedCurrencyError();
}

async function readCurrency(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("financial_settings")
    .select("currency")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`dataset currency verification failed: ${error.message}`);
  return (data?.currency as string | null | undefined) ?? null;
}
