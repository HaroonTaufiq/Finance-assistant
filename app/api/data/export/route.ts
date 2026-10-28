import { NextResponse } from "next/server";
import { getCurrentUser, getServerClient } from "@/lib/db/client";
import { fetchAllPages } from "@/lib/db/pagination";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const supabase = await getServerClient();
  const rows = (table: string) => {
    let query = supabase
        .from(table)
        .select("*")
        .eq("user_id", user.id);
    if (table === "rollups") {
      query = query.order("period_start", { ascending: true }).order("category", { ascending: true });
    } else if (table === "subscriptions") {
      query = query.order("merchant_norm", { ascending: true }).order("id", { ascending: true });
    } else {
      query = query.order("created_at", { ascending: true }).order("id", { ascending: true });
    }
    return fetchAllPages(
      query,
      `data export ${table} read failed`,
    );
  };

  try {
    const [
      profileResult,
      settings,
      importJobs,
      transactions,
      rollups,
      subscriptions,
      anomalies,
      budgets,
      memories,
      conversations,
      messages,
      receipts,
      ingestErrors,
      analyticsEvents,
    ] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
      supabase.from("financial_settings").select("*").eq("user_id", user.id).maybeSingle(),
      rows("import_jobs"),
      rows("transactions"),
      rows("rollups"),
      rows("subscriptions"),
      rows("anomalies"),
      rows("budgets"),
      rows("user_memory"),
      rows("conversations"),
      rows("messages"),
      rows("receipts"),
      rows("ingest_errors"),
      rows("analytics_events"),
    ]);
    if (profileResult.error) throw new Error(`data export profiles read failed: ${profileResult.error.message}`);
    if (settings.error) throw new Error(`data export settings read failed: ${settings.error.message}`);
    const snapshot = {
      schema: "finance-assistant-user-export",
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      owner: { id: user.id },
      data: {
        profile: profileResult.data ?? null,
        financialSettings: settings.data ?? null,
        importJobs,
        transactions,
        monthlyRollups: rollups,
        recurringCandidates: subscriptions,
        anomalies,
        budgets,
        memories,
        conversations,
        messages,
        receipts,
        ingestErrors,
        redactedAnalyticsEvents: analyticsEvents,
      },
    };

    return new NextResponse(JSON.stringify(snapshot, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": 'attachment; filename="finance-assistant-export.json"',
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown export error";
    console.error("user data export failed", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
