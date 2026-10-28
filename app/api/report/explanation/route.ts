import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser, getServerClient } from "@/lib/db/client";
import {
  explainMonthlyReport,
  StaleReportRevisionError,
} from "@/lib/report/explanation";
import {
  UserAiQuotaExceededError,
  UserAiRequestBusyError,
} from "@/lib/agent/request-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

const ExplanationRequest = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  revisionId: z.string().uuid(),
  topic: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("change") }),
    z.object({ kind: z.literal("recurring"), merchant: z.string().min(1).max(120) }),
  ]),
});

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ExplanationRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid explanation request" },
      { status: 400 },
    );
  }

  try {
    const { month, revisionId, topic } = parsed.data;
    const result = await explainMonthlyReport({
      supabase: await getServerClient(),
      userId: user.id,
      month,
      expectedRevision: revisionId,
      topic,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The explanation could not be completed.";
    if (error instanceof UserAiRequestBusyError) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    if (error instanceof UserAiQuotaExceededError) {
      return NextResponse.json(
        { error: message },
        { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } },
      );
    }
    const status = error instanceof StaleReportRevisionError
      ? 409
      : /not current|needs recovery|no longer present|completed personal report/i.test(message)
        ? 409
        : /provider|model|API key|response/i.test(message)
          ? 503
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
