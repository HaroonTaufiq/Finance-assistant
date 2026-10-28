import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser, getServerClient } from "@/lib/db/client";
import { UserWriteLockBusyError, withUserWriteLock } from "@/lib/db/user-write-lock";

export const maxDuration = 60;

const Review = z.object({ status: z.enum(["confirmed", "dismissed"]) });

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ merchant: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { merchant } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = Review.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "status must be confirmed or dismissed" }, { status: 400 });
  }

  const supabase = await getServerClient();
  try {
    return await withUserWriteLock(supabase, user.id, async () => {
  const { data, error } = await supabase
    .from("subscriptions")
    .update({ status: parsed.data.status })
    .eq("user_id", user.id)
    .eq("merchant_norm", merchant)
    .eq("lifecycle_status", "active")
    .select("merchant_norm, status")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: `could not save recurring-candidate review: ${error.message}` }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "recurring candidate not found" }, { status: 404 });
      return NextResponse.json({ merchant: data.merchant_norm, status: data.status });
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
