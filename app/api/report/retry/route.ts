import { NextResponse } from "next/server";
import { runBatchForUser } from "@/lib/batch";
import { getCurrentUser, getServerClient } from "@/lib/db/client";
import { fetchAllPages } from "@/lib/db/pagination";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const supabase = await getServerClient();
  const jobs = await fetchAllPages(
    supabase
      .from("import_jobs")
      .select("id, affected_months")
      .eq("user_id", user.id)
      .neq("status", "complete")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    "report retry job lookup failed",
  );
  if (jobs.length === 0) return NextResponse.json({ retried: false, reason: "no pending work" });

  const months = [
    ...new Set(
      (jobs as { affected_months: string[] | null }[]).flatMap((job) => job.affected_months ?? []),
    ),
  ];
  if (months.length === 0) {
    return NextResponse.json({ error: "pending work has no affected months; support is required" }, { status: 409 });
  }

  try {
    await runBatchForUser(user.id, { affectedMonths: months });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown derivation error";
    return NextResponse.json({ error: `recomputation failed: ${message}` }, { status: 503 });
  }

  const { error } = await supabase
    .from("import_jobs")
    .update({ status: "complete", error_code: null, completed_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .neq("status", "complete");
  if (error) {
    return NextResponse.json({ error: `recomputation finished but completion was not recorded: ${error.message}` }, { status: 503 });
  }
  return NextResponse.json({ retried: true, months });
}
