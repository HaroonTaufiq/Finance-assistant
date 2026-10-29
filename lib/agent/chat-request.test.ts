import { describe, expect, it } from "vitest";
import {
  InvalidChatRequestError,
  parseChatRequest,
  readBoundedChatBody,
} from "./chat-request";

const request = (messages: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...extra, messages });

const message = (role: "user" | "assistant", text: string, id: string = role) => ({
  id,
  role,
  parts: [{ type: "text", text }],
});

describe("bounded chat request parsing", () => {
  it("accepts bounded text turns and a UUID conversation identifier", () => {
    const conversationId = "a0000000-0000-4000-8000-000000000001";
    expect(
      parseChatRequest(request([message("user", "How did I do?")], { conversationId })),
    ).toEqual({
      messages: [message("user", "How did I do?")],
      conversationId,
    });
  });

  it("rejects malformed, empty, missing-user, and over-count messages", () => {
    for (const raw of ["{", JSON.stringify({}), request([]), request([message("assistant", "hi")])]) {
      expect(() => parseChatRequest(raw)).toThrow(InvalidChatRequestError);
    }
    const tooMany = Array.from({ length: 41 }, (_, index) =>
      message(index === 40 ? "user" : "assistant", "x", `m-${index}`),
    );
    expect(() => parseChatRequest(request(tooMany))).toThrow(/valid turns/);
  });

  it("bounds the latest user text and the aggregate conversation context", () => {
    expect(() =>
      parseChatRequest(request([message("user", "x".repeat(2001))])),
    ).toThrow(/message exceeds/);

    const context = [
      ...Array.from({ length: 10 }, (_, index) =>
        message("assistant", "x".repeat(1900), `a-${index}`),
      ),
      message("user", "x".repeat(1500)),
    ];
    expect(() => parseChatRequest(request(context))).toThrow(/context limit/);
  });

  it("bounds the encoded body size and rejects malformed conversation identifiers", () => {
    expect(() =>
      parseChatRequest(request([message("user", "hello")], { padding: "x".repeat(270_000) })),
    )
      .toThrow(/size limit/);
    expect(() =>
      parseChatRequest(request([message("user", "hello")], { conversationId: "not-a-uuid" })),
    ).toThrow(/conversationId/);
  });

  it("reads request streams within the byte cap and rejects invalid UTF-8", async () => {
    const body = JSON.stringify({ messages: [message("user", "hello")] });
    await expect(
      readBoundedChatBody(new Request("http://localhost", { method: "POST", body })),
    ).resolves.toBe(body);
    await expect(
      readBoundedChatBody(
        new Request("http://localhost", { method: "POST", body: "x".repeat(270_000) }),
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      readBoundedChatBody(
        new Request("http://localhost", {
          method: "POST",
          body: new Uint8Array([0xff]),
        }),
      ),
    ).rejects.toThrow(/UTF-8/);
  });
});
