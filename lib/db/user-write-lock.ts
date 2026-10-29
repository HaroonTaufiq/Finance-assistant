import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const LEASE_SECONDS = 90;
const RENEW_INTERVAL_MS = 20_000;

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

  let renewalInFlight = false;
  const renewalState: { error: Error | null } = { error: null };
  const renewalTimer = setInterval(() => {
    if (renewalInFlight || renewalState.error) return;
    renewalInFlight = true;
    void (async () => {
      try {
        const { data, error } = await supabase.rpc("renew_user_write_lock", {
          p_user_id: userId,
          p_lock_token: token,
          p_lease_seconds: LEASE_SECONDS,
        });
        if (error || data !== true) {
          renewalState.error = new Error(
            `Could not renew the account write lock${error ? `: ${error.message}` : ""}`,
          );
        }
      } catch (error) {
        renewalState.error = new Error(
          `Could not renew the account write lock: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      } finally {
        renewalInFlight = false;
      }
    })();
  }, RENEW_INTERVAL_MS);
  renewalTimer.unref?.();

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    clearInterval(renewalTimer);
  }

  if (renewalInFlight) {
    while (renewalInFlight) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
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
  if (renewalState.error) {
    throw new Error(renewalState.error.message, { cause: outcome.ok ? undefined : outcome.error });
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
