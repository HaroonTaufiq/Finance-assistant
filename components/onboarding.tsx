"use client";

import { useState, useRef } from "react";
import { Upload } from "lucide-react";
import Link from "next/link";
import Papa from "papaparse";
import type { DateOrder, IngestSummary, SupportedCurrency } from "@/lib/contracts";
import { parseTransactions, type CsvColumnField, type CsvColumnMapping } from "@/lib/ingest/parse";
import { countImportOverlaps } from "@/lib/ingest/preview";
import { recordAnalyticsEvent } from "@/lib/analytics/client";
import { MAX_CSV_BYTES, MAX_CSV_ROWS, formatBytes } from "@/lib/limits";
import { cn } from "@/lib/utils";

const EXAMPLES = [
  "How much did I spend on groceries last month?",
  "Find my subscriptions",
  "Am I spending more than usual?",
];

const COLUMN_FIELDS: { field: CsvColumnField; label: string }[] = [
  { field: "date", label: "Date" },
  { field: "amount", label: "Signed amount" },
  { field: "debit", label: "Debit" },
  { field: "credit", label: "Credit" },
  { field: "merchant", label: "Merchant / payee" },
  { field: "description", label: "Description" },
  { field: "category", label: "Category" },
  { field: "currency", label: "Row currency" },
  { field: "transactionKind", label: "Transaction kind" },
  { field: "account", label: "Source account" },
  { field: "transactionId", label: "Source transaction ID" },
];

type ImportPreview = {
  headers: string[];
  rows: string[][];
  analysis: ReturnType<typeof parseTransactions> | null;
  duplicates: { duplicateSourceIds: number; possibleDuplicates: number };
  observedFrom: string | null;
  observedTo: string | null;
};

function makePreview(
  csv: string,
  headers: string[],
  currency: SupportedCurrency | "",
  dateOrder: DateOrder | "",
  columnMapping: CsvColumnMapping,
): ImportPreview {
  const analysis =
    currency && dateOrder
      ? parseTransactions(csv, "csv", {
          defaultCurrency: currency,
          dateOrder,
          columnMapping,
        })
      : null;
  const dates = analysis?.valid.map((row) => row.txn_date).sort() ?? [];
  return {
    headers,
    rows: Papa.parse<Record<string, string>>(csv, {
      header: true,
      skipEmptyLines: "greedy",
      preview: 6,
      transformHeader: (header) => header.trim(),
    }).data.map((row) => headers.map((header) => row[header] ?? "")),
    analysis,
    duplicates: analysis
      ? countImportOverlaps(analysis.valid)
      : { duplicateSourceIds: 0, possibleDuplicates: 0 },
    observedFrom: dates[0] ?? null,
    observedTo: dates[dates.length - 1] ?? null,
  };
}

/**
 * Empty/onboarding state (UI_SPEC §4.4): welcome + CSV dropzone + example
 * prompts. On a successful import it hands the summary back to the chat shell.
 */
