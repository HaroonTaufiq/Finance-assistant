import { z } from "zod";

/**
 * Structured receipt extraction produced by the vision model (C1) and validated
 * before display. Every field is nullable because a blurry/cut-off receipt may
 * not yield it; the confidence gate (SPEC §8) decides whether to confirm with
 * the user rather than silently record a wrong amount.
 */
export const ReceiptLineItem = z.object({
  desc: z.string(),
  amount_cents: z.number().int(),
});
export type ReceiptLineItem = z.infer<typeof ReceiptLineItem>;

export const ReceiptExtraction = z.object({
  merchant: z.string().nullable(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(), // ISO; null when illegible
  total_cents: z.number().int().nullable(),
  currency: z.string().default("USD"),
  lineItems: z.array(ReceiptLineItem).default([]),
  confidence: z.number().min(0).max(1),
});
export type ReceiptExtraction = z.infer<typeof ReceiptExtraction>;

/** Draft returned to the chat UI; always requires explicit confirm (SPEC §8). */
export const ReceiptDraft = z.object({
  receiptId: z.string().uuid(),
  draft: ReceiptExtraction,
  requiresConfirm: z.literal(true),
  lowConfidenceFields: z.array(z.string()),
});
export type ReceiptDraft = z.infer<typeof ReceiptDraft>;

export function createManualReceiptDraft(receiptId: string): ReceiptDraft {
  return {
    receiptId,
    draft: {
      merchant: null,
      date: null,
      total_cents: null,
      currency: "USD",
      lineItems: [],
      confidence: 0,
    },
    requiresConfirm: true,
    lowConfidenceFields: ["merchant", "date", "total"],
  };
}

export function manualReceiptDraftFromFailure(payload: unknown): ReceiptDraft | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("manualEntryRequired" in payload) ||
    payload.manualEntryRequired !== true ||
    !("draft" in payload)
  ) return null;
  const parsed = ReceiptDraft.safeParse(payload.draft);
  return parsed.success ? parsed.data : null;
}
