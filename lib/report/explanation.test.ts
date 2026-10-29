import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateText, getMonthlyReport } = vi.hoisted(() => ({
  generateText: vi.fn(),
  getMonthlyReport: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("ai", () => ({ generateText }));
vi.mock("./monthly", () => ({ getMonthlyReport }));
vi.mock("@/lib/agent/models", () => ({ reasoningModel: () => "mock-model" }));
vi.mock("@/lib/agent/request-limit", () => ({
  withUserAiRequest: (_supabase: unknown, _userId: string, operation: () => Promise<unknown>) => operation(),
}));

import {
  buildReportEvidencePrompt,
  explainMonthlyReport,
  StaleReportRevisionError,
  type CompleteMonthlyReport,
} from "./explanation";

const report: CompleteMonthlyReport = {
  hasData: true,
  month: "2024-04",
  monthLabel: "2024-04",
  currency: "PKR",
  coverage: {
    status: "observed_transactions_only",
    observedFrom: "2024-04-15",
    observedTo: "2024-04-30",
  },
  totals: {
    grossOutflowsCents: 12000,
    refundsCents: 2000,
    netSpendCents: 10000,
    incomeCents: 50000,
    unknownInflowsCents: 0,
  },
  categories: [{
    category: "other",
    total_spend_cents: 12000,
    total_refund_cents: 2000,
    net_spend_cents: 10000,
  }],
  comparison: {
    priorMonth: "2024-03",
    priorNetSpendCents: 9000,
    deltaCents: 1000,
    deltaPercent: 11.1,
  },
  subscriptions: [{
    merchant_norm: "STREAMCO",
    status: "active",
    cadence_days: 30,
    avg_amount_cents: 1000,
    next_expected: "2024-05-01",
    confidence: 0.8,
    currency: "PKR",
    occurrence_count: 3,
    evidence: [{
      transaction_id: "transaction-1",
      date: "2024-04-01",
      amount_cents: -1000,
    }],
    uncertainty: "Only observed export history is available.",
    amount_change_cents: null,
  }],
  transactions: [{
    id: "transaction-1",
    txn_date: "2024-04-01",
    amount_cents: -1000,
    currency: "PKR",
    merchant_raw: "PRIVATE FREE TEXT NOT FOR MODEL",
    merchant_norm: "STREAMCO",
    category: "subscriptions",
    transaction_kind: "expense",
    category_override: "other",
    transaction_kind_override: "transfer",
  }],
  revision: {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    generation: 1,
    jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    completed_at: "2024-05-01T00:00:00Z",
  },
  updatedAt: "2024-05-01T00:00:00Z",
};

describe("monthly report explanations", () => {
  beforeEach(() => {
    generateText.mockReset();
    getMonthlyReport.mockReset();
  });

  it("uses currency, refund, net, coverage and effective classifications without raw descriptions", () => {
    const prompt = buildReportEvidencePrompt(report, { kind: "change" });

    expect(prompt).toContain('"currency":"PKR"');
    expect(prompt).toContain('"grossOutflowsCents":12000');
    expect(prompt).toContain('"refundsCents":2000');
    expect(prompt).toContain('"netSpendCents":10000');
    expect(prompt).toContain('"status":"observed_transactions_only"');
    expect(prompt).toContain('"category":"other"');
    expect(prompt).toContain('"kind":"transfer"');
    expect(prompt).not.toContain("PRIVATE FREE TEXT NOT FOR MODEL");
  });

  it("returns a successful mocked explanation tied to the selected revision", async () => {
    getMonthlyReport.mockResolvedValue(report);
    generateText.mockResolvedValue({ text: "Net spend was PKR 100.00 after PKR 20.00 in refunds." });

    await expect(explainMonthlyReport({
      supabase: {} as never,
      userId: "user-1",
      month: "2024-04",
      expectedRevision: report.revision!.id,
      topic: { kind: "change" },
    })).resolves.toEqual({
      text: "Net spend was PKR 100.00 after PKR 20.00 in refunds.",
      revisionId: report.revision!.id,
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(getMonthlyReport).toHaveBeenCalledTimes(2);
  });

  it("rejects a response if a correction changes the report revision during generation", async () => {
    getMonthlyReport
      .mockResolvedValueOnce(report)
      .mockResolvedValueOnce({
        ...report,
        revision: {
          id: "2:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          generation: 2,
          jobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          completed_at: "2024-05-02T00:00:00Z",
        },
      });
    generateText.mockResolvedValue({ text: "A stale explanation." });

    await expect(explainMonthlyReport({
      supabase: {} as never,
      userId: "user-1",
      month: "2024-04",
      expectedRevision: report.revision!.id,
      topic: { kind: "change" },
    })).rejects.toBeInstanceOf(StaleReportRevisionError);
  });

  it("propagates provider failures instead of returning success-shaped output", async () => {
    getMonthlyReport.mockResolvedValue(report);
    generateText.mockRejectedValue(new Error("provider unavailable"));

    await expect(explainMonthlyReport({
      supabase: {} as never,
      userId: "user-1",
      month: "2024-04",
      expectedRevision: report.revision!.id,
      topic: { kind: "change" },
    })).rejects.toThrow("provider unavailable");
    expect(getMonthlyReport).toHaveBeenCalledTimes(1);
  });
});
