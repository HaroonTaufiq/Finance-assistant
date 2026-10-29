import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { UserWriteLockBusyError, withUserWriteLock } from "./user-write-lock";

function lockClient(options?: {
  acquire?: unknown;
  release?: unknown;
  acquireError?: { message: string } | null;
  releaseError?: { message: string } | null;
}) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "acquire_user_write_lock") {
      return { data: options?.acquire ?? true, error: options?.acquireError ?? null };
    }
    return { data: options?.release ?? true, error: options?.releaseError ?? null };
  });
  return { client: { rpc } as never, rpc };
}

describe("withUserWriteLock", () => {
  it("does not enter a concurrent write when the durable lock is occupied", async () => {
    const { client, rpc } = lockClient({ acquire: false });
    const operation = vi.fn();

    await expect(withUserWriteLock(client, "user-1", operation))
      .rejects.toBeInstanceOf(UserWriteLockBusyError);

    expect(operation).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("releases the durable lock after success and failure", async () => {
    const { client, rpc } = lockClient();
    await expect(withUserWriteLock(client, "user-1", async () => "done")).resolves.toBe("done");
    await expect(withUserWriteLock(client, "user-1", async () => {
      throw new Error("stage failed");
    })).rejects.toThrow("stage failed");

    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "acquire_user_write_lock",
      "release_user_write_lock",
      "acquire_user_write_lock",
      "release_user_write_lock",
    ]);
  });

  it("surfaces lock-release failures rather than hiding a successful write", async () => {
    const { client } = lockClient({ releaseError: { message: "injected release failure" } });

    await expect(withUserWriteLock(client, "user-1", async () => "done"))
      .rejects.toThrow("Could not release the account write lock: injected release failure");
  });

  it("renews the lease for a long-running operation", async () => {
    vi.useFakeTimers();
    const { client, rpc } = lockClient();
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const result = withUserWriteLock(client, "user-1", () => operation);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(rpc).toHaveBeenCalledWith(
      "renew_user_write_lock",
      expect.objectContaining({ p_user_id: "user-1", p_lease_seconds: 90 }),
    );

    finish();
    await expect(result).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
