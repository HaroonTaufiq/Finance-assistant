import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser, getServerClient } from "@/lib/db/client";
import { getSpending, getSubscriptions } from "@/lib/db/queries";
import { fetchAllPages } from "@/lib/db/pagination";
import { monthRange } from "@/lib/months";

export const runtime = "nodejs";

function isMonth(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= 1900 && year <= 9998;
}

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

export async function GET(request: NextRequest) {
  try {
    return await getReport(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown report error";
    console.error("monthly report failed", error);
    const status = /not current|needs recovery|mixed currencies|requires review/i.test(message)
      ? 409
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

async function getReport(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const requestedMonth = request.nextUrl.searchParams.get("month");
  if (requestedMonth && !isMonth(requestedMonth)) {
    return NextResponse.json({ error: "month must use YYYY-MM format" }, { status: 400 });
  }

  const supabase = await getServerClient();
  const { data: settings, error: settingsError } = await supabase
    .from("financial_settings")
    .select("currency")
    .eq("user_id", user.id)
    .maybeSingle();
  if (settingsError) {
    return NextResponse.json({ error: `could not load dataset settings: ${settingsError.message}` }, { status: 500 });
  }
  const currency = (settings as { currency: string | null } | null)?.currency;

  const { data: latest, error: latestError } = await supabase
    .from("transactions")
    .select("txn_date")
    .eq("user_id", user.id)
    .order("txn_date", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) {
    return NextResponse.json({ error: `could not find the latest transaction month: ${latestError.message}` }, { status: 500 });
  }

  const currentMonth = new Date().toISOString().slice(0, 7);
  const latestMonth = (latest as { txn_date: string } | null)?.txn_date.slice(0, 7) ?? null;
  const month = requestedMonth ?? (latestMonth === currentMonth ? currentMonth : latestMonth);
  if (!month) {
    return NextResponse.json({ hasData: false, currency: currency ?? null });
  }
  if (!currency) {
    return NextResponse.json({ error: "Confirm one dataset currency before creating a report" }, { status: 409 });
  }

  const { start, end } = monthRange(`${month}-01`);
  const endDate = monthEnd(month);
  const report = await getSpending(supabase, user.id, { startDate: start, endDate });
  const priorMonth = previousMonth(month);
  const priorStart = `${priorMonth}-01`;
  const priorEnd = monthEnd(priorMonth);
  const prior = await getSpending(supabase, user.id, {
    startDate: priorStart,
    endDate: priorEnd,
  });

  const categories = await fetchAllPages(
    supabase
      .from("rollups")
      .select("category, total_spend_cents, total_refund_cents, net_spend_cents")
      .eq("user_id", user.id)
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
      .eq("user_id", user.id)
      .gte("txn_date", start)
      .lt("txn_date", end)
      .order("txn_date", { ascending: true })
      .order("id", { ascending: true }),
    "report transaction evidence read failed",
  );
  const observedDates = (transactions as { txn_date: string }[]).map((row) => row.txn_date);
  const observedFrom = observedDates.sort()[0] ?? null;
  const observedTo = observedDates[observedDates.length - 1] ?? null;

  const coverageJobs = await fetchAllPages(
    supabase
      .from("import_jobs")
      .select("id")
      .eq("user_id", user.id)
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
      .eq("user_id", user.id)
      .eq("status", "complete")
      .eq("coverage_confirmed", true)
      .lte("coverage_start", priorStart)
      .gte("coverage_end", priorEnd)
      .order("created_at", { ascending: false }),
    "comparison coverage read failed",
  );
  const currentIsPartial = month === currentMonth && !completeCoverage;
  const priorIsCovered = priorCoverageJobs.length > 0;

  const latestJobResult = await supabase
    .from("import_jobs")
    .select("id, completed_at")
    .eq("user_id", user.id)
    .eq("status", "complete")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestJobResult.error) {
    return NextResponse.json({ error: `could not load report revision: ${latestJobResult.error.message}` }, { status: 500 });
  }

  const subscriptions = await getSubscriptions(supabase, user.id);
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

  return NextResponse.json({
    hasData: true,
    month,
    monthLabel:
      month === currentMonth
        ? `This month · ${month}`
        : requestedMonth
          ? month
          : `Latest imported month · ${month}`,
    currency,
    coverage: {
      status: completeCoverage ? "user_confirmed_complete" : "observed_transactions_only",
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
    revision: latestJobResult.data ?? null,
    updatedAt: latestJobResult.data?.completed_at ?? null,
  });
}
