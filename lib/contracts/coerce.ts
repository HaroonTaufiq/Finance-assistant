/**
 * Shared coercion helpers (PRD-00). Defined once here and consumed by the
 * ingest pipeline (A2) and the receipt flow (C1) so every entry point cleans
 * money/dates/merchants identically. Money is integer minor units (cents);
 * never float (SPEC §4, schema.sql).
 */

/**
 * Parse a raw amount into integer cents, preserving sign.
 *
 * Handles: "$1,234.50" -> 123450, "(45.00)" -> -4500 (accounting parens),
 * "-12.5" -> -1250, "45" -> 4500, 12.5 -> 1250.
 *
 * Returns null when the input has no parseable number, so the caller can
 * quarantine the row rather than silently record a wrong amount (SPEC §9).
 */
export function coerceAmountToCents(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  }

  let s = raw.trim();
  if (s === "") return null;

  // Accounting style: parentheses denote a negative value.
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  // Strip currency symbols, thousands separators, and spaces.
  s = s.replace(/[^0-9.,\-]/g, "");

  // If both separators appear, assume "," is thousands and "." is decimal.
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/,/g, "");
  } else if (s.includes(",") && !s.includes(".")) {
    // "1,50" (decimal comma) vs "1,500" (thousands). Treat a single trailing
    // group of exactly 2 digits as a decimal comma; otherwise thousands.
    s = /,\d{2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }

  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }

  const value = Number.parseFloat(s);
  if (!Number.isFinite(value)) return null;

  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASH_OR_DASH = /^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})$/;
export type DateOrder = "MDY" | "DMY";

/**
 * Coerce a raw date string into ISO `YYYY-MM-DD`, or null when unparseable.
 *
 * Accepts ISO (`2024-03-09`), `MM/DD/YYYY`, `DD-MM-YYYY`, `YYYY/MM/DD`, and
 * 2-digit years. When a slash/dash date is ambiguous it assumes **US MM/DD**
 * unless the first field is > 12 (then DD/MM). Record this assumption in the
 * README per the brief.
 */
export function coerceDate(
  raw: string | null | undefined,
  dateOrder: DateOrder | null = "MDY",
): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s === "") return null;

  const iso = ISO_DATE.exec(s);
  if (iso) return isValidYmd(+iso[1]!, +iso[2]!, +iso[3]!) ? s : null;

  const m = SLASH_OR_DASH.exec(s);
  if (!m) {
    // Last resort: let the JS Date parser try (handles "Mar 9, 2024" etc.).
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : toYmd(d);
  }

  const [, a, b, c] = m as unknown as [string, string, string, string];
  let year: number, month: number, day: number;

  if (a.length === 4) {
    // YYYY/MM/DD
    year = +a;
    month = +b;
    day = +c;
  } else {
    // (MM or DD)/(DD or MM)/(YY or YYYY)
    year = normalizeYear(+c);
    const first = +a;
    const second = +b;
    if (first > 12 && second <= 12) {
      day = first;
      month = second;
    } else if (first <= 12 && second <= 12) {
      if (!dateOrder) return null;
      month = dateOrder === "MDY" ? first : second;
      day = dateOrder === "MDY" ? second : first;
    } else {
      month = first;
      day = second;
    }
  }

  return isValidYmd(year, month, day)
    ? `${pad4(year)}-${pad2(month)}-${pad2(day)}`
    : null;
}

/**
 * Normalize a merchant string for grouping/matching: uppercase, collapse
 * whitespace, and strip common card-network/POS prefixes and trailing
 * store numbers so "SQ *Blue Bottle #123" and "BLUE BOTTLE" cluster together.
 */
export function normalizeMerchant(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toUpperCase();
  if (s === "") return null;

  // Drop card-network / POS prefixes: "SQ *", "TST*", "POS ", "PAYPAL *".
  s = s.replace(/^(SQ|TST|SP|PAYPAL|PP|POS|PURCHASE|DEBIT|CREDIT)\s*\*?\s*/u, "");
  // Drop trailing store numbers like "#123" or " 0042".
  s = s.replace(/\s*#?\d{2,}$/u, "");
  // Collapse internal whitespace.
  s = s.replace(/\s+/g, " ").trim();

  return s === "" ? null : s;
}

// ---- internals -------------------------------------------------------------

function normalizeYear(y: number): number {
  if (y >= 100) return y;
  // 2-digit year: 00-69 -> 2000s, 70-99 -> 1900s.
  return y <= 69 ? 2000 + y : 1900 + y;
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function toYmd(d: Date): string {
  return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad4 = (n: number) => String(n).padStart(4, "0");
