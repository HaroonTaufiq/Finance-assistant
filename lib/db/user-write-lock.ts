import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const LEASE_SECONDS = 90;

export class UserWriteLockBusyError extends Error {
  constructor() {
    super("A finance update is already running for this account. Retry when it finishes.");
    this.name = "UserWriteLockBusyError";
  }
}

export async function withUserWriteLock<T>(
  supabase: SupabaseClient,
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  const { data: acquired, error: acquireError } = await supabase.rpc(
    "acquire_user_write_lock",
    { p_user_id: userId, p_lock_token: token, p_lease_seconds: LEASE_SECONDS },
  );
  if (acquireError) {
    throw new Error(`Could not acquire the account write lock: ${acquireError.message}`);
  }
  if (acquired !== true) throw new UserWriteLockBusyError();

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const { data: released, error: releaseError } = await supabase.rpc(
    "release_user_write_lock",
    { p_user_id: userId, p_lock_token: token },
  );
  if (releaseError || released !== true) {
    throw new Error(
      `Could not release the account write lock${releaseError ? `: ${releaseError.message}` : ""}`,
      { cause: outcome.ok ? undefined : outcome.error },
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
