import type { SupabaseClient } from "@supabase/supabase-js";
import { getSpending, getSubscriptions } from "@/lib/db/queries";
import { fetchAllPages } from "@/lib/db/pagination";
import { monthRange } from "@/lib/months";

function previousMonth(month: string): string {
  const date = new Date(`${month}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
}

function monthEnd(month: string): string {
  const { end } = monthRange(`${month}-01`);
  const date = new Date(`${end}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

type DatasetSnapshot = {
  generation: number;
  writeInProgress: boolean;
  updatedAt: string | null;
};

async function readDatasetSnapshot(
  supabase: SupabaseClient,
  userId: string,
): Promise<DatasetSnapshot> {
  const { data, error } = await supabase.rpc("read_user_dataset_snapshot", {
    p_user_id: userId,
  });
  if (error) {
    throw new Error(`report snapshot boundary check failed: ${error.message}`);
  }
  const snapshot = (Array.isArray(data) ? data[0] : data) as
    | { generation: number | string; write_in_progress: boolean; updated_at: string | null }
    | null;
  if (!snapshot) throw new Error("report snapshot boundary check returned no generation");
  return {
    generation: Number(snapshot.generation),
    writeInProgress: snapshot.write_in_progress,
    updatedAt: snapshot.updated_at,
  };
}

async function assertNoPendingRevision(
  supabase: SupabaseClient,
  userId: string,
  message: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("import_jobs")
    .select("id")
    .eq("user_id", userId)
    .neq("status", "complete")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`report readiness check failed: ${error.message}`);
  if (data) throw new Error(message);
}

export async function getMonthlyReport(
  supabase: SupabaseClient,
  userId: string,
  requestedMonth?: string | null,
) {
  const initialSnapshot = await readDatasetSnapshot(supabase, userId);
  if (initialSnapshot.writeInProgress) {
    throw new Error("Report is not current because a finance update is running; retry shortly");
  }
  await assertNoPendingRevision(
    supabase,
    userId,
    "Report is not current because an import needs recovery; retry that import first",
  );

  const { data: settings, error: settingsError } = await supabase
    .from("financial_settings")
    .select("currency")
    .eq("user_id", userId)
    .maybeSingle();
  if (settingsError) throw new Error(`could not load dataset settings: ${settingsError.message}`);
  const currency = (settings as { currency: string | null } | null)?.currency;

  const { data: latest, error: latestError } = await supabase
    .from("transactions")
    .select("txn_date")
    .eq("user_id", userId)
    .order("txn_date", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw new Error(`could not find the latest transaction month: ${latestError.message}`);

  const currentMonth = new Date().toISOString().slice(0, 7);
  const latestMonth = (latest as { txn_date: string } | null)?.txn_date.slice(0, 7) ?? null;
  const month = requestedMonth ?? (latestMonth === currentMonth ? currentMonth : latestMonth);
  if (!month) {
    await assertNoPendingRevision(
      supabase,
      userId,
      "Report is not current because an import needs recovery; retry that import first",
    );
    const finalSnapshot = await readDatasetSnapshot(supabase, userId);
    if (finalSnapshot.writeInProgress || finalSnapshot.generation !== initialSnapshot.generation) {
      throw new Error("Report is not current because its dataset changed while loading");
    }
    return { hasData: false as const, currency: currency ?? null };
  }
  if (!currency) throw new Error("Confirm one dataset currency before creating a report");

  const { start, end } = monthRange(`${month}-01`);
  const endDate = monthEnd(month);
  const report = await getSpending(supabase, userId, { startDate: start, endDate });
  const priorMonth = previousMonth(month);
  const priorStart = `${priorMonth}-01`;
  const priorEnd = monthEnd(priorMonth);
  const prior = await getSpending(supabase, userId, {
    startDate: priorStart,
    endDate: priorEnd,
  });

  const categories = await fetchAllPages(
    supabase
      .from("rollups")
      .select("category, total_spend_cents, total_refund_cents, net_spend_cents")
      .eq("user_id", userId)
      .eq("period_type", "month")
      .eq("period_start", start)
      .neq("category", "__all__")
      .order("category", { ascending: true }),
    "report category read failed",
  );
  const transactions = await fetchAllPages(
    supabase
      .from("transactions")
      .select(
        "id, txn_date, amount_cents, currency, merchant_raw, merchant_norm, category, transaction_kind, category_override, transaction_kind_override",
      )
      .eq("user_id", userId)
      .gte("txn_date", start)
      .lt("txn_date", end)
      .order("txn_date", { ascending: true })
      .order("id", { ascending: true }),
    "report transaction evidence read failed",
  );
  const observedDates = (transactions as { txn_date: string }[]).map((row) => row.txn_date).sort();
  const observedFrom = observedDates[0] ?? null;
  const observedTo = observedDates[observedDates.length - 1] ?? null;

  const coverageJobs = await fetchAllPages(
    supabase
      .from("import_jobs")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "complete")
      .eq("coverage_confirmed", true)
      .lte("coverage_start", start)
      .gte("coverage_end", endDate)
      .order("created_at", { ascending: false }),
    "report coverage read failed",
  );
  const completeCoverage = coverageJobs.length > 0;
  const priorCoverageJobs = await fetchAllPages(
    supabase
      .from("import_jobs")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "complete")
      .eq("coverage_confirmed", true)
      .lte("coverage_start", priorStart)
      .gte("coverage_end", priorEnd)
      .order("created_at", { ascending: false }),
    "comparison coverage read failed",
  );
  const currentIsPartial = month === currentMonth && !completeCoverage;
  const priorIsCovered = priorCoverageJobs.length > 0;

  const subscriptions = await getSubscriptions(supabase, userId);
  const latestJobResult = await supabase
    .from("import_jobs")
    .select("id, completed_at")
    .eq("user_id", userId)
    .eq("status", "complete")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestJobResult.error) throw new Error(`could not load report revision: ${latestJobResult.error.message}`);
  const latestJob = latestJobResult.data as { id: string; completed_at: string } | null;
  await assertNoPendingRevision(
    supabase,
    userId,
    "Report is not current because an import needs recovery; retry that import first",
  );
  const finalSnapshot = await readDatasetSnapshot(supabase, userId);
  if (finalSnapshot.writeInProgress || finalSnapshot.generation !== initialSnapshot.generation) {
    throw new Error("Report is not current because its dataset changed while loading");
  }

  const deltaCents = report.net_spend_cents - prior.net_spend_cents;
  const comparison =
    currentIsPartial || !completeCoverage || !priorIsCovered
      ? null
      : {
          priorMonth,
          priorNetSpendCents: prior.net_spend_cents,
          deltaCents,
          deltaPercent:
            prior.net_spend_cents > 0
              ? Number(((deltaCents / prior.net_spend_cents) * 100).toFixed(1))
              : null,
        };

  return {
    hasData: true as const,
    month,
    monthLabel:
      month === currentMonth
        ? `This month · ${month}`
        : requestedMonth
          ? month
          : `Latest imported month · ${month}`,
    currency,
    coverage: {
      status: completeCoverage ? "user_confirmed_complete" as const : "observed_transactions_only" as const,
      observedFrom,
      observedTo,
    },
    totals: {
      grossOutflowsCents: report.gross_outflows_cents,
      refundsCents: report.refunds_cents,
      netSpendCents: report.net_spend_cents,
      incomeCents: report.total_income_cents,
      unknownInflowsCents: report.unknown_inflows_cents,
    },
    categories,
    comparison: comparison ?? {
      unavailableReason: currentIsPartial
        ? "current_month_is_partial"
        : !completeCoverage || !priorIsCovered
          ? "coverage_not_confirmed_for_both_months"
          : "unavailable",
    },
    subscriptions: subscriptions.subscriptions,
    transactions,
    revision: {
      id: `${initialSnapshot.generation}:${latestJob?.id ?? "none"}`,
      generation: initialSnapshot.generation,
      jobId: latestJob?.id ?? null,
      completed_at: latestJob?.completed_at ?? initialSnapshot.updatedAt,
    },
    updatedAt: initialSnapshot.updatedAt ?? latestJob?.completed_at ?? null,
  };
}

export type MonthlyReportData = Awaited<ReturnType<typeof getMonthlyReport>>;
