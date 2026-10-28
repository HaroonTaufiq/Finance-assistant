import { createHash } from "node:crypto";
import type { NormalizedTransaction } from "@/lib/contracts";

/**
 * Content hash used as the idempotency key (PRD-A2). Combined with the
 * `unique(user_id, content_hash)` constraint (schema.sql), re-uploading the
 * same CSV is a no-op. Hash is stable across runs for identical input.
 */
export function contentHash(userId: string, txn: NormalizedTransaction): string {
  const key = txn.source_transaction_id
    ? [
        userId,
        txn.source_account_id ?? "",
        txn.currency,
        "source-id",
        txn.source_transaction_id,
      ].join("|")
    : [
        userId,
        txn.txn_date,
        txn.amount_cents,
        txn.currency,
        txn.source_account_id ?? "",
        txn.merchant_norm ?? "",
        txn.description ?? "",
      ].join("|");
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Drop in-file duplicates before insert so import counts are accurate and a
 * single INSERT can't collide with itself. Returns rows tagged with their hash.
 */
export function dedupeInBatch(
  userId: string,
  txns: NormalizedTransaction[],
  importFingerprint = createHash("sha256").update(JSON.stringify(txns)).digest("hex"),
): {
  rows: (NormalizedTransaction & { content_hash: string })[];
  inFileDuplicates: number;
  possibleDuplicates: number;
} {
  const seen = new Set<string>();
  const rowOccurrences = new Map<string, number>();
  const rows: (NormalizedTransaction & { content_hash: string })[] = [];
  let inFileDuplicates = 0;
  let possibleDuplicates = 0;

  for (const txn of txns) {
    const stableHash = contentHash(userId, txn);
    const occurrence = rowOccurrences.get(stableHash) ?? 0;
    rowOccurrences.set(stableHash, occurrence + 1);
    if (!txn.source_transaction_id && occurrence > 0) possibleDuplicates += 1;
    const hash = txn.source_transaction_id
      ? stableHash
      : createHash("sha256")
          .update(`${stableHash}|${importFingerprint}|${occurrence}`)
          .digest("hex");
    if (seen.has(hash)) {
      inFileDuplicates++;
      continue;
    }
    seen.add(hash);
    rows.push({ ...txn, content_hash: hash });
  }

  return { rows, inFileDuplicates, possibleDuplicates };
}
