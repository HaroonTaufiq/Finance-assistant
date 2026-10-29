import { z } from "zod";

/** Source of a transaction row (mirrors transactions.source check in schema.sql). */
export const TransactionSource = z.enum(["csv", "bank", "receipt", "manual"]);
export type TransactionSource = z.infer<typeof TransactionSource>;

export const TransactionKind = z.enum(["expense", "refund", "income", "transfer", "unknown"]);
export type TransactionKind = z.infer<typeof TransactionKind>;

export const SupportedCurrency = z.enum(["USD", "PKR", "EUR", "GBP"]);
export type SupportedCurrency = z.infer<typeof SupportedCurrency>;

/**
 * A cleaned, validated transaction ready to insert. Produced by the ingest
 * pipeline (A2) and the receipt confirm flow (C1). `amount_cents` is signed:
 * negative = outflow, positive = inflow. `user_id`, `content_hash`, `id`, and
 * `created_at` are attached by the pipeline / DB, not by validation.
 */
const NormalizedTransactionFields = z.object({
  txn_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be ISO YYYY-MM-DD"),
  amount_cents: z.number().int(),
  currency: SupportedCurrency.default("USD"),
  transaction_kind: TransactionKind.default("unknown"),
  merchant_raw: z.string().nullable(),
  merchant_norm: z.string().nullable(),
  category: z.string().min(1).default("uncategorized"),
  description: z.string().nullable(),
  source_account_id: z.string().nullable().default(null),
  source_transaction_id: z.string().nullable().default(null),
  source: TransactionSource,
  metadata: z.record(z.unknown()).default({}),
});

function validateTransactionSigns(
  transaction: z.infer<typeof NormalizedTransactionFields>,
  context: z.RefinementCtx,
) {
  if (transaction.amount_cents === 0) {
    context.addIssue({ code: "custom", path: ["amount_cents"], message: "must not be zero" });
  }
  if (transaction.amount_cents < 0 && !["expense", "transfer"].includes(transaction.transaction_kind)) {
    context.addIssue({
      code: "custom",
      path: ["transaction_kind"],
      message: "negative amounts must be expenses or transfers",
    });
  }
  if (transaction.amount_cents > 0 && !["refund", "income", "transfer", "unknown"].includes(transaction.transaction_kind)) {
    context.addIssue({
      code: "custom",
      path: ["transaction_kind"],
      message: "positive amounts must be refunds, income, transfers, or unknown inflows",
    });
  }
}

export const NormalizedTransaction = NormalizedTransactionFields.superRefine(
  validateTransactionSigns,
);
export type NormalizedTransaction = z.infer<typeof NormalizedTransaction>;

/** A persisted transaction row as read back from the DB. */
export const TransactionRow = NormalizedTransactionFields.extend({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  content_hash: z.string(),
  created_at: z.string(),
}).superRefine(validateTransactionSigns);
export type TransactionRow = z.infer<typeof TransactionRow>;
