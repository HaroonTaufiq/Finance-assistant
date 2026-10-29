import { z } from "zod";
import { UserMemoryRule, MemoryKind } from "./memory";

/**
 * Tool input/output contracts (PRD-00) for the SPEC §5.1 tool set. Input
 * schemas are passed directly to the AI SDK as tool parameters; output schemas
 * double as the typed payloads the UI result cards receive (UI_SPEC §4.3), so
 * there is no second mapping layer. Every query is bounded (date ranges,
 * limit <= 50) — the scalability guarantee (SPEC §5.1).
 */

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO YYYY-MM-DD");
const Currency = z.string().default("USD");

// ---- getSpending (Tier 0) --------------------------------------------------
export const GetSpendingInput = z.object({
  category: z.string().optional(),
  startDate: IsoDate,
  endDate: IsoDate,
  groupBy: z.enum(["category", "month"]).optional(),
});
export const GetSpendingOutput = z.object({
  total_cents: z.number().int(),
  gross_outflows_cents: z.number().int().default(0),
  refunds_cents: z.number().int().default(0),
  net_spend_cents: z.number().int().default(0),
  total_income_cents: z.number().int().default(0),
  unknown_inflows_cents: z.number().int().default(0),
  currency: z.string().nullable(),
  period: z.object({ start: IsoDate, end: IsoDate }),
  groupBy: z.enum(["category", "month"]).nullable(),
  breakdown: z.array(z.object({ key: z.string(), amount_cents: z.number().int() })),
});

// ---- getTransactions (Tier 0) ----------------------------------------------
export const GetTransactionsInput = z.object({
  filters: z
    .object({
      category: z.string().optional(),
      merchant: z.string().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      startDate: IsoDate.optional(),
      endDate: IsoDate.optional(),
    })
    .default({}),
  sort: z.enum(["date_desc", "date_asc", "amount_desc", "amount_asc"]).default("date_desc"),
  limit: z.number().int().min(1).max(50).default(10),
});
export const TransactionLite = z.object({
  date: IsoDate,
  merchant: z.string().nullable(),
  category: z.string(),
  kind: z.enum(["expense", "refund", "income", "transfer", "unknown"]),
  amount_cents: z.number().int(),
  currency: Currency,
});
export const GetTransactionsOutput = z.object({
  rows: z.array(TransactionLite),
  hasMore: z.boolean(),
});

// ---- getTrend (Tier 1) -----------------------------------------------------
export const GetTrendInput = z.object({
  category: z.string().optional(),
  periods: z.number().int().min(2).max(36).default(6),
});
export const GetTrendOutput = z.object({
  category: z.string().nullable(),
  series: z.array(
    z.object({
      period_start: IsoDate,
      total_spend_cents: z.number().int(),
      net_spend_cents: z.number().int(),
    }),
  ),
  current_cents: z.number().int(),
  average_cents: z.number().int(),
  delta_pct: z.number().nullable(),
  currency: z.string().nullable(),
});

// ---- getSubscriptions (Tier 1) ---------------------------------------------
export const GetSubscriptionsInput = z.object({});
export const GetSubscriptionsOutput = z.object({
  subscriptions: z.array(
    z.object({
      merchant_norm: z.string(),
      status: z.enum(["active", "confirmed"]),
      cadence_days: z.number().int().nullable(),
      avg_amount_cents: z.number().int(),
      next_expected: IsoDate.nullable(),
      confidence: z.number().min(0).max(1),
      currency: z.string(),
      occurrence_count: z.number().int().min(3),
      evidence: z.array(
        z.object({
          transaction_id: z.string(),
          date: IsoDate,
          amount_cents: z.number().int(),
        }),
      ),
      uncertainty: z.string(),
      amount_change_cents: z.number().int().nullable(),
    }),
  ),
});

