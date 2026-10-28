import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { monthRange } from "@/lib/months";
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
  amount_cents: number;
  category: string;
  txn_date: string;
}

async function allMonths(supabase: SupabaseClient, userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("transactions")
    .select("txn_date")
    .eq("user_id", userId);
  if (error) throw new Error(`rollups: month scan failed: ${error.message}`);
  const months = new Set<string>();
  for (const r of (data as { txn_date: string }[] | null) ?? []) {
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
    const { data, error } = await supabase
      .from("transactions")
      .select("amount_cents, category, txn_date")
      .eq("user_id", userId)
      .gte("txn_date", start)
      .lt("txn_date", end);
    if (error) throw new Error(`rollups: fetch ${monthStart} failed: ${error.message}`);

    const aggregates = aggregateMonthlyRollups(
      ((data as TxnRow[] | null) ?? []).map(({ amount_cents, category }) => ({
        amount_cents,
        category,
      })),
    );
    const rows = aggregates.map((aggregate) => toRow(userId, monthStart, aggregate));

    const { error: upErr } = await supabase
      .from("rollups")
      .upsert(rows, { onConflict: "user_id,period_type,period_start,category" });
    if (upErr) throw new Error(`rollups: upsert ${monthStart} failed: ${upErr.message}`);
    written += rows.length;
  }

  return written;
}

function toRow(userId: string, periodStart: string, aggregate: RollupAggregate) {
  return {
    user_id: userId,
    period_type: "month",
    period_start: periodStart,
    category: aggregate.category,
    total_spend_cents: aggregate.total_spend_cents,
    total_income_cents: aggregate.total_income_cents,
    txn_count: aggregate.txn_count,
  };
}
