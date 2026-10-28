import type { NormalizedTransaction } from "@/lib/contracts";

export function countImportOverlaps(transactions: readonly NormalizedTransaction[]) {
  const occurrences = new Map<string, number>();
  let duplicateSourceIds = 0;
  let possibleDuplicates = 0;

  for (const transaction of transactions) {
    const hasSourceId = Boolean(transaction.source_transaction_id);
    const identity = hasSourceId
      ? [
          transaction.source_account_id ?? "",
          transaction.currency,
          transaction.source_transaction_id,
        ]
      : [
          transaction.txn_date,
          transaction.amount_cents,
          transaction.currency,
          transaction.source_account_id ?? "",
          transaction.merchant_norm ?? "",
          transaction.description ?? "",
        ];
    const key = JSON.stringify(identity);
    const count = occurrences.get(key) ?? 0;
    if (count > 0) {
      if (hasSourceId) duplicateSourceIds += 1;
      else possibleDuplicates += 1;
    }
    occurrences.set(key, count + 1);
  }

  return { duplicateSourceIds, possibleDuplicates };
}
