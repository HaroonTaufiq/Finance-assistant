"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import { ArrowUp, Square, Paperclip } from "lucide-react";
import {
  manualReceiptDraftFromFailure,
  ReceiptDraft as ReceiptDraftSchema,
  type ResultCardData,
  type IngestSummary,
  type ReceiptDraft,
} from "@/lib/contracts";
import { recordAnalyticsEvent } from "@/lib/analytics/client";
import { ResultCard } from "./result-card";
import { ImportSummaryCard } from "./import-summary";
import { MonthlyReport } from "./monthly-report";
import { ReceiptDraftCard } from "./receipt-draft-card";
import { Onboarding } from "./onboarding";
import { HelpButton } from "./help-button";
import {
  MAX_IMAGE_BYTES,
  ALLOWED_IMAGE_TYPES,
  MAX_MESSAGE_CHARS,
  formatBytes,
} from "@/lib/limits";
import { cn } from "@/lib/utils";

/**
 * Chat shell (PRD-B2, UI_SPEC §3): sidebar + streaming thread + composer.
 * Consumes the B1 /api/chat stream via useChat; tool results arrive as typed
 * parts and render as cards. CSV ingest is a separate POST surfaced as a card.
 */
export function ChatApp({
  userEmail,
  initialHasData,
}: {
  userEmail: string | null;
  initialHasData: boolean;
}) {
  const { messages, sendMessage, status, stop, error: chatError } = useChat();
  const [input, setInput] = useState("");
  const [hasData, setHasData] = useState(initialHasData);
  const [importSummary, setImportSummary] = useState<IngestSummary | null>(null);
  const [drafts, setDrafts] = useState<ReceiptDraft[]>([]);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const initialQuestionSent = useRef<string | null>(null);
  const lastSent = useRef("");
  const explanationStartedAt = useRef<number | null>(null);

  const busy = status === "submitted" || status === "streaming";
  const showOnboarding = !hasData && messages.length === 0 && drafts.length === 0;

  async function uploadReceipt(file: File) {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setReceiptError("Unsupported image type — use PNG, JPEG, or WebP.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setReceiptError(`That image is too large (max ${formatBytes(MAX_IMAGE_BYTES)}).`);
      return;
    }
    setReceiptBusy(true);
    setReceiptError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/receipts", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) {
        const manualDraft = manualReceiptDraftFromFailure(json);
        if (manualDraft) {
          setDrafts((drafts) => [...drafts, manualDraft]);
          setReceiptError(json.error ?? "Enter the receipt details manually.");
          return;
        }
        throw new Error(json.error ?? "Could not read receipt");
      }
      const parsedDraft = ReceiptDraftSchema.safeParse(json);
      if (!parsedDraft.success) throw new Error("Receipt service returned an invalid draft.");
      setDrafts((drafts) => [...drafts, parsedDraft.data]);
    } catch (e) {
      setReceiptError(e instanceof Error ? e.message : "Could not read receipt");
    } finally {
      setReceiptBusy(false);
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, importSummary]);

  useEffect(() => {
    const startedAt = explanationStartedAt.current;
    if (startedAt === null) return;
    if (status === "ready") {
      explanationStartedAt.current = null;
      void recordAnalyticsEvent({
        eventKey: `explanation-success:${crypto.randomUUID()}`,
        eventName: "explanation_succeeded",
        mode: "personal",
        durationMs: Math.round(performance.now() - startedAt),
      });
    } else if (status === "error") {
      explanationStartedAt.current = null;
      void recordAnalyticsEvent({
        eventKey: `explanation-failure:${crypto.randomUUID()}`,
        eventName: "explanation_failed",
        mode: "personal",
        durationMs: Math.round(performance.now() - startedAt),
        errorCode: "provider_unavailable",
      });
    }
  }, [status]);

  const send = useCallback((text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    lastSent.current = t;
    explanationStartedAt.current = performance.now();
    void sendMessage({ text: t });
    setInput("");
  }, [busy, sendMessage]);

  useEffect(() => {
    if (typeof window === "undefined" || busy) return;
    const question = new URLSearchParams(window.location.search).get("question");
    if (!question || initialQuestionSent.current === question) return;
    initialQuestionSent.current = question;
    send(question);
  }, [busy, send]);

  return (
    <div className="flex h-screen bg-bg text-text">
      {/* Sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface/40 p-4 md:flex">
        <div className="font-display text-lg font-semibold">Finance Assistant</div>
        <Link href="/report" className="mt-4 rounded border border-border px-3 py-2 text-sm text-text-muted hover:text-text">
          Monthly review
        </Link>
        <div className="mt-6 text-[11px] font-medium uppercase tracking-wider text-text-faint">
          Quick facts
        </div>
        <p className="mt-2 text-xs text-text-faint">
          Ask about spending, budgets, subscriptions, or unusual activity.
        </p>
        <div className="mt-auto">
          <div className="truncate text-xs text-text-faint">{userEmail}</div>
          <form action="/auth/signout" method="post">
            <button type="submit" className="mt-1 text-xs text-text-muted hover:text-text">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="scroll-area flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-4 py-8">
            {importSummary && (
              <div className="mb-6">
                <ImportSummaryCard summary={importSummary} />
              </div>
            )}

            {showOnboarding ? (
              <Onboarding
                onUploaded={(s) => {
                  setImportSummary(s);
                  setHasData(true);
                }}
                onExample={(t) => send(t)}
              />
            ) : (
              <div className="space-y-6">
                {importSummary && <MonthlyReport embedded />}
                {messages.length === 0 && drafts.length === 0 && !busy && (
                  <EmptyChat onExample={send} />
                )}
                {messages.map((m) => (
                  <MessageTurn key={m.id} message={m} />
                ))}
                {chatError && (
                  <div role="alert" className="rounded border border-danger/40 p-3 text-sm text-danger">
                    <p>Could not complete the explanation. Your deterministic report is still available.</p>
                    <button
                      type="button"
                      onClick={() => send(lastSent.current)}
                      className="mt-2 underline"
                    >
                      Retry explanation
                    </button>
                  </div>
                )}
                {status === "submitted" && <ToolRunning label="Thinking…" />}
                {receiptBusy && <ToolRunning label="Reading your receipt…" />}
                {receiptError && <p className="text-sm text-danger">{receiptError}</p>}
                {drafts.map((draft) => (
                  <ReceiptDraftCard
                    key={draft.receiptId}
                    draft={draft}
                    onConfirmed={() => {
                      setDrafts((ds) => ds.filter((x) => x.receiptId !== draft.receiptId));
                      setHasData(true);
                    }}
                    onDiscard={() =>
                      setDrafts((ds) => ds.filter((x) => x.receiptId !== draft.receiptId))
                    }
                  />
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-border bg-surface/60">
          <div className="mx-auto w-full max-w-[760px] px-4 py-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="flex items-end gap-2 rounded border border-border bg-surface p-2"
            >
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadReceipt(f);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={receiptBusy}
                className="rounded-sm p-2 text-text-muted hover:text-text disabled:opacity-40"
                aria-label="Attach receipt"
                title="Attach a receipt photo"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                rows={1}
                maxLength={MAX_MESSAGE_CHARS}
                placeholder="Ask about your money…"
                className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-text-faint"
              />
              {busy ? (
                <button
                  type="button"
                  onClick={() => stop()}
                  className="rounded-sm bg-surface-sunk p-2 text-text-muted hover:text-text"
                  aria-label="Stop"
                >
                  <Square className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  className="rounded-sm bg-accent p-2 text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                  aria-label="Send"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </form>
            <p className="mt-2 text-[11px] text-text-faint">
              Chat sends your question to the configured AI provider. Transaction-specific answers may
              include only the selected date, merchant, category, amount and currency; raw CSV and
              imported descriptions are not included in that tool result.
            </p>
            <p className="mt-1 text-[11px] text-text-faint">
              Attaching a receipt uploads its image to your private receipt storage and sends it to the
              configured vision provider for extraction; you review the draft before it is saved.
            </p>
            {input.length > MAX_MESSAGE_CHARS * 0.9 && (
              <div className="mt-1 pr-1 text-right text-xs text-text-faint">
                {input.length}/{MAX_MESSAGE_CHARS}
              </div>
            )}
          </div>
        </div>
      </div>

      <HelpButton />
    </div>
  );
}

const EXAMPLE_PROMPTS = [
  "How much did I spend on groceries last month?",
  "Am I spending more than usual this month?",
  "Find my subscriptions",
  "Any unusual activity?",
];

/** Shown when signed in with data but no active conversation (e.g. after refresh). */
function EmptyChat({ onExample }: { onExample: (text: string) => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center">
      <h2 className="font-display text-2xl font-semibold">Ask me anything.</h2>
      <p className="mt-2 text-text-muted">
        Your data&apos;s loaded. Ask about spending, budgets, subscriptions, or unusual activity.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {EXAMPLE_PROMPTS.map((ex) => (
          <button
            key={ex}
            onClick={() => onExample(ex)}
            className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-text-muted transition-colors hover:border-accent hover:text-text"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

type UIMsg = ReturnType<typeof useChat>["messages"][number];

function MessageTurn({ message }: { message: UIMsg }) {
  const isUser = message.role === "user";

  if (isUser) {
    const text = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded bg-surface-sunk px-3 py-2 text-sm">{text}</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          return part.text ? (
            <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed">
              {part.text}
            </p>
          ) : null;
        }
        if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
          const card = toCardData(part);
          if (card) return <ResultCard key={i} data={card} />;
          const state = (part as { state?: string }).state;
          if (state && state !== "output-available" && state !== "output-error") {
            return <ToolRunning key={i} label="Looking that up…" />;
          }
        }
        return null;
      })}
    </div>
  );
}

/** Narrow an AI SDK tool part's output to ResultCardData (has a `kind`). */
function toCardData(part: unknown): ResultCardData | null {
  const out = (part as { output?: unknown }).output;
  if (out && typeof out === "object" && "kind" in out) {
    return out as ResultCardData;
  }
  return null;
}

function ToolRunning({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-text-faint">
      <span className="flex gap-1">
        <span className={cn("h-1.5 w-1.5 animate-pulse rounded-full bg-text-faint")} />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-faint [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-faint [animation-delay:300ms]" />
      </span>
      {label}
    </div>
  );
}
