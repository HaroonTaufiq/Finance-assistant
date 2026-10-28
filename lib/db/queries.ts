import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import * as C from "@/lib/contracts";
import { monthsInRange } from "@/lib/months";

/**
 * Parameterized, bounded query functions backing the tools (PRD-B1).
 * THERE IS NO TEXT-TO-SQL — the model never emits SQL, it calls these. Every
 * query is range- and row-bounded, and "how much / trend" reads come from the
 * precomputed `rollups` table, never raw transaction rows (SPEC §5.1).
 */

type SpendingIn = z.infer<typeof C.GetSpendingInput>;
type SpendingOut = z.infer<typeof C.GetSpendingOutput>;
type TxnIn = z.infer<typeof C.GetTransactionsInput>;
type TxnOut = z.infer<typeof C.GetTransactionsOutput>;
type TrendIn = z.infer<typeof C.GetTrendInput>;
type TrendOut = z.infer<typeof C.GetTrendOutput>;
type SubsOut = z.infer<typeof C.GetSubscriptionsOutput>;
type AnomIn = z.infer<typeof C.GetAnomaliesInput>;
type AnomOut = z.infer<typeof C.GetAnomaliesOutput>;
type BudgetStatusOut = z.infer<typeof C.BudgetStatus>;
type GetBudgetStatusIn = z.infer<typeof C.GetBudgetStatusInput>;
type GetBudgetStatusOut = z.infer<typeof C.GetBudgetStatusOutput>;
type SetBudgetIn = z.infer<typeof C.SetBudgetInput>;
type SaveMemoryIn = z.infer<typeof C.SaveMemoryInput>;
type SaveMemoryOut = z.infer<typeof C.SaveMemoryOutput>;

type Exclusion = { category: string; from: string };

const pad2 = (n: number) => String(n).padStart(2, "0");

// ---- getSpending: reads precomputed rollups (no raw rows) ------------------
export async function getSpending(
  supabase: SupabaseClient,
  userId: string,
  input: SpendingIn,
): Promise<SpendingOut> {
  const months = monthsInRange(input.startDate, input.endDate);
  const perCategory = input.groupBy === "category";
  const baseCat = input.category ?? "__all__";

  let query = supabase
    .from("rollups")
    .select("period_start, category, total_spend_cents")
    .eq("user_id", userId)
    .eq("period_type", "month")
    .in("period_start", months);
  query = perCategory ? query.neq("category", "__all__") : query.eq("category", baseCat);

  const { data, error } = await query;
  if (error) throw new Error(`getSpending failed: ${error.message}`);

  const rows = (data as { period_start: string; category: string; total_spend_cents: number }[] | null) ?? [];
  let total = 0;
  const grouped = new Map<string, number>();
  for (const r of rows) {
    total += r.total_spend_cents;
    if (input.groupBy) {
      const key = input.groupBy === "month" ? r.period_start : r.category;
      grouped.set(key, (grouped.get(key) ?? 0) + r.total_spend_cents);
    }
  }

  const breakdown = input.groupBy
    ? [...grouped.entries()]
        .map(([key, amount_cents]) => ({ key, amount_cents }))
        .sort((a, b) => b.amount_cents - a.amount_cents)
    : [];

  return {
    total_cents: total,
    currency: "USD",
    period: { start: input.startDate, end: input.endDate },
    groupBy: input.groupBy ?? null,
    breakdown,
  };
}

