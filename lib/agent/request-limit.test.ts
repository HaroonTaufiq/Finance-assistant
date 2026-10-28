import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  reserveUserAiRequest,
  UserAiQuotaExceededError,
  UserAiRequestBusyError,
  withUserAiRequest,
} from "./request-limit";

afterEach(() => {
  delete process.env.FINANCE_AI_REQUESTS_PER_HOUR;
});

describe("server-side per-user AI limits", () => {
  it("uses a conservative default and releases the active slot after generation", async () => {
    const rpc = vi.fn(async (name: string) => ({
      data: name === "reserve_user_ai_request" ? "reserved" : true,
      error: null,
    }));

    await expect(withUserAiRequest({ rpc } as never, "user-1", async () => "grounded"))
      .resolves.toBe("grounded");
    expect(rpc).toHaveBeenCalledWith("reserve_user_ai_request", expect.objectContaining({
      p_max_requests: 12,
      p_window_seconds: 3600,
      p_lease_seconds: 45,
    }));
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("enforces configured request limits and reports concurrency separately", async () => {
    process.env.FINANCE_AI_REQUESTS_PER_HOUR = "4";
    const limited = { rpc: vi.fn().mockResolvedValue({ data: "limited", error: null }) };
    const busy = { rpc: vi.fn().mockResolvedValue({ data: "busy", error: null }) };

    await expect(reserveUserAiRequest(limited as never, "user-1"))
      .rejects.toBeInstanceOf(UserAiQuotaExceededError);
    await expect(reserveUserAiRequest(busy as never, "user-1"))
      .rejects.toBeInstanceOf(UserAiRequestBusyError);
    expect(limited.rpc).toHaveBeenCalledWith("reserve_user_ai_request", expect.objectContaining({
      p_max_requests: 4,
    }));
  });

  it("rejects unsafe configuration instead of silently widening limits", async () => {
    process.env.FINANCE_AI_REQUESTS_PER_HOUR = "1000";
    const rpc = vi.fn();

    await expect(reserveUserAiRequest({ rpc } as never, "user-1"))
      .rejects.toThrow("must be an integer from 1 to 60");
    expect(rpc).not.toHaveBeenCalled();
  });
});
