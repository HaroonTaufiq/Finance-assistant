import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser, getServerClient } from "@/lib/db/client";
import { getMonthlyReport } from "@/lib/report/monthly";

export const runtime = "nodejs";

function isMonth(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= 1900 && year <= 9998;
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const requestedMonth = request.nextUrl.searchParams.get("month");
  if (requestedMonth && !isMonth(requestedMonth)) {
    return NextResponse.json({ error: "month must use YYYY-MM format" }, { status: 400 });
  }

  try {
    const report = await getMonthlyReport(await getServerClient(), user.id, requestedMonth);
    return NextResponse.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown report error";
    console.error("monthly report failed", error);
    const status = /not current|needs recovery|mixed currencies|requires review|confirm one dataset currency/i.test(message)
      ? 409
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
