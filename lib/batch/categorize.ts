import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Rules-first categorization (PRD-A3, SPEC §7). Cheap deterministic merchant/
 * keyword rules run in SQL; only rows that remain uncategorized would fall
 * through to a single *batched* cheap-model call — never one model call per row.
 *
 * The model fallthrough hook is intentionally left as a no-op until the model
 * layer (B1 models.ts) lands; unmatched rows simply stay 'uncategorized'.
 */

// category -> substrings to match against the normalized merchant (uppercased).
const RULES: Record<string, string[]> = {
  subscriptions: ["NETFLIX", "SPOTIFY", "HULU", "DISNEY", "YOUTUBE", "PRIME VIDEO", "ICLOUD", "DROPBOX", "PATREON"],
  groceries: ["WHOLE FOODS", "TRADER JOE", "SAFEWAY", "KROGER", "ALDI", "COSTCO", "GROCER", "SUPERMARKET", "WALMART"],
  dining: ["STARBUCKS", "BLUE BOTTLE", "MCDONALD", "CHIPOTLE", "OLIVE GARDEN", "DINER", "CAFE", "COFFEE", "RESTAURANT", "PIZZA", "DOORDASH", "UBER EATS"],
  transport: ["UBER", "LYFT", "SHELL", "CHEVRON", "EXXON", "GAS", "BP ", "METRO", "TRANSIT", "PARKING"],
  utilities: ["COMCAST", "XFINITY", "AT&T", "VERIZON", "PG&E", "ELECTRIC", "WATER", "UTILITY"],
  shopping: ["AMAZON", "TARGET", "BEST BUY", "EBAY", "ETSY", "IKEA"],
  health: ["CVS", "WALGREENS", "PHARMACY", "CLINIC", "DENTAL", "MEDICAL"],
  rent: ["RENT", "LANDLORD", "PROPERTY MGMT", "APARTMENT"],
  income: ["PAYROLL", "DIRECT DEPOSIT", "SALARY"],
};

/** Apply deterministic rules to uncategorized rows. Returns count categorized. */
export async function categorize(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  let categorized = 0;

  for (const [category, needles] of Object.entries(RULES)) {
    // OR of ilike filters across the merchant; one UPDATE per category.
    const orFilter = needles
      .map((n) => `merchant_norm.ilike.%${n}%`)
      .join(",");

    const { data, error } = await supabase
      .from("transactions")
      .update({ category })
      .eq("user_id", userId)
      .eq("category", "uncategorized")
      .is("category_override", null)
      .or(orFilter)
      .select("id");

    if (error) throw new Error(`categorize(${category}) failed: ${error.message}`);
    categorized += data?.length ?? 0;
  }

  return categorized;
  // TODO(B1): batched cheap-model fallthrough for rows still 'uncategorized'.
}
