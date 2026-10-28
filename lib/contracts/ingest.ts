import { z } from "zod";

/**
 * The result of an ingest run, returned by /api/ingest and rendered as the
 * import-summary card (UI_SPEC §4.5). Skipped rows are surfaced with reasons,
 * never silently dropped (SPEC §9).
 */
export const IngestSummary = z.object({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative().default(0),
  possibleDuplicates: z.number().int().nonnegative().default(0),
  reasons: z.array(
    z.object({
      reason: z.string(),
      count: z.number().int().positive(),
    }),
  ),
});
export type IngestSummary = z.infer<typeof IngestSummary>;

export const ImportOverlapDecision = z.enum(["match-existing", "keep-as-new"]);
export type ImportOverlapDecision = z.infer<typeof ImportOverlapDecision>;

export const ImportOverlapCandidate = z.object({
  key: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount_cents: z.number().int(),
  currency: z.string(),
  merchant: z.string().nullable(),
  existingCount: z.number().int().positive(),
});
export type ImportOverlapCandidate = z.infer<typeof ImportOverlapCandidate>;

/**
 * A raw parsed CSV record before normalization. papaparse yields string→string
 * maps with unknown headers; the pipeline maps these onto NormalizedTransaction
 * using flexible header detection (A2). Kept permissive on purpose.
 */
export const RawCsvRow = z.record(z.string(), z.string().optional());
export type RawCsvRow = z.infer<typeof RawCsvRow>;
