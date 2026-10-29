import { NextResponse } from "next/server";
import { getCurrentUser, getServerClient } from "@/lib/db/client";
import { streamAssistantReply } from "@/lib/agent/orchestrator";
import { MAX_CHAT_BODY_BYTES } from "@/lib/limits";
import {
  InvalidChatRequestError,
  parseChatRequest,
  readBoundedChatBody,
} from "@/lib/agent/chat-request";
import {
  releaseUserAiRequest,
  reserveUserAiRequest,
  UserAiQuotaExceededError,
  UserAiRequestBusyError,
} from "@/lib/agent/request-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/chat — authenticated, bounded model/tool loop.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_CHAT_BODY_BYTES) {
    return NextResponse.json({ error: "chat request exceeds the size limit" }, { status: 413 });
  }

  let rawBody: string;
  try {
    rawBody = await readBoundedChatBody(req);
  } catch (error) {
    if (error instanceof InvalidChatRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "could not read chat request" }, { status: 400 });
  }

  let parsed;
  try {
    parsed = parseChatRequest(rawBody);
  } catch (error) {
    if (error instanceof InvalidChatRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "chat request could not be validated" }, { status: 400 });
  }
  const { messages, conversationId } = parsed;
  const supabase = await getServerClient();
  let token: string;
  try {
    token = await reserveUserAiRequest(supabase, user.id);
  } catch (error) {
    return aiLimitResponse(error);
  }

  try {
    const { result } = await streamAssistantReply({
      userId: user.id,
      conversationId,
      messages,
    });
    const response = result.toUIMessageStreamResponse();
    return await releaseWhenStreamEnds(response, () =>
      releaseUserAiRequest(supabase, user.id, token),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The assistant request failed.";
    try {
      await releaseUserAiRequest(supabase, user.id, token);
    } catch (releaseError) {
      console.error("Could not release AI request after chat startup failed", releaseError);
      return NextResponse.json(
        { error: "The assistant request failed and its concurrency slot could not be released." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

function aiLimitResponse(error: unknown): Response {
  if (error instanceof UserAiRequestBusyError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof UserAiQuotaExceededError) {
    return NextResponse.json(
      { error: error.message },
      { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } },
    );
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "AI request limit could not be checked." },
    { status: 503 },
  );
}

async function releaseWhenStreamEnds(
  response: Response,
  release: () => Promise<void>,
): Promise<Response> {
  if (!response.body) {
    await release();
    return response;
  }
  const reader = response.body.getReader();
  let released = false;
  const releaseOnce = async () => {
    if (released) return;
    released = true;
    await release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await releaseOnce();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        try {
          await releaseOnce();
        } catch {
          controller.error(new Error("Chat stream and AI request cleanup both failed", { cause: error }));
          return;
        }
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await releaseOnce();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
