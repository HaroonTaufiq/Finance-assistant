import "server-only";
import { tool, generateText, generateObject, type ToolSet } from "ai";
import { z } from "zod";
import { getServerClient } from "@/lib/db/client";
import { reasoningModel } from "./models";
import { SYNTHESIS_SYSTEM, MERCHANT_SYSTEM } from "./prompts";
import { parseCutbacksOutput } from "./cutbacks";
import { webSearch } from "@/lib/search/web";
import * as Q from "@/lib/db/queries";
import * as C from "@/lib/contracts";
import { formatCents } from "@/lib/utils";
import { loadMemory, summarizeRule } from "@/lib/memory/rules";
import { getMonthlyReport } from "@/lib/report/monthly";
import { buildReportEvidence, StaleReportRevisionError } from "@/lib/report/explanation";
import { withUserAiRequest } from "@/lib/agent/request-limit";

/**
 * Typed tool definitions (PRD-B1, SPEC §5.1). Each tool = a Zod input schema
 * (from 00-contracts) + a handler calling a parameterized query. Handlers
 * return ResultCardData-shaped objects (with `kind`) so the UI renders a card
 * with no extra mapping. Heavy work (summaries) is delegated to REASONING_MODEL
 * *inside* the tool — the orchestrator itself stays on the cheap router model.
 *
 * Budget/memory tools (B3) and lookupMerchant (C2) register into this set.
 */
