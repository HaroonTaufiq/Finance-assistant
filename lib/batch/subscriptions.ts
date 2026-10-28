import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages } from "@/lib/db/pagination";
import { findRecurringCandidates } from "./recurrence";

/**
 * Recurring-charge detection (PRD-A3, SPEC §7). Groups spend by normalized
 * merchant and looks for repeating intervals near weekly/monthly/annual with a
 * stable amount. Needs >=3 occurrences to avoid false positives on sparse data.
 * Idempotent: upsert on (user_id, merchant_norm); status is left untouched so a
 * user's 'dismissed' choice survives a recompute.
 */

interface SpendRow {
  id: string;
  merchant_norm: string;
  amount_cents: number;
  currency: string;
  txn_date: string;
  transaction_kind: "expense" | "refund" | "income" | "transfer" | "unknown";
  transaction_kind_override:
    | "expense"
    | "refund"
    | "income"
    | "transfer"
    | "unknown"
    | null;
}

export async function detectSubscriptions(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  const data = await fetchAllPages(
    supabase
    .from("transactions")
    .select("id, merchant_norm, amount_cents, currency, txn_date, transaction_kind, transaction_kind_override")
    .eq("user_id", userId)
    .lt("amount_cents", 0)
    .not("merchant_norm", "is", null)
    .order("txn_date", { ascending: true })
    .order("id", { ascending: true }),
    "subscriptions: fetch failed",
  );

  const candidates = findRecurringCandidates(
    (data as SpendRow[]).filter(
      (row) => (row.transaction_kind_override ?? row.transaction_kind) === "expense",
    ),
  );

  const { error: staleError } = await supabase
    .from("subscriptions")
    .update({ lifecycle_status: "stale" })
    .eq("user_id", userId)
    .eq("lifecycle_status", "active");
  if (staleError) throw new Error(`subscriptions: stale update failed: ${staleError.message}`);

  const upserts = candidates.map((candidate) => ({
    user_id: userId,
    ...candidate,
    lifecycle_status: "active",
  }));
  if (upserts.length > 0) {
    const { error: upErr } = await supabase
      .from("subscriptions")
      .upsert(upserts, { onConflict: "user_id,merchant_norm" });
    if (upErr) throw new Error(`subscriptions: upsert failed: ${upErr.message}`);
  }

  return upserts.length;
}
