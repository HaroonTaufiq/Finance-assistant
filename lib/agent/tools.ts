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
        "Produce a plain-English summary of where the user's money is going over a period. Use for open 'summarize my finances' requests.",
      inputSchema: C.SummarizeFinancesInput,
      execute: async (input) => {
        const supabase = await getServerClient();
        const rollups = await Q.getRollupContext(supabase, userId, 6);
        const { text } = await generateText({
          model: reasoningModel(),
          system: SYNTHESIS_SYSTEM,
          prompt: `Period of interest: ${input.period}. Pre-aggregated monthly rollups (amounts in cents; spend positive in total_spend_cents):\n${JSON.stringify(rollups)}\n\nWrite a concise summary of where the money is going and notable changes.`,
        });
        const latest = rollups.find((r) => r.category === "__all__");
        const stats = latest
          ? [
              { label: "Latest month spend", value: formatCents(latest.total_spend_cents) },
              { label: "Latest month income", value: formatCents(latest.total_income_cents) },
            ]
          : [];
        return { kind: "summary" as const, summary: text, stats };
      },
    }),

    suggestCutbacks: tool({
      description:
        "Suggest concrete, numbers-backed places to cut spending, personalized to the user. Reads rollups + subscriptions.",
      inputSchema: C.SuggestCutbacksInput,
      execute: async () => {
        const supabase = await getServerClient();
        const [rollups, subs] = await Promise.all([
          Q.getRollupContext(supabase, userId, 3),
          Q.getSubscriptions(supabase, userId),
        ]);
        const { text } = await generateText({
          model: reasoningModel(),
          system: SYNTHESIS_SYSTEM,
          prompt: `Aggregated rollups (cents): ${JSON.stringify(rollups)}\nActive subscriptions (cents): ${JSON.stringify(subs.subscriptions)}\n\nReturn 2-4 concrete cutback ideas. For each: a short title, a one-line detail with the real number, and the estimated monthly saving in cents. Respond as JSON array: [{"title","detail","monthly_savings_cents","category"}].`,
        });
        const suggestions = parseCutbacksOutput(text);
        return { kind: "cutbacks" as const, suggestions };
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
        });

        if (object.couldNotDetermine || !object.merchant) return miss;
        return {
          kind: "merchant" as const,
          couldNotDetermine: false,
          merchant: object.merchant,
          description: object.description ?? "",
          sourceUrl: results[0]?.url ?? null,
        };
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
