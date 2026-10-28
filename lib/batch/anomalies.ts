import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatCents } from "@/lib/utils";
import { fetchAllPages } from "@/lib/db/pagination";

/**
 * Out-of-pattern flags (PRD-A3, SPEC §7). Ships a z-score / rolling-baseline
 * heuristic — the ML upgrade path (seasonal models, embeddings) is named in the
 * README, not built. Idempotent: clears prior 'new' flags before recomputing,
 * preserving any the user has marked 'seen'/'dismissed'.
 *
 * Three signals:
 *  - amount_spike:   z-score of a spend vs its category's distribution
 *  - new_merchant:   a merchant whose first-ever charge is in the latest month
 *  - category_spike: a category's latest-month spend far above its prior average
 */

interface Row {
  id: string;
  amount_cents: number;
  category: string;
  category_override: string | null;
  merchant_norm: string | null;
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

const Z_THRESHOLD = 3;
const CATEGORY_SPIKE_FACTOR = 1.5;

function monthOf(date: string): string {
  return date.slice(0, 7); // YYYY-MM
}

export async function scoreAnomalies(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  // Idempotent recompute: drop only auto-generated 'new' flags.
  const { error: delErr } = await supabase
    .from("anomalies")
    .delete()
    .eq("user_id", userId)
    .eq("status", "new");
  if (delErr) throw new Error(`anomalies: clear failed: ${delErr.message}`);

  const rows = await fetchAllPages(
    supabase
    .from("transactions")
    .select("id, amount_cents, category, category_override, merchant_norm, txn_date, transaction_kind, transaction_kind_override")
    .eq("user_id", userId)
    .lt("amount_cents", 0)
    .order("txn_date", { ascending: true })
    .order("id", { ascending: true }),
    "anomalies: fetch failed",
  );

  const transactions = (rows as Row[])
    .filter((row) => (row.transaction_kind_override ?? row.transaction_kind) === "expense")
    .map((row) => ({ ...row, category: row.category_override ?? row.category }));
  if (transactions.length === 0) return 0;

  const latestMonth = transactions.reduce((m, r) => (monthOf(r.txn_date) > m ? monthOf(r.txn_date) : m), "");
  const flags: Record<string, unknown>[] = [];

  // ---- amount_spike: per-category z-score --------------------------------
  const byCat = new Map<string, Row[]>();
  for (const r of transactions) {
    const list = byCat.get(r.category) ?? [];
    list.push(r);
    byCat.set(r.category, list);
  }
  for (const [category, catRows] of byCat) {
    if (catRows.length < 4) continue; // too few to model a distribution
    const amounts = catRows.map((r) => Math.abs(r.amount_cents));
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const std = Math.sqrt(
      amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length,
    );
    if (std === 0) continue; // constant amounts -> no spike
    for (const r of catRows) {
      const z = (Math.abs(r.amount_cents) - mean) / std;
      if (z > Z_THRESHOLD) {
        flags.push({
          user_id: userId,
          transaction_id: r.id,
          type: "amount_spike",
          score: Number(z.toFixed(2)),
          reason: `${formatCents(Math.abs(r.amount_cents))} at ${r.merchant_norm ?? "unknown"} is unusually large for ${category} (${z.toFixed(1)}σ above your typical ${category} spend).`,
        });
      }
    }
  }

  // ---- new_merchant: first-ever charge lands in the latest month ----------
  const firstSeen = new Map<string, Row>();
  for (const r of transactions) {
    if (!r.merchant_norm) continue;
    const prev = firstSeen.get(r.merchant_norm);
    if (!prev || r.txn_date < prev.txn_date) firstSeen.set(r.merchant_norm, r);
  }
  for (const [merchant, r] of firstSeen) {
    if (monthOf(r.txn_date) === latestMonth) {
      flags.push({
        user_id: userId,
        transaction_id: r.id,
        type: "new_merchant",
        score: 1,
        reason: `First charge from ${merchant} (${formatCents(Math.abs(r.amount_cents))}). You haven't been billed by them before.`,
      });
    }
  }

  // ---- category_spike: latest-month total far above prior average ---------
  const catMonthTotals = new Map<string, Map<string, number>>();
  for (const r of transactions) {
    const m = monthOf(r.txn_date);
    const inner = catMonthTotals.get(r.category) ?? new Map<string, number>();
    inner.set(m, (inner.get(m) ?? 0) + Math.abs(r.amount_cents));
    catMonthTotals.set(r.category, inner);
  }
  for (const [category, months] of catMonthTotals) {
    const latest = months.get(latestMonth);
    if (latest == null) continue;
    const priors = [...months.entries()]
      .filter(([m]) => m !== latestMonth)
      .map(([, v]) => v);
    if (priors.length < 2) continue;
    const priorAvg = priors.reduce((a, b) => a + b, 0) / priors.length;
    if (priorAvg > 0 && latest > priorAvg * CATEGORY_SPIKE_FACTOR) {
      const pct = Math.round((latest / priorAvg - 1) * 100);
      flags.push({
        user_id: userId,
        transaction_id: null,
        type: "category_spike",
        score: Number((latest / priorAvg).toFixed(2)),
        reason: `Your ${category} spending is ${formatCents(latest)} this month — about ${pct}% above your usual ${formatCents(Math.round(priorAvg))}.`,
      });
    }
  }

  if (flags.length > 0) {
    const { error: insErr } = await supabase.from("anomalies").insert(flags);
    if (insErr) throw new Error(`anomalies: insert failed: ${insErr.message}`);
  }

  return flags.length;
}
