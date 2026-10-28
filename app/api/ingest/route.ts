import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/db/client";
import { ingestCsv } from "@/lib/ingest/pipeline";
import { MAX_CSV_BYTES, formatBytes } from "@/lib/limits";
import { ImportOverlapDecision, SupportedCurrency as SupportedCurrencySchema } from "@/lib/contracts";
import type { CsvColumnField, CsvColumnMapping } from "@/lib/ingest/parse";
import { OverlapReviewRequiredError } from "@/lib/ingest/dedup";
import { UserWriteLockBusyError } from "@/lib/db/user-write-lock";

export const runtime = "nodejs"; // pipeline uses node:crypto + service code
export const maxDuration = 60;

/**
 * POST /api/ingest — multipart upload of a transactions CSV.
 * Returns IngestSummary { imported, skipped, duplicates, reasons } (SPEC §6).
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let csv: string;
  let currency: string | null;
  let dateOrder: string | null;
  let coverageConfirmed: boolean;
  let columnMappingInput: string | null;
  let overlapDecisionsInput: string | null;
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "no file provided" }, { status: 400 });
      }
      csv = await file.text();
      currency = form.get("currency")?.toString() ?? null;
      dateOrder = form.get("dateOrder")?.toString() ?? null;
      coverageConfirmed = form.get("coverageConfirmed") === "true";
      columnMappingInput = form.get("columnMapping")?.toString() ?? null;
      overlapDecisionsInput = form.get("overlapDecisions")?.toString() ?? null;
    } else {
      // Allow a raw text/csv body too (handy for the mock-bank path / tests).
      csv = await request.text();
      currency = request.headers.get("x-finance-currency");
      dateOrder = request.headers.get("x-finance-date-order");
      coverageConfirmed = request.headers.get("x-finance-coverage-confirmed") === "true";
      columnMappingInput = request.headers.get("x-finance-column-mapping");
      overlapDecisionsInput = request.headers.get("x-finance-overlap-decisions");
    }
  } catch {
    return NextResponse.json({ error: "could not read upload" }, { status: 400 });
  }

  if (!csv.trim()) {
    return NextResponse.json({ error: "empty file" }, { status: 400 });
  }
  let columnMapping: CsvColumnMapping | undefined;
  try {
    columnMapping = parseColumnMapping(columnMappingInput);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "invalid column mapping" },
      { status: 400 },
    );
  }
  let overlapDecisions: Record<string, "match-existing" | "keep-as-new"> | undefined;
  try {
    overlapDecisions = parseOverlapDecisions(overlapDecisionsInput);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "invalid overlap decisions" },
      { status: 400 },
    );
  }

  const parsedCurrency = SupportedCurrencySchema.safeParse(currency);
  if (!parsedCurrency.success) {
    return NextResponse.json({ error: "Choose a supported currency before importing" }, { status: 400 });
  }
  if (dateOrder !== "MDY" && dateOrder !== "DMY") {
    return NextResponse.json({ error: "Choose the date order shown by your CSV before importing" }, { status: 400 });
  }

  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) {
    return NextResponse.json(
      { error: `CSV exceeds the ${formatBytes(MAX_CSV_BYTES)} limit` },
      { status: 413 },
    );
  }

  try {
    const summary = await ingestCsv({
      userId: user.id,
      csv,
      currency: parsedCurrency.data,
      dateOrder,
      coverageConfirmed,
      columnMapping,
      overlapDecisions,
    });
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "ingest failed";
    if (err instanceof OverlapReviewRequiredError) {
      return NextResponse.json({
        error: err.message,
        overlapReview: err.candidates,
      }, { status: 409 });
    }
    const status = err instanceof UserWriteLockBusyError
      ? 409
      : message.startsWith("Overlap choices")
        ? 400
      : message.startsWith("CSV exceeds")
        ? 413
        : message.includes("currency")
          ? 422
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

function parseOverlapDecisions(
  value: string | null,
): Record<string, "match-existing" | "keep-as-new"> | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Overlap decisions must be valid JSON");
  }
  const result = z.record(z.string().min(1), ImportOverlapDecision).safeParse(parsed);
  if (!result.success) {
    throw new Error("Overlap decisions must map each review item to a supported choice");
  }
  return result.data;
}

function parseColumnMapping(value: string | null): CsvColumnMapping | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Column mapping must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Column mapping must be an object");
  }

  const fields: CsvColumnField[] = [
    "date",
    "amount",
    "debit",
    "credit",
    "description",
    "merchant",
    "category",
    "currency",
    "transactionKind",
    "account",
    "transactionId",
  ];
  const mapping: CsvColumnMapping = {};
  for (const [fieldName, header] of Object.entries(parsed)) {
    const field = fields.find((candidate) => candidate === fieldName);
    if (!field || typeof header !== "string") {
      throw new Error("Column mapping contains an unsupported field");
    }
    if (header) mapping[field] = header;
  }
  return mapping;
}
