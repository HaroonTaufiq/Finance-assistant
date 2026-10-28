import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { monthRange } from "@/lib/months";
import { fetchAllPages } from "@/lib/db/pagination";
import { aggregateMonthlyRollups, type RollupAggregate } from "./rollup-math";

/**
 * Recompute monthly rollups (PRD-A3, SPEC §7). Per (month, category) plus a
 * `__all__` row per month. This precomputed table is the read path's workhorse:
 * its size scales with TIME PERIODS, not transaction count, so it survives
 * 10x-100x data. Idempotent upsert on the rollups PK.
 *
 * Aggregation runs in JS here (write path, runs once at ingest). At larger
 * scale this becomes a Postgres GROUP BY / date_trunc job — same table shape.
 */

interface TxnRow {
  id: string;
  amount_cents: number;
  category: string;
  category_override: string | null;
  txn_date: string;
  currency: string;
  transaction_kind: "expense" | "refund" | "income" | "transfer" | "unknown";
  transaction_kind_override: "expense" | "refund" | "income" | "transfer" | "unknown" | null;
}

async function allMonths(supabase: SupabaseClient, userId: string): Promise<string[]> {
  const rows = await fetchAllPages(
    supabase
    .from("transactions")
    .select("txn_date")
    .eq("user_id", userId)
    .order("txn_date", { ascending: true })
    .order("id", { ascending: true }),
    "rollups: month scan failed",
  );
  const months = new Set<string>();
  for (const r of rows as { txn_date: string }[]) {
    months.add(`${r.txn_date.slice(0, 7)}-01`);
  }
  return [...months];
}

export async function recomputeRollups(
  supabase: SupabaseClient,
  userId: string,
  months?: string[],
): Promise<number> {
  const targets = months && months.length > 0 ? months : await allMonths(supabase, userId);
  let written = 0;

  for (const monthStart of targets) {
    const { start, end } = monthRange(monthStart);
    const data = await fetchAllPages(
      supabase
      .from("transactions")
      .select("id, amount_cents, category, category_override, txn_date, currency, transaction_kind, transaction_kind_override")
      .eq("user_id", userId)
      .gte("txn_date", start)
      .lt("txn_date", end)
      .order("txn_date", { ascending: true })
      .order("id", { ascending: true }),
      `rollups: fetch ${monthStart} failed`,
    );

    const transactions = data as TxnRow[];
    const currencies = new Set(transactions.map((row) => row.currency));
    if (currencies.size > 1) {
      throw new Error(`rollups: mixed currencies in ${monthStart}; refusing to combine`);
    }

    const [currency] = currencies;
    if (!currency) {
      const { error: deleteError } = await supabase
        .from("rollups")
        .delete()
        .eq("user_id", userId)
        .eq("period_type", "month")
        .eq("period_start", monthStart);
      if (deleteError) {
        throw new Error(`rollups: clear empty month ${monthStart} failed: ${deleteError.message}`);
      }
      continue;
    }

    const aggregates = aggregateMonthlyRollups(
      transactions.map(({ amount_cents, category, category_override, transaction_kind, transaction_kind_override }) => ({
        amount_cents,
        category: category_override ?? category,
        kind: transaction_kind_override ?? transaction_kind,
      })),
    );
    const rows = aggregates.map((aggregate) => toRow(userId, monthStart, currency, aggregate));

    const { error: upErr } = await supabase
      .from("rollups")
      .upsert(rows, { onConflict: "user_id,period_type,period_start,category" });
    if (upErr) throw new Error(`rollups: upsert ${monthStart} failed: ${upErr.message}`);
    written += rows.length;
  }

  return written;
}

function toRow(
  userId: string,
  periodStart: string,
  currency: string,
  aggregate: RollupAggregate,
) {
  return {
    user_id: userId,
    period_type: "month",
    period_start: periodStart,
    currency,
    category: aggregate.category,
    total_spend_cents: aggregate.total_spend_cents,
    total_refund_cents: aggregate.total_refund_cents,
    net_spend_cents: aggregate.net_spend_cents,
    total_income_cents: aggregate.total_income_cents,
    total_unknown_inflow_cents: aggregate.total_unknown_inflow_cents,
    txn_count: aggregate.txn_count,
  };
}
