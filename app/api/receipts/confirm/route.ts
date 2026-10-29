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
import { UserWriteLockBusyError, withUserWriteLock } from "@/lib/db/user-write-lock";
import { fetchAllPages } from "@/lib/db/pagination";
import {
  DatasetCurrencyMismatchError,
  ensureDatasetCurrency,
  LegacyMixedCurrencyError,
} from "@/lib/db/dataset-currency";

export const runtime = "nodejs";
export const maxDuration = 60;

const ConfirmBody = z.object({
  receiptId: z.string().uuid(),
  fields: ReceiptExtraction,
  resolveConflict: z.enum(["keep", "merge"]).optional(),
  mergeTransactionId: z.string().uuid().optional(),
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
  const { receiptId, fields, resolveConflict, mergeTransactionId } = parsed.data;

  if (!fields.date || fields.total_cents == null) {
    return NextResponse.json(
      { error: "date and total are required before confirming" },
      { status: 400 },
    );
  }

  const supabase = await getServerClient();
  try {
    return await withUserWriteLock(supabase, user.id, async () => {
      const { data: receipt, error: receiptError } = await supabase
        .from("receipts")
        .select("status, linked_transaction_id")
        .eq("id", receiptId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (receiptError) {
        return NextResponse.json({ error: `could not load receipt: ${receiptError.message}` }, { status: 500 });
      }
      if (!receipt) return NextResponse.json({ error: "receipt not found" }, { status: 404 });
      if (receipt.status !== "pending" && receipt.status !== "confirmed") {
        return NextResponse.json({ error: "receipt is no longer available for confirmation" }, { status: 409 });
      }

      const parsedCurrency = SupportedCurrencySchema.safeParse(fields.currency);
      if (!parsedCurrency.success) {
        return NextResponse.json({ error: "receipt currency is not supported" }, { status: 422 });
      }
      await ensureDatasetCurrency(supabase, user.id, parsedCurrency.data);

      const merchantNorm = normalizeMerchant(fields.merchant);
      const amountCents = -Math.abs(fields.total_cents!);
      let monthStart = `${fields.date!.slice(0, 7)}-01`;
      let existingReceiptTransaction: { id: string; txn_date: string } | null = null;

      if (receipt.status === "confirmed" && !receipt.linked_transaction_id) {
        return NextResponse.json({ error: "confirmed receipt has no linked transaction" }, { status: 409 });
      }
      if (receipt.status === "confirmed") {
        const { data: linkedTransaction, error: linkedTransactionError } = await supabase
          .from("transactions")
          .select("id, txn_date")
          .eq("id", receipt.linked_transaction_id)
          .eq("user_id", user.id)
          .maybeSingle();
        if (linkedTransactionError || !linkedTransaction) {
          return NextResponse.json(
            { error: linkedTransactionError?.message ?? "linked transaction could not be found" },
            { status: 409 },
          );
        }
        existingReceiptTransaction = linkedTransaction as { id: string; txn_date: string };
        monthStart = `${existingReceiptTransaction.txn_date.slice(0, 7)}-01`;
      } else {
        const { data: existingReceiptTxn, error: receiptTxnError } = await supabase
          .from("transactions")
          .select("id, txn_date")
          .eq("user_id", user.id)
          .eq("source_transaction_id", receiptId)
          .maybeSingle();
        if (receiptTxnError) {
          return NextResponse.json({ error: `could not load receipt transaction retry: ${receiptTxnError.message}` }, { status: 500 });
        }
        if (existingReceiptTxn) {
          existingReceiptTransaction = existingReceiptTxn as { id: string; txn_date: string };
          monthStart = `${existingReceiptTransaction.txn_date.slice(0, 7)}-01`;
        }
      }

      const { data: priorJob, error: priorJobError } = await supabase
        .from("import_jobs")
        .select("id, status")
        .eq("user_id", user.id)
        .eq("file_fingerprint", `receipt:${receiptId}`)
        .maybeSingle();
      if (priorJobError) {
        return NextResponse.json({ error: `could not load receipt revision: ${priorJobError.message}` }, { status: 500 });
      }
      if (receipt.status === "confirmed" && priorJob?.status === "complete") {
        return NextResponse.json({ transactionId: receipt.linked_transaction_id });
      }

      let duplicateQuery = supabase
          .from("transactions")
          .select("id, source_transaction_id, txn_date, amount_cents, currency, merchant_norm")
          .eq("user_id", user.id)
          .eq("txn_date", fields.date)
          .eq("amount_cents", amountCents)
          .eq("currency", parsedCurrency.data);
      duplicateQuery = merchantNorm
        ? duplicateQuery.eq("merchant_norm", merchantNorm)
        : duplicateQuery.is("merchant_norm", null);
      const duplicates: {
        id: string;
        source_transaction_id: string | null;
        txn_date: string;
        amount_cents: number;
        currency: string;
        merchant_norm: string | null;
      }[] = existingReceiptTransaction
        ? []
        : await fetchAllPages<{
          id: string;
          source_transaction_id: string | null;
          txn_date: string;
          amount_cents: number;
          currency: string;
          merchant_norm: string | null;
        }>(
          duplicateQuery.order("id", { ascending: true }),
          "receipt duplicate lookup failed",
        );
      const retryingExistingPurchase = existingReceiptTransaction !== null;
      const possibleMatches = duplicates.filter(
        (transaction) => transaction.source_transaction_id !== receiptId,
      );
      if (!retryingExistingPurchase && possibleMatches.length > 0 && !resolveConflict) {
        return NextResponse.json({
          conflict: {
            existingTransactions: possibleMatches.map(
              ({ id, txn_date, amount_cents, currency, merchant_norm }) => ({
                id,
                txn_date,
                amount_cents,
                currency,
                merchant_norm,
              }),
            ),
          },
        });
      }
      if (!retryingExistingPurchase && resolveConflict === "merge" && !mergeTransactionId) {
        return NextResponse.json(
          { error: "choose the existing transaction to merge this receipt into" },
          { status: 400 },
        );
      }
      if (retryingExistingPurchase && resolveConflict === "merge" &&
        mergeTransactionId !== existingReceiptTransaction?.id) {
        return NextResponse.json(
          { error: "the receipt is already linked to a different transaction" },
          { status: 409 },
        );
      }
      if (!retryingExistingPurchase && resolveConflict === "merge" &&
        !possibleMatches.some(({ id }) => id === mergeTransactionId)) {
        return NextResponse.json(
          { error: "the selected transaction is not an available owned match" },
          { status: 409 },
        );
      }
      if (resolveConflict === "keep" && mergeTransactionId) {
        return NextResponse.json({ error: "a merge target cannot be supplied when keeping a new purchase" }, { status: 400 });
      }
      if (!retryingExistingPurchase && possibleMatches.length === 0 && resolveConflict === "merge") {
        return NextResponse.json({ error: "there is no matching transaction to merge" }, { status: 409 });
      }

      const { data: job, error: jobError } = await supabase
        .from("import_jobs")
        .upsert(
          {
            user_id: user.id,
            file_fingerprint: `receipt:${receiptId}`,
            status: "processing",
            affected_months: [monthStart],
            row_count: 1,
            error_code: null,
            completed_at: null,
          },
          { onConflict: "user_id,file_fingerprint" },
        )
        .select("id")
        .single();
      if (jobError || !job) {
        return NextResponse.json({ error: `could not start receipt revision: ${jobError?.message ?? "missing job id"}` }, { status: 500 });
      }

      try {
        let transactionId: string;
        if (existingReceiptTransaction) {
          transactionId = existingReceiptTransaction.id;
        } else if (resolveConflict === "merge") {
          transactionId = mergeTransactionId!;
        } else {
          const txn: NormalizedTransaction = {
            txn_date: fields.date!,
            amount_cents: amountCents,
            currency: parsedCurrency.data,
            transaction_kind: "expense",
            merchant_raw: fields.merchant,
            merchant_norm: merchantNorm,
            category: "uncategorized",
            description: fields.merchant,
            source_account_id: null,
            source_transaction_id: receiptId,
            source: "receipt",
            metadata: { receiptId, lineItems: fields.lineItems },
          };
          const hash = contentHash(user.id, txn);

          const { data: inserted, error: insErr } = await supabase
            .from("transactions")
            .upsert(
              { ...txn, user_id: user.id, content_hash: hash, import_job_id: job.id },
              { onConflict: "user_id,content_hash", ignoreDuplicates: true },
            )
            .select("id")
            .maybeSingle();
          if (insErr) throw new Error(`could not save receipt transaction: ${insErr.message}`);

          if (inserted) {
            transactionId = (inserted as { id: string }).id;
          } else {
            const { data: existing, error: existingError } = await supabase
              .from("transactions")
              .select("id")
              .eq("user_id", user.id)
              .eq("content_hash", hash)
              .maybeSingle();
            if (existingError || !existing) {
              throw new Error(existingError?.message ?? "saved receipt transaction could not be verified");
            }
            transactionId = (existing as { id: string }).id;
          }
        }

        const { error: receiptUpdateError } = await supabase
          .from("receipts")
          .update({ status: "confirmed", linked_transaction_id: transactionId })
          .eq("id", receiptId)
          .eq("user_id", user.id);
        if (receiptUpdateError) {
          throw new Error(`transaction saved but receipt status update failed: ${receiptUpdateError.message}`);
        }

        await runBatchForUser(user.id, { affectedMonths: [monthStart] });
        const { error: completeError } = await supabase
          .from("import_jobs")
          .update({ status: "complete", error_code: null, completed_at: new Date().toISOString() })
          .eq("id", job.id)
          .eq("user_id", user.id);
        if (completeError) throw new Error(`receipt recomputed but revision completion failed: ${completeError.message}`);
        return NextResponse.json({ transactionId, revisionId: job.id });
      } catch (error) {
        const { error: failedJobError } = await supabase
          .from("import_jobs")
          .update({ status: "failed", error_code: "RECEIPT_CONFIRMATION_FAILED" })
          .eq("id", job.id)
          .eq("user_id", user.id);
        if (failedJobError) {
          return NextResponse.json(
            { error: `receipt confirmation failed (${error instanceof Error ? error.message : "unknown failure"}) and recovery state could not be recorded: ${failedJobError.message}` },
            { status: 500 },
          );
        }
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Receipt confirmation failed.", retryRequired: true },
          { status: 503 },
        );
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Receipt confirmation failed." },
      {
        status: error instanceof UserWriteLockBusyError
          ? 409
          : error instanceof DatasetCurrencyMismatchError || error instanceof LegacyMixedCurrencyError
            ? 422
            : 503,
      },
    );
  }
}
