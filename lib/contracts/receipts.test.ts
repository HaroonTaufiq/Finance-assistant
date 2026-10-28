import { describe, expect, it } from "vitest";
import {
  createManualReceiptDraft,
  manualReceiptDraftFromFailure,
} from "./receipts";

describe("receipt manual-entry fallback", () => {
  const receiptId = "a0000000-0000-4000-8000-000000000001";

  it("creates an explicitly unextracted draft requiring all key fields to be reviewed", () => {
    expect(createManualReceiptDraft(receiptId)).toEqual({
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
    });
  });

  it("only opens manual entry for a server-declared provider failure with a valid draft", () => {
    const draft = createManualReceiptDraft(receiptId);
    expect(manualReceiptDraftFromFailure({
      error: "provider unavailable",
      manualEntryRequired: true,
      draft,
    })).toEqual(draft);
    expect(manualReceiptDraftFromFailure({ error: "upload failed", draft })).toBeNull();
    expect(manualReceiptDraftFromFailure({
      manualEntryRequired: true,
      draft: { ...draft, requiresConfirm: false },
    })).toBeNull();
  });
});
