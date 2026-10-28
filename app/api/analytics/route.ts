import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser, getServerClient } from "@/lib/db/client";

const AnalyticsEvent = z
  .object({
    eventKey: z.string().min(1).max(120),
    eventName: z.enum([
      "first_view",
      "sample_view",
      "sign_in",
      "import_started",
      "import_succeeded",
      "import_failed",
      "report_completed",
      "explanation_succeeded",
      "explanation_failed",
      "next_review",
    ]),
    mode: z.enum(["sample", "qa", "personal"]),
    revision: z.string().max(64).nullable().optional(),
    source: z.enum(["direct", "referral", "community", "anna"]).default("direct"),
    campaign: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).nullable().optional(),
    durationMs: z.number().int().min(0).max(600000).nullable().optional(),
    errorCode: z
      .enum([
        "network",
        "provider_timeout",
        "provider_unavailable",
        "invalid_output",
        "permission_denied",
        "unknown",
      ])
      .nullable()
      .optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = AnalyticsEvent.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid redacted analytics event" }, { status: 400 });
  }

  const supabase = await getServerClient();
  const { error } = await supabase.from("analytics_events").upsert(
    {
      user_id: user.id,
      user_hash: createHash("sha256").update(`finance-assistant:${user.id}`).digest("hex"),
      event_key: parsed.data.eventKey,
      event_name: parsed.data.eventName,
      mode: parsed.data.mode,
      revision: parsed.data.revision ?? null,
      source: parsed.data.source,
      campaign: parsed.data.campaign ?? null,
      duration_ms: parsed.data.durationMs ?? null,
      error_code: parsed.data.errorCode ?? null,
    },
    { onConflict: "user_id,event_key", ignoreDuplicates: true },
  );
  if (error) {
    console.error("redacted analytics event write failed", error.message);
    return NextResponse.json({ error: "could not record analytics event" }, { status: 500 });
  }
  return NextResponse.json({ recorded: true });
}
