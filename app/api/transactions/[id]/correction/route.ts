import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { runBatchForUser } from "@/lib/batch";
import { getCurrentUser, getServerClient } from "@/lib/db/client";
import { TransactionKind } from "@/lib/contracts";
import { UserWriteLockBusyError, withUserWriteLock } from "@/lib/db/user-write-lock";

export const maxDuration = 60;

const Correction = z.object({
  category: z.string().trim().min(1).max(64),
  kind: TransactionKind,
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid transaction id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = Correction.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid correction" }, { status: 400 });
  }

  const supabase = await getServerClient();
  try {
    return await withUserWriteLock(supabase, user.id, async () => {
  const { data: row, error: readError } = await supabase
    .from("transactions")
    .select("id, txn_date, amount_cents, transaction_kind, transaction_kind_override")
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();
  if (readError) {
    return NextResponse.json({ error: `could not load transaction: ${readError.message}` }, { status: 500 });
  }
  if (!row) return NextResponse.json({ error: "transaction not found" }, { status: 404 });

  const amount = (row as { amount_cents: number }).amount_cents;
  const kind = parsed.data.kind;
  const validForAmount =
    amount < 0
      ? kind === "expense" || kind === "transfer"
      : kind === "refund" || kind === "income" || kind === "transfer" || kind === "unknown";
  if (!validForAmount) {
    return NextResponse.json(
      { error: "transaction kind does not match the amount sign; use an expense or transfer for outflows" },
      { status: 422 },
    );
  }

  const monthStart = `${(row as { txn_date: string }).txn_date.slice(0, 7)}-01`;
  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .insert({
      user_id: user.id,
      file_fingerprint: `correction:${randomUUID()}`,
      status: "processing",
      affected_months: [monthStart],
      row_count: 0,
    })
    .select("id")
    .single();
  if (jobError || !job) {
    return NextResponse.json({ error: `could not start correction revision: ${jobError?.message ?? "missing job id"}` }, { status: 500 });
  }

  const { error: updateError } = await supabase
    .from("transactions")
    .update({
      category_override: parsed.data.category,
      transaction_kind_override: kind,
      classification_source: "user",
    })
    .eq("user_id", user.id)
    .eq("id", id);
  if (updateError) {
    const { error: failedJobError } = await supabase
      .from("import_jobs")
      .update({ status: "failed", error_code: "CORRECTION_SAVE_FAILED" })
      .eq("user_id", user.id)
      .eq("id", job.id);
    if (failedJobError) {
      return NextResponse.json(
        { error: `correction save failed (${updateError.message}) and revision status could not be recorded (${failedJobError.message})` },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: `could not save correction: ${updateError.message}` }, { status: 500 });
  }

  try {
    await runBatchForUser(user.id, { affectedMonths: [monthStart] });
  } catch (error) {
    const failureMessage = error instanceof Error ? error.message : "unknown derivation error";
    const { error: failedJobError } = await supabase
      .from("import_jobs")
      .update({ status: "failed", error_code: "CORRECTION_DERIVATION_FAILED" })
      .eq("user_id", user.id)
      .eq("id", job.id);
    if (failedJobError) {
      return NextResponse.json(
        { error: `correction was saved but recomputation failed (${failureMessage}) and revision status could not be recorded (${failedJobError.message})` },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: `correction was saved but recomputation failed: ${failureMessage}`, retryRequired: true },
      { status: 503 },
    );
  }

  const { error: completeError } = await supabase
    .from("import_jobs")
    .update({ status: "complete", completed_at: new Date().toISOString(), error_code: null })
    .eq("user_id", user.id)
    .eq("id", job.id);
  if (completeError) {
    return NextResponse.json(
      { error: `correction was recomputed but its revision could not be marked complete: ${completeError.message}`, retryRequired: true },
      { status: 503 },
    );
  }

      return NextResponse.json({ revisionId: job.id, recomputedMonth: monthStart });
    });
  } catch (error) {
    if (error instanceof UserWriteLockBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not acquire account write lock" },
      { status: 503 },
    );
  }
}