// ---- getTransactions: bounded indexed select (the raw-row exception) -------
export async function getTransactions(
  supabase: SupabaseClient,
  userId: string,
  input: TxnIn,
): Promise<TxnOut> {
  const f = input.filters;
  let query = supabase
    .from("transactions")
    .select("txn_date, merchant_norm, category, amount_cents, currency")
    .eq("user_id", userId);

  if (f.category) query = query.eq("category", f.category);
  if (f.merchant) query = query.ilike("merchant_norm", `%${f.merchant.toUpperCase()}%`);
  if (f.startDate) query = query.gte("txn_date", f.startDate);
  if (f.endDate) query = query.lte("txn_date", f.endDate);
  if (f.min != null) query = query.gte("amount_cents", Math.round(f.min * 100));
  if (f.max != null) query = query.lte("amount_cents", Math.round(f.max * 100));

  const sort: Record<TxnIn["sort"], { col: string; asc: boolean }> = {
    date_desc: { col: "txn_date", asc: false },
    date_asc: { col: "txn_date", asc: true },
    amount_desc: { col: "amount_cents", asc: false },
    amount_asc: { col: "amount_cents", asc: true },
  };
  const s = sort[input.sort];

  const { data, error } = await query
    .order(s.col, { ascending: s.asc })
    .limit(input.limit + 1); // +1 to detect hasMore
  if (error) throw new Error(`getTransactions failed: ${error.message}`);

  const rows = (data as { txn_date: string; merchant_norm: string | null; category: string; amount_cents: number; currency: string }[] | null) ?? [];
  const hasMore = rows.length > input.limit;
  return {
    rows: rows.slice(0, input.limit).map((r) => ({
      date: r.txn_date,
      merchant: r.merchant_norm,
      category: r.category,
      amount_cents: r.amount_cents,
      currency: r.currency,
    })),
    hasMore,
  };
}

// ---- getTrend: reads the monthly rollup series ----------------------------
export async function getTrend(
  supabase: SupabaseClient,
  userId: string,
  input: TrendIn,
): Promise<TrendOut> {
  const cat = input.category ?? "__all__";
  const { data, error } = await supabase
    .from("rollups")
    .select("period_start, total_spend_cents")
    .eq("user_id", userId)
    .eq("period_type", "month")
    .eq("category", cat)
    .order("period_start", { ascending: true });
  if (error) throw new Error(`getTrend failed: ${error.message}`);

  const all = (data as { period_start: string; total_spend_cents: number }[] | null) ?? [];
  const series = all.slice(-input.periods);
  const current = series.length > 0 ? series[series.length - 1]!.total_spend_cents : 0;
  const prior = series.slice(0, -1);
  const average =
    prior.length > 0
      ? Math.round(prior.reduce((a, b) => a + b.total_spend_cents, 0) / prior.length)
      : 0;
  const delta_pct =
    average > 0 ? Number((((current - average) / average) * 100).toFixed(1)) : null;

  return {
    category: input.category ?? null,
    series,
    current_cents: current,
    average_cents: average,
    delta_pct,
  };
}

// ---- getSubscriptions: reads the detected recurring charges ----------------
export async function getSubscriptions(
  supabase: SupabaseClient,
  userId: string,
): Promise<SubsOut> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("merchant_norm, cadence_days, avg_amount_cents, next_expected, confidence")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("confidence", { ascending: false });
  if (error) throw new Error(`getSubscriptions failed: ${error.message}`);

  return {
    subscriptions: ((data as SubsOut["subscriptions"] | null) ?? []).map((s) => ({
      merchant_norm: s.merchant_norm,
      cadence_days: s.cadence_days,
      avg_amount_cents: s.avg_amount_cents,
      next_expected: s.next_expected,
      confidence: s.confidence,
    })),
  };
}

// ---- getAnomalies: reads precomputed flags --------------------------------
export async function getAnomalies(
  supabase: SupabaseClient,
  userId: string,
  input: AnomIn,
): Promise<AnomOut> {
  let query = supabase
    .from("anomalies")
    .select("type, score, reason")
    .eq("user_id", userId);
  if (input.status === "new") query = query.eq("status", "new");

  const { data, error } = await query
    .order("score", { ascending: false })
    .limit(50);
  if (error) throw new Error(`getAnomalies failed: ${error.message}`);

  return {
    anomalies: ((data as { type: AnomOut["anomalies"][number]["type"]; score: number; reason: string }[] | null) ?? []).map((a) => ({
      type: a.type,
      score: a.score,
      reason: a.reason,
      txn: null,
    })),
  };
}

// ---- budgets (PRD-B3): read-time evaluation with exclusion rules ----------

/** Latest month with rollup data, so budgets track the most recent data month
 *  even when the sample data is historical. Falls back to the real month. */
