import "server-only";
import { createHash } from "node:crypto";
import { getServerClient } from "@/lib/db/client";
import { runBatchForUser } from "@/lib/batch";
import {
  type DateOrder,
  type IngestSummary,
  type SupportedCurrency,
  type TransactionSource,
} from "@/lib/contracts";
import { MAX_CSV_BYTES, MAX_CSV_ROWS } from "@/lib/limits";
import { parseTransactions } from "./parse";
import type { CsvColumnMapping } from "./parse";
import { dedupeInBatch } from "./dedup";

/**
 * Orchestrates the write path (PRD-A2): parse → validate → dedup → insert
 * (idempotent) → quarantine errors → trigger batch precompute. Returns an
 * honest import summary; bad rows are quarantined, never dropped (SPEC §6, §9).
 */
export async function ingestCsv(args: {
  userId: string;
  csv: string;
  currency: SupportedCurrency;
  dateOrder: DateOrder;
  coverageConfirmed: boolean;
  columnMapping?: CsvColumnMapping;
  source?: TransactionSource;
}): Promise<IngestSummary> {
  const { userId, csv, currency, dateOrder, coverageConfirmed, columnMapping, source = "csv" } = args;
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) {
    throw new Error(`CSV exceeds the ${MAX_CSV_BYTES}-byte limit`);
  }
  const supabase = await getServerClient();

  const { valid, errors, totalRows } = parseTransactions(csv, source, {
    defaultCurrency: currency,
    dateOrder,
    columnMapping,
  });
  if (totalRows > MAX_CSV_ROWS) {
    throw new Error(`CSV exceeds the ${MAX_CSV_ROWS}-row limit`);
  }
  if (errors.some((row) => row.reason === "unsupported currency")) {
    throw new Error("CSV contains a currency outside the supported USD, PKR, EUR, and GBP set");
  }
  const currencies = new Set(valid.map((row) => row.currency));
  if (currencies.size > 1 || (currencies.size === 1 && !currencies.has(currency))) {
    throw new Error("CSV currency must match the one selected for this dataset");
  }

  const { data: settings, error: settingsError } = await supabase
    .from("financial_settings")
    .select("currency")
    .eq("user_id", userId)
    .maybeSingle();
  if (settingsError) throw new Error(`dataset currency lookup failed: ${settingsError.message}`);
  const configuredCurrency = (settings as { currency: string } | null)?.currency;
  if (configuredCurrency && configuredCurrency !== currency) {
    throw new Error(`This dataset uses ${configuredCurrency}; imports in ${currency} are not supported`);
  }
  if (!configuredCurrency) {
    const { error } = await supabase
      .from("financial_settings")
      .insert({ user_id: userId, currency });
    if (error) throw new Error(`dataset currency setup failed: ${error.message}`);
  }

  const importFingerprint = createHash("sha256").update(csv).digest("hex");
  const transactionDates = valid.map((row) => row.txn_date).sort();
  const { rows, inFileDuplicates, possibleDuplicates } = dedupeInBatch(
    userId,
    valid,
    importFingerprint,
  );

  const affectedMonths = [...new Set(valid.map((row) => `${row.txn_date.slice(0, 7)}-01`))];
  let importJobId: string | null = null;
  if (valid.length > 0) {
    const { data, error } = await supabase
      .from("import_jobs")
      .upsert(
        {
          user_id: userId,
          file_fingerprint: importFingerprint,
          status: "processing",
          affected_months: affectedMonths,
          row_count: valid.length,
          coverage_start: transactionDates[0],
          coverage_end: transactionDates[transactionDates.length - 1],
          coverage_confirmed: coverageConfirmed && errors.length === 0,
          error_code: null,
          completed_at: null,
        },
        { onConflict: "user_id,file_fingerprint" },
      )
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`import job setup failed: ${error?.message ?? "missing job id"}`);
    }
    if (typeof data.id !== "string") {
      throw new Error("import job setup failed: database did not return a job id");
    }
    importJobId = data.id;
  }

  let imported = 0;
  try {
    if (rows.length > 0) {
      const payload = rows.map((row) => ({
        ...row,
        user_id: userId,
        import_job_id: importJobId,
      }));
      const { data, error } = await supabase
        .from("transactions")
        .upsert(payload, { onConflict: "user_id,content_hash", ignoreDuplicates: true })
        .select("txn_date");
      if (error) throw new Error(`transaction insert failed: ${error.message}`);
      imported = data?.length ?? 0;
    }

    if (errors.length > 0) {
      const { error } = await supabase.from("ingest_errors").insert(
        errors.map((e) => ({ user_id: userId, raw_row: e.raw, reason: e.reason })),
      );
      if (error) throw new Error(`quarantine insert failed: ${error.message}`);
    }

    if (valid.length > 0) {
      const { data: incompleteJobs, error: jobsError } = await supabase
        .from("import_jobs")
        .select("id, affected_months")
        .eq("user_id", userId)
        .neq("status", "complete");
      if (jobsError) throw new Error(`import recovery lookup failed: ${jobsError.message}`);

      const recoveryMonths = new Set(affectedMonths);
      for (const job of (incompleteJobs as { affected_months: string[] }[] | null) ?? []) {
        for (const month of job.affected_months) recoveryMonths.add(month);
      }

      await runBatchForUser(userId, { affectedMonths: [...recoveryMonths] });
      const { error: completionError } = await supabase
        .from("import_jobs")
        .update({ status: "complete", error_code: null, completed_at: new Date().toISOString() })
        .eq("user_id", userId)
        .neq("status", "complete");
      if (completionError) {
        throw new Error(`derived report completion failed: ${completionError.message}`);
      }
    }
  } catch (error) {
    if (valid.length > 0) {
      const { error: recoveryError } = await supabase
        .from("import_jobs")
        .update({ status: "failed", error_code: "IMPORT_OR_DERIVATION_FAILED" })
        .eq("user_id", userId)
        .neq("status", "complete");
      if (recoveryError) {
        throw new Error(
          `Import failed and recovery state could not be recorded: ${recoveryError.message}`,
          { cause: error },
        );
      }
    }
    throw error;
  }

  const existingDuplicates = rows.length - imported;

  // Aggregate skip reasons for the summary card.
  const reasonCounts = new Map<string, number>();
  for (const e of errors) {
    reasonCounts.set(e.reason, (reasonCounts.get(e.reason) ?? 0) + 1);
  }

  return {
    imported,
    skipped: errors.length,
    duplicates: inFileDuplicates + existingDuplicates,
    possibleDuplicates,
    reasons: [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })),
  };
}