// ---- getAnomalies (Tier 1) -------------------------------------------------
export const GetAnomaliesInput = z.object({
  status: z.enum(["new", "all"]).default("new"),
});
export const GetAnomaliesOutput = z.object({
  anomalies: z.array(
    z.object({
      type: z.enum(["amount_spike", "new_merchant", "category_spike"]),
      score: z.number(),
      reason: z.string(),
      txn: TransactionLite.nullable(),
    }),
  ),
});

// ---- getBudgetStatus (Tier 0) / setBudget ----------------------------------
export const GetBudgetStatusInput = z.object({
  category: z.string().optional(),
  period: z.literal("month").default("month"),
});
export const BudgetStatus = z.object({
  category: z.string(),
  currency: z.string().nullable(),
  limit_cents: z.number().int(),
  spent_cents: z.number().int(),
  pct_used: z.number(),
  remaining_cents: z.number().int(),
  exclusionsApplied: z.array(z.string()),
});
export const GetBudgetStatusOutput = z.object({
  budgets: z.array(BudgetStatus),
});
export const SetBudgetInput = z.object({
  category: z.string().min(1),
  period: z.literal("month").default("month"),
  limitAmount: z.number().positive(), // major units; handler converts to cents
});
export const SetBudgetOutput = BudgetStatus;

// ---- saveMemory (Tier 0) ---------------------------------------------------
export const SaveMemoryInput = z.object({
  kind: MemoryKind,
  rule: UserMemoryRule,
});
export const SaveMemoryOutput = z.object({
  ok: z.boolean(),
  summary: z.string(),
});

// ---- lookupMerchant (Tier 3) -----------------------------------------------
export const LookupMerchantInput = z.object({
  merchantName: z.string().min(1),
});
export const LookupMerchantOutput = z.object({
  couldNotDetermine: z.boolean(),
  merchant: z.string().nullable(),
  description: z.string().nullable(),
  sourceUrl: z.string().url().nullable(),
});

// ---- summarizeFinances (Tier 4) --------------------------------------------
export const SummarizeFinancesInput = z.object({
  period: z.literal("month").default("month"),
});
export const SummarizeFinancesOutput = z.object({
  summary: z.string(),
  stats: z.array(z.object({ label: z.string(), value: z.string() })),
});

// ---- suggestCutbacks (Tier 4) ----------------------------------------------
export const SuggestCutbacksInput = z.object({});
export const SuggestCutbacksOutput = z.object({
  currency: z.string().nullable(),
  suggestions: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      monthly_savings_cents: z.number().int(),
      category: z.string().nullable(),
    }),
  ),
});

// ---- askClarification ------------------------------------------------------
export const AskClarificationInput = z.object({
  question: z.string().min(1),
  suggestions: z.array(z.string()).max(4).optional(),
});
export const AskClarificationOutput = AskClarificationInput;

/**
 * Discriminated union of every tool result the UI can render (UI_SPEC §4.3).
 * `<ResultCard>` switches on `kind`; adding a card is additive here + in B2.
 */
export const ResultCardData = z.discriminatedUnion("kind", [
  GetSpendingOutput.extend({ kind: z.literal("spending") }),
  GetTransactionsOutput.extend({ kind: z.literal("transactions") }),
  GetTrendOutput.extend({ kind: z.literal("trend") }),
  GetSubscriptionsOutput.extend({ kind: z.literal("subscriptions") }),
  GetAnomaliesOutput.extend({ kind: z.literal("anomalies") }),
  GetBudgetStatusOutput.extend({ kind: z.literal("budget") }),
  SummarizeFinancesOutput.extend({ kind: z.literal("summary") }),
  SuggestCutbacksOutput.extend({ kind: z.literal("cutbacks") }),
  AskClarificationOutput.extend({ kind: z.literal("clarification") }),
  LookupMerchantOutput.extend({ kind: z.literal("merchant") }),
]);
export type ResultCardData = z.infer<typeof ResultCardData>;
