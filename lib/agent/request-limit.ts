import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const WINDOW_SECONDS = 3600;
const LEASE_SECONDS = 45;
const DEFAULT_REQUESTS_PER_HOUR = 12;

export class UserAiRequestBusyError extends Error {
  constructor() {
    super("Another AI request is already running for this account. Retry when it finishes.");
    this.name = "UserAiRequestBusyError";
  }
}

export class UserAiQuotaExceededError extends Error {
  readonly retryAfterSeconds = WINDOW_SECONDS;
  constructor() {
    super("The account AI request limit has been reached for this hour. Try again later.");
    this.name = "UserAiQuotaExceededError";
  }
}

function requestsPerHour(): number {
  const configured = process.env.FINANCE_AI_REQUESTS_PER_HOUR;
  if (!configured) return DEFAULT_REQUESTS_PER_HOUR;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < 1 || value > 60) {
    throw new Error("FINANCE_AI_REQUESTS_PER_HOUR must be an integer from 1 to 60");
  }
  return value;
}

export async function reserveUserAiRequest(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const token = randomUUID();
  const { data, error } = await supabase.rpc("reserve_user_ai_request", {
    p_user_id: userId,
    p_token: token,
    p_max_requests: requestsPerHour(),
    p_window_seconds: WINDOW_SECONDS,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error(`Could not reserve an AI request: ${error.message}`);
  if (data === "busy") throw new UserAiRequestBusyError();
  if (data === "limited") throw new UserAiQuotaExceededError();
  if (data !== "reserved") throw new Error("AI request limit returned an invalid reservation state");
  return token;
}

export async function releaseUserAiRequest(
  supabase: SupabaseClient,
  userId: string,
  token: string,
): Promise<void> {
  const { data, error } = await supabase.rpc("release_user_ai_request", {
    p_user_id: userId,
    p_token: token,
  });
  if (error) throw new Error(`Could not release the AI request slot: ${error.message}`);
  if (data !== true) throw new Error("Could not release the AI request slot owned by this request");
}

export async function withUserAiRequest<T>(
  supabase: SupabaseClient,
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const token = await reserveUserAiRequest(supabase, userId);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  try {
    await releaseUserAiRequest(supabase, userId, token);
  } catch (releaseError) {
    throw new Error(
      releaseError instanceof Error ? releaseError.message : "Could not release the AI request slot",
      { cause: outcome.ok ? undefined : outcome.error },
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