export function buildToolSet(ctx: { userId: string; today: string }): ToolSet {
  const { userId } = ctx;

  return {
    getSpending: tool({
      description:
        "Total spending over a date range, optionally for one category, optionally grouped by category or month. Reads precomputed monthly rollups. Use for 'how much did I spend' questions.",
      inputSchema: C.GetSpendingInput,
      execute: async (input) => {
        const supabase = await getServerClient();
        const out = await Q.getSpending(supabase, userId, input);
        return { kind: "spending" as const, ...out };
      },
    }),

    getTransactions: tool({
      description:
        "List individual transactions matching filters, sorted, bounded to <=50. Use for specific lookups like 'biggest purchase in March' (biggest spend = sort amount_asc, since spend is negative) or 'show my Amazon charges'.",
      inputSchema: C.GetTransactionsInput,
      execute: async (input) => {
        const supabase = await getServerClient();
        const out = await Q.getTransactions(supabase, userId, input);
        return { kind: "transactions" as const, ...out };
      },
    }),

    getTrend: tool({
      description:
        "Monthly spending trend over the last N periods (reads rollups). Use for 'am I spending more than usual', comparisons over time, and long-history questions. Never list raw transactions for these.",
      inputSchema: C.GetTrendInput,
      execute: async (input) => {
        const supabase = await getServerClient();
        const out = await Q.getTrend(supabase, userId, input);
        return { kind: "trend" as const, ...out };
      },
    }),

    getSubscriptions: tool({
      description: "List detected active recurring charges / subscriptions.",
      inputSchema: C.GetSubscriptionsInput,
      execute: async () => {
        const supabase = await getServerClient();
        const out = await Q.getSubscriptions(supabase, userId);
        return { kind: "subscriptions" as const, ...out };
      },
    }),

    getAnomalies: tool({
      description:
        "List unusual / out-of-pattern activity flags (amount spikes, new merchants, category spikes).",
      inputSchema: C.GetAnomaliesInput,
      execute: async (input) => {
        const supabase = await getServerClient();
        const out = await Q.getAnomalies(supabase, userId, input);
        return { kind: "anomalies" as const, ...out };
      },
    }),

    summarizeFinances: tool({
      description:
        "Summarize the latest completed calendar-month report, including currency, coverage, refunds and net spend.",
      inputSchema: C.SummarizeFinancesInput,
      execute: async (input) => {
        const supabase = await getServerClient();
        const report = await getMonthlyReport(supabase, userId);
        if (!report.hasData) {
          return {
            kind: "summary" as const,
            summary: "There is no imported report to summarize yet. Import a transaction export first.",
            stats: [],
          };
        }
        const revisionId = report.revision?.id;
        if (!revisionId) throw new Error("A completed report revision is required for a grounded summary.");
        const { text } = await withUserAiRequest(supabase, userId, () =>
          generateText({
            model: reasoningModel(),
            system: SYNTHESIS_SYSTEM,
            prompt: `Summarize this latest completed monthly report. Period requested: ${input.period}. Do not describe a category total as net spending unless its field says net spend.\n${JSON.stringify(buildReportEvidence(report))}`,
            maxOutputTokens: 500,
          }),
        );
        if (!text.trim()) throw new Error("The summary provider returned an empty response.");
        await assertReportRevision(supabase, userId, report.month, revisionId);
        return {
          kind: "summary" as const,
          summary: text.trim(),
          stats: [
            { label: "Gross outflows", value: formatCents(report.totals.grossOutflowsCents, report.currency) },
            { label: "Refunds", value: formatCents(report.totals.refundsCents, report.currency) },
            { label: "Net spend", value: formatCents(report.totals.netSpendCents, report.currency) },
            { label: "Income", value: formatCents(report.totals.incomeCents, report.currency) },
          ],
        };
      },
    }),

    suggestCutbacks: tool({
      description:
        "Suggest concrete, numbers-backed places to cut spending, personalized to the user. Reads rollups + subscriptions.",
      inputSchema: C.SuggestCutbacksInput,
      execute: async () => {
        const supabase = await getServerClient();
        const report = await getMonthlyReport(supabase, userId);
        if (!report.hasData) {
          return { kind: "cutbacks" as const, currency: null, suggestions: [] };
        }

        const revisionId = report.revision?.id;
        if (!revisionId) throw new Error("A completed report revision is required for grounded suggestions.");
        const { text } = await withUserAiRequest(supabase, userId, () =>
          generateText({
            model: reasoningModel(),
            system: SYNTHESIS_SYSTEM,
            prompt: `Use this latest completed monthly report to suggest only plausible, non-guaranteed options. Do not equate recurring charges with waste. All amounts are minor units in ${report.currency}.\n${JSON.stringify(buildReportEvidence(report))}\n\nReturn 2-4 concrete ideas, or fewer if evidence is insufficient. For each: a short title, a one-line detail with an evidence-backed amount, and an estimated monthly saving in cents. Respond as JSON array: [{"title","detail","monthly_savings_cents","category"}].`,
            maxOutputTokens: 600,
          }),
        );
        const suggestions = parseCutbacksOutput(text);
        await assertReportRevision(supabase, userId, report.month, revisionId);
        return { kind: "cutbacks" as const, currency: report.currency, suggestions };
      },
    }),

    getBudgetStatus: tool({
      description:
        "Budget status for one category or all budgets: limit vs spend, % used, remaining. Applies the user's exclusion rules. Use for 'how am I doing on my budget'.",
      inputSchema: C.GetBudgetStatusInput,
      execute: async (input) => {
        const supabase = await getServerClient();
        const mem = await loadMemory(userId);
        const out = await Q.getBudgetStatus(supabase, userId, input, mem.budgetExclusions);
        return { kind: "budget" as const, ...out };
      },
    }),

    setBudget: tool({
      description:
        "Create or update a monthly budget for a category (or '__all__' for a total budget). limitAmount is in dollars. Returns the updated budget status.",
      inputSchema: C.SetBudgetInput,
      execute: async (input) => {
        const supabase = await getServerClient();
        const mem = await loadMemory(userId);
        const status = await Q.setBudget(supabase, userId, input, mem.budgetExclusions);
        return { kind: "budget" as const, budgets: [status] };
      },
    }),

    saveMemory: tool({
      description:
        "Persist a user rule or fact to remember and apply later. Use when the user says to remember something, 'I get paid on the Nth', or 'don't count X in my Y budget' (exclude_category_from_budget with exclude=X, from=Y; use from='__all__' for an overall budget).",
      inputSchema: C.SaveMemoryInput,
      execute: async (input) => {
        const supabase = await getServerClient();
        const out = await Q.saveMemory(supabase, userId, input, summarizeRule(input.rule));
        return out; // {ok, summary} — narrated by the model, no card
      },
    }),

    lookupMerchant: tool({
      description:
        "Look up an unfamiliar merchant or card charge online and summarize what it likely is. Use when the user doesn't recognize a charge. Returns a sourced best guess or an honest 'could not determine'.",
      inputSchema: C.LookupMerchantInput,
      execute: async (input) => {
        const supabase = await getServerClient();
        return withUserAiRequest(supabase, userId, async () => {
          const results = await webSearch(
            `What company is the credit card charge descriptor "${input.merchantName}"? merchant identification`,
            { topK: 5 },
          );
          const miss = {
            kind: "merchant" as const,
            couldNotDetermine: true,
            merchant: null,
            description: null,
            sourceUrl: null,
          };
          if (results.length === 0) return miss;

          const { object } = await generateObject({
            model: reasoningModel(),
            schema: z.object({
              couldNotDetermine: z.boolean(),
              merchant: z.string().nullable(),
              description: z.string().nullable(),
            }),
            system: MERCHANT_SYSTEM,
            prompt: `Charge descriptor: "${input.merchantName}"\n\nSearch results:\n${results
              .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
              .join("\n\n")}`,
            maxOutputTokens: 300,
          });

          if (object.couldNotDetermine || !object.merchant) return miss;
          return {
            kind: "merchant" as const,
            couldNotDetermine: false,
            merchant: object.merchant,
            description: object.description ?? "",
            sourceUrl: results[0]?.url ?? null,
          };
        });
      },
    }),

    askClarification: tool({
      description:
        "Ask the user ONE focused clarifying question when the request is ambiguous or under-specified. Optionally offer up to 4 quick-reply suggestions. Prefer this over guessing.",
      inputSchema: C.AskClarificationInput,
      execute: async (input) => {
        return { kind: "clarification" as const, question: input.question, suggestions: input.suggestions };
      },
    }),
  };
}

async function assertReportRevision(
  supabase: Awaited<ReturnType<typeof getServerClient>>,
  userId: string,
  month: string,
  revisionId: string,
): Promise<void> {
  const current = await getMonthlyReport(supabase, userId, month);
  if (!current.hasData || current.revision?.id !== revisionId) {
    throw new StaleReportRevisionError();
  }
}
