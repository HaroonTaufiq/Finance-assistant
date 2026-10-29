import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import { getCurrentUser, getServerClient } from "@/lib/db/client";
import { visionModel } from "@/lib/agent/models";
import {
  coerceDate,
  createManualReceiptDraft,
  type ReceiptExtraction,
  type ReceiptDraft,
} from "@/lib/contracts";
import { MAX_IMAGE_BYTES, ALLOWED_IMAGE_TYPES, formatBytes } from "@/lib/limits";
import {
  UserAiQuotaExceededError,
  UserAiRequestBusyError,
  withUserAiRequest,
} from "@/lib/agent/request-limit";
import { UserWriteLockBusyError, withUserWriteLock } from "@/lib/db/user-write-lock";

export const runtime = "nodejs";
export const maxDuration = 30;

const CONFIDENCE_THRESHOLD = 0.7;

// The vision model returns amounts in major units; we convert to cents after.
const VisionSchema = z.object({
  merchant: z.string().nullable(),
  date: z.string().nullable(),
  total: z.number().nullable(),
  currency: z.string().default("USD"),
  lineItems: z.array(z.object({ desc: z.string(), amount: z.number() })).default([]),
  confidence: z.number().min(0).max(1),
});

const EXTRACTION_PROMPT = `You are extracting structured data from a photo of a receipt. The image may be rotated, blurry, partially cut off, or in another language — handle rotation and translate the merchant name to its common form. Extract: merchant name, date, grand total, currency, and line items. Use the GRAND TOTAL (after tax), not the subtotal. Return amounts as decimal numbers in major currency units. Set "confidence" to your honest overall confidence (0-1); use a low value if the image is hard to read or fields are missing. Use null for anything you cannot read.`;

/**
 * POST /api/receipts — image upload → store → vision extract → confidence gate.
 * Always returns a DRAFT that requires explicit confirmation; a low-confidence
 * or incomplete extraction is never silently recorded (SPEC §8).
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no image provided" }, { status: 400 });
  }
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: "unsupported image type — use PNG, JPEG, or WebP" },
      { status: 415 },
    );
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json(
      { error: `image exceeds the ${formatBytes(MAX_IMAGE_BYTES)} limit` },
      { status: 413 },
    );
  }

  const supabase = await getServerClient();
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return await withUserWriteLock(supabase, user.id, async () => {
      const receiptId = randomUUID();
      const ext = (file.name.split(".").pop() ?? "jpg").toLowerCase();
      const storagePath = `${user.id}/${receiptId}.${ext}`;

      const { error: upErr } = await supabase.storage
        .from("receipts")
        .upload(storagePath, bytes, { contentType: file.type || "image/jpeg", upsert: true });
      if (upErr) {
        return NextResponse.json({ error: `upload failed: ${upErr.message}` }, { status: 500 });
      }

      const { error: insertError } = await supabase.from("receipts").insert({
        id: receiptId,
        user_id: user.id,
        storage_path: storagePath,
        status: "pending",
      });
      if (insertError) {
        const { error: cleanupError } = await supabase.storage.from("receipts").remove([storagePath]);
        const detail = cleanupError
          ? `${insertError.message}; image cleanup failed: ${cleanupError.message}`
          : insertError.message;
        return NextResponse.json({ error: `could not save receipt: ${detail}` }, { status: 500 });
      }

      let extraction: ReceiptExtraction;
      try {
        const { object } = await withUserAiRequest(supabase, user.id, () =>
          generateObject({
            model: visionModel(),
            schema: VisionSchema,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: EXTRACTION_PROMPT },
                  { type: "image", image: bytes, mediaType: file.type || "image/jpeg" },
                ],
              },
            ],
          }),
        );
        extraction = {
          merchant: object.merchant,
          date: coerceDate(object.date),
          total_cents: object.total != null ? Math.round(object.total * 100) : null,
          currency: object.currency ?? "USD",
          lineItems: object.lineItems.map((li) => ({
            desc: li.desc,
            amount_cents: Math.round(li.amount * 100),
          })),
          confidence: object.confidence,
        };
      } catch (error) {
        const draft = createManualReceiptDraft(receiptId);
        const status =
          error instanceof UserAiQuotaExceededError
            ? 429
            : error instanceof UserAiRequestBusyError
              ? 409
              : 503;
        const headers =
          error instanceof UserAiQuotaExceededError
            ? { "Retry-After": String(error.retryAfterSeconds) }
            : undefined;
        return NextResponse.json(
          {
            error: "Automatic extraction is unavailable. The image is saved; enter its details manually.",
            manualEntryRequired: true,
            draft,
          },
          { status, headers },
        );
      }

      const { error: updateError } = await supabase
        .from("receipts")
        .update({ extracted: extraction, confidence: extraction.confidence })
        .eq("id", receiptId)
        .eq("user_id", user.id);
      if (updateError) {
        return NextResponse.json({ error: `could not save receipt extraction: ${updateError.message}` }, { status: 500 });
      }

      const lowConfidenceFields: string[] = [];
      if (!extraction.merchant) lowConfidenceFields.push("merchant");
      if (!extraction.date) lowConfidenceFields.push("date");
      if (extraction.total_cents == null) lowConfidenceFields.push("total");
      if (extraction.confidence < CONFIDENCE_THRESHOLD && lowConfidenceFields.length === 0) {
        lowConfidenceFields.push("total");
      }

      const draft: ReceiptDraft = {
        receiptId,
        draft: extraction,
        requiresConfirm: true,
        lowConfidenceFields,
      };
      return NextResponse.json(draft);
    });
  } catch (error) {
    const status = error instanceof UserWriteLockBusyError ? 409 : 503;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Receipt upload could not be completed." },
      { status },
    );
  }
}
