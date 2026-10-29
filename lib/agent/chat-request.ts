import type { UIMessage } from "ai";
import {
  MAX_CHAT_BODY_BYTES,
  MAX_CHAT_CONTEXT_CHARS,
  MAX_CHAT_MESSAGES,
  MAX_MESSAGE_CHARS,
} from "@/lib/limits";

export class InvalidChatRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
    this.name = "InvalidChatRequestError";
  }
}

export interface ParsedChatRequest {
  messages: UIMessage[];
  conversationId: string | null;
}

export async function readBoundedChatBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_CHAT_BODY_BYTES) {
      try {
        await reader.cancel();
      } catch (error) {
        console.error("Could not cancel oversized chat request body", error);
      }
      throw new InvalidChatRequestError("chat request exceeds the size limit", 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new InvalidChatRequestError("chat request body must be valid UTF-8", 400);
  }
}

export function parseChatRequest(rawBody: string): ParsedChatRequest {
  if (new TextEncoder().encode(rawBody).byteLength > MAX_CHAT_BODY_BYTES) {
    throw new InvalidChatRequestError("chat request exceeds the size limit", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new InvalidChatRequestError("invalid JSON body", 400);
  }
  if (typeof body !== "object" || body === null || !("messages" in body)) {
    throw new InvalidChatRequestError("no messages", 400);
  }
  const candidateMessages = body.messages;
  if (
    !Array.isArray(candidateMessages) ||
    candidateMessages.length === 0 ||
    candidateMessages.length > MAX_CHAT_MESSAGES ||
    !candidateMessages.every(isUIMessage)
  ) {
    throw new InvalidChatRequestError(
      `messages must contain 1-${MAX_CHAT_MESSAGES} valid turns`,
      400,
    );
  }
  const lastUser = [...candidateMessages].reverse().find((message) => message.role === "user");
  if (!lastUser) throw new InvalidChatRequestError("a user message is required", 400);
  if (textLength(lastUser) > MAX_MESSAGE_CHARS) {
    throw new InvalidChatRequestError(
      `message exceeds the ${MAX_MESSAGE_CHARS}-character limit`,
      400,
    );
  }
  const contextLength = candidateMessages.reduce(
    (total, message) => total + textLength(message),
    0,
  );
  if (contextLength > MAX_CHAT_CONTEXT_CHARS) {
    throw new InvalidChatRequestError(
      `chat history exceeds the ${MAX_CHAT_CONTEXT_CHARS}-character context limit`,
      413,
    );
  }

  const conversationId = "conversationId" in body ? body.conversationId : null;
  if (
    conversationId !== null &&
    (typeof conversationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId))
  ) {
    throw new InvalidChatRequestError("conversationId must be a UUID or null", 400);
  }
  return { messages: candidateMessages, conversationId };
}

function isUIMessage(value: unknown): value is UIMessage {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    !("role" in value) ||
    !("parts" in value)
  ) return false;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    (value.role !== "user" && value.role !== "assistant") ||
    !Array.isArray(value.parts)
  ) return false;
  return value.parts.every((part) => {
    if (
      typeof part !== "object" ||
      part === null ||
      !("type" in part) ||
      typeof part.type !== "string"
    ) return false;
    return part.type !== "text" || ("text" in part && typeof part.text === "string");
  });
}

function textLength(message: UIMessage): number {
  return message.parts.reduce(
    (length, part) => part.type === "text" ? length + part.text.length : length,
    0,
  );
}
