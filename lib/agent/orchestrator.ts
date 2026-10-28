import "server-only";
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from "ai";
import { getServerClient } from "@/lib/db/client";
import { routerModel } from "./models";
import { buildToolSet } from "./tools";
import { buildSystemPrompt } from "./prompts";
import { loadMemory } from "@/lib/memory/rules";

/**
 * The read-path entrypoint (PRD-B1, SPEC §5). Runs a single AI SDK tool-calling
 * loop on the cheap ROUTER_MODEL, capped at ~4 tool steps. The model routes to
 * typed tools; free-form transaction descriptions and source CSV never enter its
 * context, while bounded transaction lookups may return date, merchant, category,
 * amount, and currency after the user asks a specific question. Persists user + assistant
 * messages. Heavy reasoning lives inside individual tools, not here.
 */
export async function streamAssistantReply(args: {
  userId: string;
  conversationId: string | null;
  messages: UIMessage[];
}) {
  const { userId, messages } = args;
  const supabase = await getServerClient();

  // Ensure a conversation row exists for persistence.
  let conversationId = args.conversationId;
  if (!conversationId) {
    const { data } = await supabase
      .from("conversations")
      .insert({ user_id: userId, title: deriveTitle(messages) })
      .select("id")
      .single();
    conversationId = (data as { id: string } | null)?.id ?? null;
  }

  // Persist the latest user turn before we stream the reply.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (conversationId && lastUser) {
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      user_id: userId,
      role: "user",
      content: extractText(lastUser),
    });
  }

  // Deterministic user memory → compact summary injected into the prompt (B3).
  const memory = await loadMemory(userId);
  const today = new Date().toISOString().slice(0, 10);
  const system = buildSystemPrompt({ today, memorySummary: memory.promptSummary });

  const result = streamText({
    model: routerModel(),
    system,
    messages: convertToModelMessages(messages),
    tools: buildToolSet({ userId, today }),
    stopWhen: stepCountIs(5), // <= ~4 tool steps, then synthesize (SPEC §5)
    onFinish: async ({ text, toolCalls }) => {
      if (!conversationId) return;
      await supabase.from("messages").insert({
        conversation_id: conversationId,
        user_id: userId,
        role: "assistant",
        content: text,
        tool_calls: toolCalls.length > 0 ? toolCalls : null,
      });
    },
  });

  return { result, conversationId };
}

function extractText(message: UIMessage): string {
  return (message.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function deriveTitle(messages: UIMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = firstUser ? extractText(firstUser) : "New conversation";
  return text.slice(0, 60) || "New conversation";
}
