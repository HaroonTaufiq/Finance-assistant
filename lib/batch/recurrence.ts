export interface RecurrenceTransaction {
  id: string;
  merchant_norm: string;
  amount_cents: number;
  currency: string;
  txn_date: string;
}

export interface RecurringCandidate {
  merchant_norm: string;
  cadence_days: number;
  avg_amount_cents: number;
  last_seen: string;
  next_expected: string;
  confidence: number;
  currency: string;
  occurrence_count: number;
  evidence: { transaction_id: string; date: string; amount_cents: number }[];
  uncertainty: "heuristic_pattern_not_verified";
  amount_change_cents: number | null;
}

const CANONICAL_CADENCES = [7, 30, 365];
const MIN_OCCURRENCES = 3;
const MAX_AMOUNT_COEFFICIENT_OF_VARIATION = 0.1;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function nearestCadence(gap: number): { cadence: number; closeness: number } | null {
  let best: { cadence: number; closeness: number } | null = null;
  for (const cadence of CANONICAL_CADENCES) {
    const tolerance = cadence * 0.25;
    const difference = Math.abs(gap - cadence);
    if (difference <= tolerance) {
      const closeness = 1 - difference / tolerance;
      if (!best || closeness > best.closeness) best = { cadence, closeness };
    }
  }
  return best;
}

export function findRecurringCandidates(
  transactions: readonly RecurrenceTransaction[],
): RecurringCandidate[] {
  const groups = new Map<string, RecurrenceTransaction[]>();
  for (const transaction of transactions) {
    const key = `${transaction.currency}|${transaction.merchant_norm}`;
    const group = groups.get(key) ?? [];
    group.push(transaction);
    groups.set(key, group);
  }

  const candidates: RecurringCandidate[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.id.localeCompare(b.id));
    if (group.length < MIN_OCCURRENCES) continue;

    const gaps = group.slice(1).map((transaction, index) =>
      daysBetween(group[index]!.txn_date, transaction.txn_date),
    );
    const match = nearestCadence(median(gaps));
    if (!match) continue;

    const amounts = group.map((transaction) => Math.abs(transaction.amount_cents));
    const average = amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length;
    const variance =
      amounts.reduce((sum, amount) => sum + (amount - average) ** 2, 0) / amounts.length;
    const coefficientOfVariation = average > 0 ? Math.sqrt(variance) / average : 1;
    if (coefficientOfVariation > MAX_AMOUNT_COEFFICIENT_OF_VARIATION) continue;

    const latest = group[group.length - 1]!;
    const nextExpected = new Date(
      Date.parse(latest.txn_date) + match.cadence * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const confidence = Number(
      (
        0.5 * match.closeness +
        0.3 * (1 - coefficientOfVariation / MAX_AMOUNT_COEFFICIENT_OF_VARIATION) +
        0.2 * Math.min(1, group.length / 6)
      ).toFixed(2),
    );
    const previousMedian = median(amounts.slice(0, -1));

    candidates.push({
      merchant_norm: latest.merchant_norm,
      cadence_days: match.cadence,
      avg_amount_cents: Math.round(average),
      last_seen: latest.txn_date,
      next_expected: nextExpected,
      confidence,
      currency: latest.currency,
      occurrence_count: group.length,
      evidence: group.map((transaction) => ({
        transaction_id: transaction.id,
        date: transaction.txn_date,
        amount_cents: Math.abs(transaction.amount_cents),
      })),
      uncertainty: "heuristic_pattern_not_verified",
      amount_change_cents:
        amounts.length > 1 ? amounts[amounts.length - 1]! - previousMedian : null,
    });
  }

  return candidates;
}
