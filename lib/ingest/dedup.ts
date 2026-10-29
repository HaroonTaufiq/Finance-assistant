import { createHash } from "node:crypto";
import type { NormalizedTransaction } from "@/lib/contracts";

type SourceLessIdentity = Pick<
  NormalizedTransaction,
  "txn_date" | "amount_cents" | "currency" | "source_account_id" | "merchant_norm" | "description"
>;

export type OverlapAction = "match-existing" | "keep-as-new";
export type OverlapDecisions = Record<string, OverlapAction>;

export interface ExistingSourceLessTransaction extends SourceLessIdentity {
  id: string;
  content_hash: string;
  source_transaction_id: string | null;
  import_job_id: string | null;
}

export interface OverlapCandidate {
  key: string;
  date: string;
  amount_cents: number;
  currency: string;
  merchant: string | null;
  existingCount: number;
}

export class OverlapReviewRequiredError extends Error {
  constructor(readonly candidates: OverlapCandidate[]) {
    super("Review possible overlaps with previously imported transactions before committing this file.");
    this.name = "OverlapReviewRequiredError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function identityKey(userId: string, transaction: SourceLessIdentity): string {
  return JSON.stringify([
    userId,
    transaction.txn_date,
    transaction.amount_cents,
    transaction.currency,
    transaction.source_account_id ?? "",
    transaction.merchant_norm ?? "",
    transaction.description ?? "",
  ]);
}

export function sourceLessIdentityHash(userId: string, transaction: SourceLessIdentity): string {
  return digest(identityKey(userId, transaction));
}

export function occurrenceContentHash(identityHash: string, occurrence: number): string {
  return digest(`${identityHash}|occurrence:${occurrence}`);
}

/** Stable identity for provider-supplied IDs; source-less hashes identify an occurrence. */
export function contentHash(userId: string, txn: NormalizedTransaction): string {
  if (!txn.source_transaction_id) {
    return occurrenceContentHash(sourceLessIdentityHash(userId, txn), 0);
  }
  return digest([
    userId,
    txn.source_account_id ?? "",
    txn.currency,
    "source-id",
    txn.source_transaction_id,
  ].join("|"));
}

/**
 * Assign deterministic occurrence hashes within a file. Identical source-less
 * purchases retain multiplicity; overlap with prior imports is resolved later.
 */
export function dedupeInBatch(
  userId: string,
  txns: NormalizedTransaction[],
): {
  rows: (NormalizedTransaction & { content_hash: string })[];
  inFileDuplicates: number;
  possibleDuplicates: number;
} {
  const seenSourceIds = new Set<string>();
  const occurrences = new Map<string, number>();
  const rows: (NormalizedTransaction & { content_hash: string })[] = [];
  let inFileDuplicates = 0;
  let possibleDuplicates = 0;

  for (const txn of txns) {
    if (txn.source_transaction_id) {
      const hash = contentHash(userId, txn);
      if (seenSourceIds.has(hash)) {
        inFileDuplicates++;
        continue;
      }
      seenSourceIds.add(hash);
      rows.push({ ...txn, content_hash: hash });
      continue;
    }

    const identity = sourceLessIdentityHash(userId, txn);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    if (occurrence > 0) possibleDuplicates++;
    rows.push({ ...txn, content_hash: occurrenceContentHash(identity, occurrence) });
  }

  return { rows, inFileDuplicates, possibleDuplicates };
}

export function resolveImportOverlaps(args: {
  userId: string;
  transactions: NormalizedTransaction[];
  existing: ExistingSourceLessTransaction[];
  decisions?: OverlapDecisions;
  retryJobId?: string | null;
}) {
  const groups = new Map<string, { identity: string; transactions: { txn: NormalizedTransaction; index: number }[] }>();
  const sourceRows: { txn: NormalizedTransaction; index: number; content_hash: string }[] = [];
  const seenSourceIds = new Set<string>();
  let inFileDuplicates = 0;
  let possibleDuplicates = 0;

  args.transactions.forEach((txn, index) => {
    if (txn.source_transaction_id) {
      const hash = contentHash(args.userId, txn);
      if (seenSourceIds.has(hash)) {
        inFileDuplicates++;
      } else {
        seenSourceIds.add(hash);
        sourceRows.push({ txn, index, content_hash: hash });
      }
      return;
    }

    const key = identityKey(args.userId, txn);
    const group = groups.get(key) ?? { identity: sourceLessIdentityHash(args.userId, txn), transactions: [] };
    if (group.transactions.length > 0) possibleDuplicates++;
    group.transactions.push({ txn, index });
    groups.set(key, group);
  });

  const existingByKey = new Map<string, ExistingSourceLessTransaction[]>();
  for (const row of args.existing) {
    if (row.source_transaction_id) continue;
    const key = identityKey(args.userId, row);
    existingByKey.set(key, [...(existingByKey.get(key) ?? []), row]);
  }

  const candidates: OverlapCandidate[] = [];
  const expectedDecisionKeys = new Set<string>();
  const resolvedRows = [...sourceRows];
  let matchedExisting = 0;
  const decisions = args.decisions ?? {};

  for (const [key, group] of groups) {
    const allExisting = existingByKey.get(key) ?? [];
    const retryRows = args.retryJobId
      ? allExisting.filter((row) => row.import_job_id === args.retryJobId)
      : [];
    const externalExisting = allExisting.filter((row) => row.import_job_id !== args.retryJobId);
    const usedRetryRows = new Set<string>();
    let keptNew = 0;
    let externalOccurrence = 0;

    for (const { txn, index } of group.transactions) {
      const retryMatch = retryRows.find((row) => !usedRetryRows.has(row.id));
      if (retryMatch) {
        usedRetryRows.add(retryMatch.id);
        matchedExisting++;
        expectedDecisionKeys.add(`${group.identity}:${index}`);
        continue;
      }

      const candidate = externalExisting[externalOccurrence];
      if (candidate) {
        const choiceKey = `${group.identity}:${index}`;
        expectedDecisionKeys.add(choiceKey);
        const action = decisions[choiceKey];
        if (!action) {
          candidates.push({
            key: choiceKey,
            date: txn.txn_date,
            amount_cents: txn.amount_cents,
            currency: txn.currency,
            merchant: txn.merchant_norm,
            existingCount: externalExisting.length,
          });
          externalOccurrence++;
          continue;
        }
        if (action === "match-existing") {
          matchedExisting++;
          externalOccurrence++;
          continue;
        }
        if (action !== "keep-as-new") {
          throw new Error(`Invalid overlap choice for ${choiceKey}`);
        }
        externalOccurrence++;
      }

      const occurrence = allExisting.length + keptNew;
      keptNew++;
      resolvedRows.push({
        txn,
        index,
        content_hash: occurrenceContentHash(group.identity, occurrence),
      });
    }
  }

  for (const key of Object.keys(decisions)) {
    if (!expectedDecisionKeys.has(key)) {
      throw new Error("Overlap choices do not match the current import preview; review the file again.");
    }
  }
  if (candidates.length > 0) throw new OverlapReviewRequiredError(candidates);

  return {
    rows: resolvedRows.sort((a, b) => a.index - b.index).map(({ txn, content_hash }) => ({ ...txn, content_hash })),
    inFileDuplicates,
    possibleDuplicates,
    matchedExisting,
    decisions,
  };
}
