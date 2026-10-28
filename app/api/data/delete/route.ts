import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser, getServerClient } from "@/lib/db/client";
import { fetchAllPages } from "@/lib/db/pagination";
import { UserWriteLockBusyError, withUserWriteLock } from "@/lib/db/user-write-lock";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("confirmation" in body) ||
    body.confirmation !== "DELETE MY FINANCE DATA"
  ) {
    return NextResponse.json({ error: "explicit deletion confirmation is required" }, { status: 400 });
  }

  const supabase = await getServerClient();
  try {
    return await withUserWriteLock(supabase, user.id, async () => {
  const receipts = await fetchAllPages(
    supabase
      .from("receipts")
      .select("storage_path")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    "data deletion receipt lookup failed",
  );
  const paths = (receipts as { storage_path: string }[]).map((receipt) => receipt.storage_path);
  for (let offset = 0; offset < paths.length; offset += 100) {
    const { error } = await supabase.storage.from("receipts").remove(paths.slice(offset, offset + 100));
    if (error) {
      return NextResponse.json(
        { error: `could not delete receipt files; no database records were removed: ${error.message}` },
        { status: 500 },
      );
    }
  }

  const { error } = await supabase.rpc("delete_my_financial_data");
  if (error) {
    return NextResponse.json({ error: `could not delete finance data: ${error.message}` }, { status: 500 });
  }

      return NextResponse.json({
    deleted: true,
    signInAccountKept: true,
    deletedReceiptFiles: paths.length,
  });
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
