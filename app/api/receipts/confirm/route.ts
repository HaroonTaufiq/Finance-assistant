import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser, getServerClient } from "@/lib/db/client";
import { runBatchForUser } from "@/lib/batch";
import { contentHash } from "@/lib/ingest/dedup";
import {
  ReceiptExtraction,
  SupportedCurrency as SupportedCurrencySchema,
  normalizeMerchant,
  type NormalizedTransaction,
} from "@/lib/contracts";
import { z } from "zod";

export const runtime = "nodejs";

const ConfirmBody = z.object({
  receiptId: z.string().uuid(),
  fields: ReceiptExtraction,
  resolveConflict: z.enum(["keep", "merge"]).optional(),
});

/**
 * POST /api/receipts/confirm — user-confirmed (and possibly corrected) receipt
 * becomes a transaction. Detects a near-duplicate bank row (date+amount+
 * merchant) and surfaces the conflict instead of double-counting (SPEC §9).
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = ConfirmBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { receiptId, fields, resolveConflict } = parsed.data;

  if (!fields.date || fields.total_cents == null) {
    return NextResponse.json(
      { error: "date and total are required before confirming" },
      { status: 400 },
    );
  }

  const supabase = await getServerClient();
  const parsedCurrency = SupportedCurrencySchema.safeParse(fields.currency);
  if (!parsedCurrency.success) {
    return NextResponse.json({ error: "receipt currency is not supported" }, { status: 422 });
  }
  const { data: settings, error: settingsError } = await supabase
    .from("financial_settings")
    .select("currency")
    .eq("user_id", user.id)
    .maybeSingle();
  if (settingsError) {
    return NextResponse.json({ error: `could not verify dataset currency: ${settingsError.message}` }, { status: 500 });
  }
  const datasetCurrency = (settings as { currency: string | null } | null)?.currency;
  if (!datasetCurrency || datasetCurrency !== parsedCurrency.data) {
    return NextResponse.json(
      { error: "receipt currency must match a previously confirmed dataset currency" },
      { status: 422 },
    );
  }
  const merchantNorm = normalizeMerchant(fields.merchant);
  const amountCents = -Math.abs(fields.total_cents); // a receipt is spend

  // Near-duplicate detection against existing transactions.
  if (!resolveConflict) {
    let dupQuery = supabase
      .from("transactions")
      .select("id")
      .eq("user_id", user.id)
      .eq("txn_date", fields.date)
      .eq("amount_cents", amountCents);
    dupQuery = merchantNorm
      ? dupQuery.eq("merchant_norm", merchantNorm)
      : dupQuery.is("merchant_norm", null);
    const { data: dup } = await dupQuery.maybeSingle();
    if (dup) {
      return NextResponse.json({
        conflict: { existingTransactionId: (dup as { id: string }).id },
      });
    }
  }

  const txn: NormalizedTransaction = {
    txn_date: fields.date,
    amount_cents: amountCents,
    currency: parsedCurrency.data,
    transaction_kind: "expense",
    merchant_raw: fields.merchant,
    merchant_norm: merchantNorm,
    category: "uncategorized",
    description: fields.merchant,
    source_account_id: null,
    source_transaction_id: null,
    source: "receipt",
    metadata: { receiptId, lineItems: fields.lineItems },
  };
  const hash = contentHash(user.id, txn);

  const { data: inserted, error: insErr } = await supabase
    .from("transactions")
    .upsert(
      { ...txn, user_id: user.id, content_hash: hash },
      { onConflict: "user_id,content_hash", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();
  if (insErr) {
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  const transactionId = (inserted as { id: string } | null)?.id ?? null;

  await supabase
    .from("receipts")
    .update({ status: "confirmed", linked_transaction_id: transactionId })
    .eq("id", receiptId);

  // Reflect the new transaction in rollups/budgets.
  await runBatchForUser(user.id, { affectedMonths: [`${fields.date.slice(0, 7)}-01`] });

  return NextResponse.json({ transactionId });
}
