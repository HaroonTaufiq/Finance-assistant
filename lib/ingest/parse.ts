import Papa from "papaparse";
import {
  NormalizedTransaction,
  SupportedCurrency as SupportedCurrencySchema,
  type TransactionSource,
  type RawCsvRow,
  type DateOrder,
  type SupportedCurrency,
  type TransactionKind,
  coerceAmountToCents,
  coerceDate,
  normalizeMerchant,
} from "@/lib/contracts";

/**
 * CSV parsing + per-row normalization (PRD-A2). Tolerant of odd delimiters and
 * quoting (papaparse) and flexible about headers (banks all differ). Rows that
 * fail validation are returned as errors for quarantine — never dropped (SPEC §9).
 */

export type ParsedRow =
  | { ok: true; txn: NormalizedTransaction }
  | { ok: false; raw: RawCsvRow; reason: string };

export interface ParseResult {
  valid: NormalizedTransaction[];
  errors: { raw: RawCsvRow; reason: string }[];
  totalRows: number;
}

// Header synonyms, matched case-insensitively after trimming.
const FIELD_SYNONYMS = {
  date: ["date", "txn_date", "transaction date", "posted", "posted date", "post date"],
  amount: ["amount", "amt", "value"],
  debit: ["debit", "withdrawal", "withdrawals", "money out", "paid out"],
  credit: ["credit", "deposit", "deposits", "money in", "paid in"],
  description: ["description", "memo", "narrative", "details", "notes", "reference"],
  merchant: ["merchant", "payee", "vendor", "name", "to"],
  category: ["category", "cat"],
  currency: ["currency", "ccy"],
  transactionKind: ["kind", "type", "transaction kind", "transaction_kind", "transaction type"],
  account: ["account", "account id", "account_id", "source account"],
  transactionId: ["transaction id", "transaction_id", "bank transaction id", "external id"],
} as const;

export type CsvColumnField = keyof typeof FIELD_SYNONYMS;
export type CsvColumnMapping = Partial<Record<CsvColumnField, string>>;
type ColumnMap = CsvColumnMapping;
export type ParseOptions = {
  defaultCurrency?: SupportedCurrency;
  dateOrder?: DateOrder | null;
  columnMapping?: CsvColumnMapping;
};

function detectColumns(headers: string[], overrides: CsvColumnMapping = {}): ColumnMap {
  const map: ColumnMap = {};
  const lower = headers.map((h) => ({ original: h, norm: h.trim().toLowerCase() }));
  for (const field of Object.keys(FIELD_SYNONYMS) as CsvColumnField[]) {
    const synonyms = FIELD_SYNONYMS[field];
    const hit = lower.find((h) => synonyms.includes(h.norm as never));
    if (hit) map[field] = hit.original;
    const override = overrides[field];
    if (override && headers.includes(override)) map[field] = override;
  }
  return map;
}

function pick(row: RawCsvRow, col: string | undefined): string | null {
  if (!col) return null;
  const v = row[col];
  return v == null || v.trim() === "" ? null : v.trim();
}

/** Normalize one raw CSV row into a validated transaction, or an error reason. */
export function normalizeRow(
  row: RawCsvRow,
  cols: ColumnMap,
  source: TransactionSource,
  options: ParseOptions = {},
): ParsedRow {
  const dateOrder = options.dateOrder === undefined ? "MDY" : options.dateOrder;
  const txn_date = coerceDate(pick(row, cols.date), dateOrder);
  if (!txn_date) {
    return { ok: false, raw: row, reason: "missing or unparseable date" };
  }

  // Amount: a single signed column, or separate debit/credit columns.
  let amount_cents: number | null = null;
  if (cols.amount) {
    amount_cents = coerceAmountToCents(pick(row, cols.amount));
  } else if (cols.debit || cols.credit) {
    const debit = coerceAmountToCents(pick(row, cols.debit));
    const credit = coerceAmountToCents(pick(row, cols.credit));
    if (debit != null || credit != null) {
      amount_cents = (credit ?? 0) - Math.abs(debit ?? 0);
    }
  }
  if (amount_cents == null) {
    return { ok: false, raw: row, reason: "missing or unparseable amount" };
  }

  const merchant_raw = pick(row, cols.merchant) ?? pick(row, cols.description);
  const rawKind = pick(row, cols.transactionKind)?.toLowerCase();
  const rawCategory = (pick(row, cols.category) ?? "uncategorized").toLowerCase();
  const categoryKind =
    rawCategory === "income" || rawCategory === "refund"
      ? rawCategory
      : rawCategory === "transfer" || rawCategory === "transfers"
        ? "transfer"
        : null;
  const kindAliases: Record<string, TransactionKind> = {
    expense: "expense",
    debit: "expense",
    refund: "refund",
    income: "income",
    transfer: "transfer",
    transfers: "transfer",
    unknown: "unknown",
  };
  const explicitKind = rawKind ? kindAliases[rawKind] : undefined;
  const inferredKind = explicitKind ?? categoryKind ?? (amount_cents < 0 ? "expense" : "unknown");
  if (
    (amount_cents < 0 && (inferredKind === "refund" || inferredKind === "income")) ||
    (amount_cents > 0 && inferredKind === "expense")
  ) {
    return {
      ok: false,
      raw: row,
      reason: `transaction kind "${inferredKind}" conflicts with the amount sign; review the row's kind and amount`,
    };
  }
  const currency = pick(row, cols.currency)?.toUpperCase() ?? options.defaultCurrency ?? "USD";
  const validatedCurrency = SupportedCurrencySchema.safeParse(currency);
  if (!validatedCurrency.success) {
    return { ok: false, raw: row, reason: "unsupported currency" };
  }
  const candidate = {
    txn_date,
    amount_cents,
    currency: validatedCurrency.data,
    transaction_kind: inferredKind,
    merchant_raw,
    merchant_norm: normalizeMerchant(merchant_raw),
    category: rawCategory,
    description: pick(row, cols.description),
    source_account_id: pick(row, cols.account),
    source_transaction_id: pick(row, cols.transactionId),
    source,
    metadata: {},
  };

  const parsed = NormalizedTransaction.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, raw: row, reason: parsed.error.issues[0]?.message ?? "invalid row" };
  }
  return { ok: true, txn: parsed.data };
}

/** Parse a full CSV string into validated transactions + quarantined errors. */
export function parseTransactions(
  csv: string,
  source: TransactionSource = "csv",
  options: ParseOptions = {},
): ParseResult {
  const result = Papa.parse<RawCsvRow>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });

  const headers = result.meta.fields ?? [];
  const cols = detectColumns(headers, options.columnMapping);

  const valid: NormalizedTransaction[] = [];
  const errors: { raw: RawCsvRow; reason: string }[] = [];

  // If we can't find the essential columns, every row will fail; say why once.
  if (!cols.date || (!cols.amount && !cols.debit && !cols.credit)) {
    for (const raw of result.data) {
      errors.push({ raw, reason: "could not detect date/amount columns in header" });
    }
    return { valid, errors, totalRows: result.data.length };
  }

  for (const raw of result.data) {
    const out = normalizeRow(raw, cols, source, options);
    if (out.ok) valid.push(out.txn);
    else errors.push({ raw: out.raw, reason: out.reason });
  }

  return { valid, errors, totalRows: result.data.length };
}