export function Onboarding({
  onUploaded,
  onExample,
}: {
  onUploaded: (summary: IngestSummary) => void;
  onExample: (text: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState("");
  const [currency, setCurrency] = useState<SupportedCurrency | "">("");
  const [dateOrder, setDateOrder] = useState<DateOrder | "">("");
  const [coverageConfirmed, setCoverageConfirmed] = useState(false);
  const [columnMapping, setColumnMapping] = useState<CsvColumnMapping>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const analysisErrors = preview?.analysis?.errors ?? [];

  async function chooseFile(nextFile: File) {
    setError(null);
    setCoverageConfirmed(false);
    if (nextFile.size > MAX_CSV_BYTES) {
      setError(`That file is too large (max ${formatBytes(MAX_CSV_BYTES)}).`);
      return;
    }
    const text = await nextFile.text();
    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (header) => header.trim(),
    });
    const headers = parsed.meta.fields ?? [];
    if (headers.length === 0 || parsed.errors.length > 0) {
      setError("This CSV could not be previewed. Check its header row and quoting, then try again.");
      return;
    }
    setFile(nextFile);
    setCsvText(text);
    setColumnMapping({});
    setPreview(makePreview(text, headers, currency, dateOrder, {}));
  }

  async function upload() {
    if (!file || !currency || !dateOrder || !preview?.analysis) return;
    const rowCurrencies = new Set(preview.analysis.valid.map((row) => row.currency));
    if (
      preview.analysis.valid.length === 0 ||
      preview.analysis.totalRows > MAX_CSV_ROWS ||
      rowCurrencies.size > 1 ||
      (rowCurrencies.size === 1 && !rowCurrencies.has(currency))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const startedAt = performance.now();
    const eventKey = `import:${crypto.randomUUID()}`;
    void recordAnalyticsEvent({ eventKey, eventName: "import_started", mode: "personal" });
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("currency", currency);
      form.append("dateOrder", dateOrder);
      form.append("coverageConfirmed", String(coverageConfirmed));
      form.append("columnMapping", JSON.stringify(columnMapping));
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Import failed");
      void recordAnalyticsEvent({
        eventKey: `${eventKey}:success`,
        eventName: "import_succeeded",
        mode: "personal",
        durationMs: Math.round(performance.now() - startedAt),
      });
      onUploaded(json as IngestSummary);
    } catch (e) {
      void recordAnalyticsEvent({
        eventKey: `${eventKey}:failure`,
        eventName: "import_failed",
        mode: "personal",
        durationMs: Math.round(performance.now() - startedAt),
        errorCode: "unknown",
      });
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center">
      <h2 className="font-display text-2xl font-semibold">Welcome.</h2>
      <p className="mt-2 text-text-muted">
        Upload your transactions to get started, then ask me anything about your money.
      </p>
      <Link href="/sample" className="mt-4 text-sm text-accent underline">
        Try a synthetic monthly review first
      </Link>
      <p className="mt-4 max-w-md text-left text-xs leading-relaxed text-text-muted">
        Your CSV is stored with your Finance Assistant account and used for deterministic reports.
        The CSV and free-text descriptions are not sent to chat models by default. If you ask about
        specific transactions, selected dates, merchant labels, categories, amounts and currencies
        may be sent to the configured AI provider. Merchant lookup and receipt extraction disclose
        the selected merchant or attached receipt to their configured providers when you request
        those features. Export or delete data from the report; deletion keeps your sign-in account
        and may not immediately remove provider backups.
      </p>

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void chooseFile(f);
        }}
        className={cn(
          "mt-8 flex w-full cursor-pointer flex-col items-center gap-2 rounded border border-dashed border-border bg-surface px-6 py-10 transition-colors",
          dragOver && "border-accent bg-[color:var(--accent-soft)]",
        )}
      >
        <Upload className="h-6 w-6 text-text-faint" />
        <span className="text-sm font-medium">
          {file ? file.name : "Choose transactions (CSV)"}
        </span>
        <span className="text-xs text-text-faint">Drag & drop or click to choose a file</span>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void chooseFile(f);
          }}
        />
      </label>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      {preview && file && (
        <section className="mt-5 w-full rounded border border-border bg-surface p-4 text-left">
          <h3 className="text-sm font-medium">Review before importing</h3>
          <p className="mt-1 text-xs text-text-muted">
            This full-file preview runs locally. Only after confirmation is the CSV sent to your account.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-text-muted">
              Currency
              <select
                value={currency}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "USD" || value === "PKR" || value === "EUR" || value === "GBP") {
                    setCurrency(value);
                    setPreview(makePreview(csvText, preview.headers, value, dateOrder, columnMapping));
                  }
                }}
                className="mt-1 block w-full rounded border border-border bg-bg px-2 py-2 text-sm text-text"
              >
                <option value="">Choose dataset currency</option>
                <option value="USD">USD</option>
                <option value="PKR">PKR</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </select>
            </label>
            <label className="text-xs text-text-muted">
              Date order for ambiguous dates
              <select
                value={dateOrder}
                onChange={(event) => {
                  if (event.target.value === "MDY" || event.target.value === "DMY") {
                    setDateOrder(event.target.value);
                    setPreview(makePreview(csvText, preview.headers, currency, event.target.value, columnMapping));
                  }
                }}
                className="mt-1 block w-full rounded border border-border bg-bg px-2 py-2 text-sm text-text"
              >
                <option value="">Choose date interpretation</option>
                <option value="MDY">Month / day / year</option>
                <option value="DMY">Day / month / year</option>
              </select>
            </label>
          </div>
          <p className="mt-3 text-xs text-text-muted">
            Signed amounts: negative values are outflows; positive values require refund, income,
            transfer or unknown classification. Debit values are treated as outflows and credit
            values as inflows.
          </p>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-accent">Column mapping (optional)</summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {COLUMN_FIELDS.map(({ field, label }) => (
                <label key={field} className="text-xs text-text-muted">
                  {label}
                  <select
                    value={columnMapping[field] ?? ""}
                    onChange={(event) => {
                      const nextMapping = { ...columnMapping, [field]: event.target.value };
                      if (!event.target.value) delete nextMapping[field];
                      setColumnMapping(nextMapping);
                      setPreview(makePreview(csvText, preview.headers, currency, dateOrder, nextMapping));
                    }}
                    className="mt-1 block w-full rounded border border-border bg-bg px-2 py-2 text-sm text-text"
                  >
                    <option value="">Auto-detect</option>
                    {preview.headers.map((header) => (
                      <option key={header} value={header}>{header}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </details>
          <div className="mt-3 rounded bg-bg p-3 text-xs text-text-muted" aria-live="polite">
            {!currency || !dateOrder ? (
              <p>Choose the dataset currency and date interpretation to calculate the preview.</p>
            ) : preview.analysis ? (
              <>
                <p>
                  {preview.analysis.totalRows} rows · {preview.analysis.valid.length} valid ·
                  {" "}{preview.analysis.errors.length} invalid/quarantined ·
                  {" "}{preview.duplicates.duplicateSourceIds} repeated source IDs ·
                  {" "}{preview.duplicates.possibleDuplicates} identical rows kept for review
                </p>
                <p className="mt-1">
                  Observed dates: {preview.observedFrom ?? "none"} to {preview.observedTo ?? "none"}.
                  {preview.analysis.totalRows > MAX_CSV_ROWS
                    ? ` Limit is ${MAX_CSV_ROWS.toLocaleString()} data rows.`
                    : ""}
                </p>
                {analysisErrors.length > 0 && (
                  <ul className="mt-2 list-disc pl-5">
                    {[...new Set(analysisErrors.map((row) => row.reason))].map((reason) => (
                      <li key={reason}>{reason}: {analysisErrors.filter((row) => row.reason === reason).length}</li>
                    ))}
                  </ul>
                )}
                {new Set(preview.analysis.valid.map((row) => row.currency)).size > 1 && (
                  <p className="mt-2 text-danger">Mixed currencies are not supported in one dataset.</p>
                )}
                {preview.analysis.valid.some((row) => row.currency !== currency) && (
                  <p className="mt-2 text-danger">A row currency does not match the selected dataset currency.</p>
                )}
              </>
            ) : null}
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr>
                  {preview.headers.map((header) => (
                    <th className="p-2 text-left" key={header}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, rowIndex) => (
                  <tr className="border-t border-border" key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td className="p-2" key={cellIndex}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="mt-3 flex items-start gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={coverageConfirmed}
              disabled={!preview.analysis || (preview.analysis?.errors.length ?? 0) > 0}
              onChange={(event) => setCoverageConfirmed(event.target.checked)}
            />
            <span>
              I confirm this export contains all transactions for its observed date range. This
              does not claim coverage outside that range. Invalid rows prevent full-month coverage.
            </span>
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={
                busy ||
                !currency ||
                !dateOrder ||
                !preview.analysis ||
                preview.analysis.valid.length === 0 ||
                preview.analysis.totalRows > MAX_CSV_ROWS ||
                new Set(preview.analysis.valid.map((row) => row.currency)).size > 1 ||
                preview.analysis.valid.some((row) => row.currency !== currency)
              }
              onClick={() => void upload()}
              className="rounded bg-accent px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              {busy ? "Importing…" : `Confirm import in ${currency}`}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setFile(null);
                setPreview(null);
                setCsvText("");
                setColumnMapping({});
                setCoverageConfirmed(false);
                setCurrency("");
                setDateOrder("");
              }}
              className="rounded border border-border px-3 py-2 text-sm text-text-muted"
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      <div className="mt-8 flex flex-wrap justify-center gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => onExample(ex)}
            className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-text-muted transition-colors hover:border-accent hover:text-text"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}
