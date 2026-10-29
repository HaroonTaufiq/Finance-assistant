export type AnalyticsEventName =
  | "first_view"
  | "sample_view"
  | "sign_in"
  | "import_started"
  | "import_succeeded"
  | "import_failed"
  | "report_completed"
  | "explanation_succeeded"
  | "explanation_failed"
  | "next_review";

export async function recordAnalyticsEvent(event: {
  eventKey: string;
  eventName: AnalyticsEventName;
  mode: "sample" | "qa" | "personal";
  revision?: string | null;
  durationMs?: number | null;
  source?: "direct" | "referral" | "community" | "anna";
  campaign?: string | null;
  errorCode?: "network" | "provider_timeout" | "provider_unavailable" | "invalid_output" | "permission_denied" | "unknown" | null;
}) {
  try {
    const query = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
    const source = query?.get("source");
    const campaign = query?.get("campaign");
    const response = await fetch("/api/analytics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...event,
        source: event.source ?? (source === "referral" || source === "community" || source === "anna" ? source : "direct"),
        campaign: event.campaign ?? campaign,
      }),
      keepalive: true,
    });
    if (!response.ok) console.warn("redacted analytics event was not recorded");
  } catch {
    console.warn("redacted analytics event was not recorded");
  }
}