async function latestDataMonth(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const { data } = await supabase
    .from("rollups")
    .select("period_start")
    .eq("user_id", userId)
    .eq("period_type", "month")
    .order("period_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as { period_start: string } | null;
  if (row?.period_start) return row.period_start;
  const now = new Date();
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-01`;
}

async function monthSpend(
  supabase: SupabaseClient,
  userId: string,
  month: string,
  category: string,
): Promise<number> {
  const { data } = await supabase
    .from("rollups")
    .select("total_spend_cents")
    .eq("user_id", userId)
    .eq("period_type", "month")
    .eq("period_start", month)
    .eq("category", category)
    .maybeSingle();
  return (data as { total_spend_cents: number } | null)?.total_spend_cents ?? 0;
}

async function statusFor(
  supabase: SupabaseClient,
  userId: string,
  budget: { category: string; limit_cents: number },
  exclusions: Exclusion[],
  month: string,
): Promise<BudgetStatusOut> {
  const base = await monthSpend(supabase, userId, month, budget.category);
  const applicable = exclusions.filter((e) => e.from === budget.category);
  let excluded = 0;
  for (const e of applicable) {
    excluded += await monthSpend(supabase, userId, month, e.category);
  }
  const spent = Math.max(0, base - excluded);
  const pct = budget.limit_cents > 0
    ? Number(((spent / budget.limit_cents) * 100).toFixed(1))
    : 0;
  return {
    category: budget.category,
    limit_cents: budget.limit_cents,
    spent_cents: spent,
    pct_used: pct,
    remaining_cents: budget.limit_cents - spent,
    exclusionsApplied: applicable.map((e) => e.category),
  };
}

export async function getBudgetStatus(
  supabase: SupabaseClient,
  userId: string,
  input: GetBudgetStatusIn,
  exclusions: Exclusion[],
): Promise<GetBudgetStatusOut> {
  const month = await latestDataMonth(supabase, userId);
  let query = supabase
    .from("budgets")
    .select("category, limit_cents")
    .eq("user_id", userId)
    .eq("period_type", "month");
  if (input.category) query = query.eq("category", input.category);

  const { data, error } = await query;
  if (error) throw new Error(`getBudgetStatus failed: ${error.message}`);

  const budgets: BudgetStatusOut[] = [];
  for (const b of (data as { category: string; limit_cents: number }[] | null) ?? []) {
    budgets.push(await statusFor(supabase, userId, b, exclusions, month));
  }
  return { budgets };
}

export async function setBudget(
  supabase: SupabaseClient,
  userId: string,
  input: SetBudgetIn,
  exclusions: Exclusion[],
): Promise<BudgetStatusOut> {
  const limit_cents = Math.round(input.limitAmount * 100);
  const { error } = await supabase
    .from("budgets")
    .upsert(
      { user_id: userId, category: input.category, period_type: input.period, limit_cents },
      { onConflict: "user_id,category,period_type" },
    );
  if (error) throw new Error(`setBudget failed: ${error.message}`);

  const month = await latestDataMonth(supabase, userId);
  return statusFor(supabase, userId, { category: input.category, limit_cents }, exclusions, month);
}

// ---- user memory (PRD-B3) -------------------------------------------------
export async function saveMemory(
  supabase: SupabaseClient,
  userId: string,
  input: SaveMemoryIn,
  confirmation: string,
): Promise<SaveMemoryOut> {
  const { rule, kind } = input;
  const text = rule.type === "free_text" ? rule.text : null;
  const { type, ...rest } = rule;
  const params = rule.type === "free_text" ? {} : rest;

  const { error } = await supabase
    .from("user_memory")
    .insert({ user_id: userId, kind, type, params, text });
  if (error) throw new Error(`saveMemory failed: ${error.message}`);

  return { ok: true, summary: confirmation };
}

/** Compact recent-rollup context for the reasoning-tier synthesis tools. */
export async function getRollupContext(
  supabase: SupabaseClient,
  userId: string,
  months = 6,
): Promise<{ period_start: string; category: string; total_spend_cents: number; total_income_cents: number }[]> {
  const { data, error } = await supabase
    .from("rollups")
    .select("period_start, category, total_spend_cents, total_income_cents")
    .eq("user_id", userId)
    .eq("period_type", "month")
    .order("period_start", { ascending: false })
    .limit(months * 14); // ~13 categories + __all__ per month
  if (error) throw new Error(`getRollupContext failed: ${error.message}`);
  return (data as { period_start: string; category: string; total_spend_cents: number; total_income_cents: number }[] | null) ?? [];
}
