"use client";

import React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import type { ResultCardData } from "@/lib/contracts";
import { formatCents, cn } from "@/lib/utils";

/**
 * Presentation-only result cards (PRD-B2, UI_SPEC §4.3). Each maps a typed tool
 * output (ResultCardData, discriminated on `kind`) to a designed card. Cards
 * never fetch — they receive props. Adding a card is additive in this switch.
 */
export function ResultCard({ data }: { data: ResultCardData }) {
  switch (data.kind) {
    case "spending":
      return <SpendingBreakdownCard data={data} />;
    case "transactions":
      return <TransactionListCard data={data} />;
    case "trend":
      return <TrendCard data={data} />;
    case "subscriptions":
      return <SubscriptionsCard data={data} />;
    case "anomalies":
      return <AnomalyAlertCard data={data} />;
    case "budget":
      return <BudgetStatusCard data={data} />;
    case "summary":
      return <SummaryCard data={data} />;
    case "cutbacks":
      return <CutbacksCard data={data} />;
    case "clarification":
      return <ClarificationChips data={data} />;
    case "merchant":
      return <MerchantLookupCard data={data} />;
    default:
      return null;
  }
}

function Shell({
  eyebrow,
  title,
  children,
  className,
}: {
  eyebrow?: string;
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "animate-card-in rounded border border-border bg-surface p-5 shadow-sm",
        className,
      )}
    >
      {eyebrow && (
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-faint">
          {eyebrow}
        </div>
      )}
      {title && <div className="mb-3 text-sm font-medium text-text">{title}</div>}
      {children}
    </div>
  );
}

const Money = ({
  cents,
  currency,
  className,
}: {
  cents: number;
  currency: string | null;
  className?: string;
}) => (
  <span className={cn("tnum tabular-nums", className)}>
    {currency ? formatCents(cents, currency) : `${(cents / 100).toFixed(2)} · currency not set`}
  </span>
);

type Extract<K extends ResultCardData["kind"]> = ResultCardData & { kind: K };

function SpendingBreakdownCard({ data }: { data: Extract<"spending"> }) {
  const max = Math.max(1, ...data.breakdown.map((b) => b.amount_cents));
  return (
    <Shell eyebrow={`Spending · ${data.period.start} → ${data.period.end}`}>
      <dl className="mb-3 grid grid-cols-2 gap-3 border-b border-border pb-3 text-sm">
        <div>
          <dt className="text-xs text-text-muted">Gross outflows</dt>
          <dd><Money cents={data.gross_outflows_cents} currency={data.currency} className="font-display text-xl font-semibold" /></dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">Refunds</dt>
          <dd><Money cents={data.refunds_cents} currency={data.currency} /></dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">Net spend</dt>
          <dd><Money cents={data.net_spend_cents} currency={data.currency} className="font-medium" /></dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">Income</dt>
          <dd><Money cents={data.total_income_cents} currency={data.currency} /></dd>
        </div>
      </dl>
      {data.breakdown.length > 0 && (
        <ul className="space-y-2">
          {data.breakdown.slice(0, 8).map((b) => (
            <li key={b.key} className="text-sm">
              <div className="mb-0.5 flex justify-between">
                <span className="capitalize text-text-muted">{b.key}</span>
                <Money cents={b.amount_cents} currency={data.currency} />
              </div>
              <div className="h-1.5 rounded-full bg-surface-sunk">
                <div
                  className="h-1.5 rounded-full bg-accent"
                  style={{ width: `${(b.amount_cents / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

function TransactionListCard({ data }: { data: Extract<"transactions"> }) {
  if (data.rows.length === 0)
    return <Shell title="Transactions"><Empty>No matching transactions.</Empty></Shell>;
  return (
    <Shell eyebrow="Transactions">
      <ul className="divide-y divide-border">
        {data.rows.map((r, i) => (
          <li key={i} className="flex items-center justify-between py-2 text-sm">
            <div className="min-w-0">
              <div className="truncate text-text">{r.merchant ?? "—"}</div>
              <div className="text-xs text-text-faint">
                {r.date} · <span className="capitalize">{r.category} · {r.kind}</span>
              </div>
            </div>
            <Money cents={Math.abs(r.amount_cents)} currency={r.currency} className="shrink-0" />
          </li>
        ))}
      </ul>
      {data.hasMore && <div className="pt-2 text-xs text-text-faint">More results available…</div>}
    </Shell>
  );
}

function TrendCard({ data }: { data: Extract<"trend"> }) {
  const chart = data.series.map((s) => ({
    month: s.period_start.slice(0, 7),
    spend: s.total_spend_cents / 100,
  }));
  const up = data.delta_pct != null && data.delta_pct > 0;
  return (
    <Shell eyebrow={`Trend${data.category ? ` · ${data.category}` : ""}`}>
      <div className="mb-2 flex items-baseline gap-2">
        <Money cents={data.current_cents} currency={data.currency} className="font-display text-2xl font-semibold" />
        {data.delta_pct != null && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              Math.abs(data.delta_pct) < 10
                ? "bg-surface-sunk text-text-muted"
                : up
                  ? "bg-[color:var(--accent-soft)] text-warn"
                  : "bg-[color:var(--accent-soft)] text-income",
            )}
          >
            {up ? "+" : ""}
            {data.delta_pct}% vs your average
          </span>
        )}
      </div>
      <div className="h-32">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chart} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: "var(--text-faint)" }} axisLine={false} tickLine={false} />
            <YAxis hide />
            <Tooltip
              formatter={(v: number) => data.currency
                ? formatCents(Math.round(v * 100), data.currency)
                : `${v.toFixed(2)} · currency not set`}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--border)" }}
            />
            <Line type="monotone" dataKey="spend" stroke="var(--accent)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Shell>
  );
}

function SubscriptionsCard({ data }: { data: Extract<"subscriptions"> }) {
  if (data.subscriptions.length === 0)
    return <Shell title="Subscriptions"><Empty>No recurring charges detected yet.</Empty></Shell>;
  const cadence = (d: number | null) =>
    d == null ? "" : d <= 9 ? "weekly" : d <= 45 ? "monthly" : "yearly";
  return (
    <Shell eyebrow="Recurring charges">
      <ul className="divide-y divide-border">
        {data.subscriptions.map((s) => (
          <li key={s.merchant_norm} className="flex items-center justify-between py-2 text-sm">
            <div>
              <div className="capitalize text-text">{s.merchant_norm.toLowerCase()}</div>
              <div className="text-xs text-text-faint">
                {cadence(s.cadence_days)}
                {s.next_expected ? ` · next ${s.next_expected}` : ""}
              </div>
            </div>
            <Money cents={s.avg_amount_cents} currency={s.currency} />
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function AnomalyAlertCard({ data }: { data: Extract<"anomalies"> }) {
  if (data.anomalies.length === 0)
    return <Shell title="Unusual activity"><Empty>Nothing looks out of pattern.</Empty></Shell>;
  return (
    <Shell eyebrow="Unusual activity">
      <ul className="space-y-2">
        {data.anomalies.map((a, i) => (
          <li key={i} className="flex gap-3 rounded-sm border-l-2 border-warn bg-surface-sunk/50 p-2 text-sm">
            <span className="text-text-muted">{a.reason}</span>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function BudgetStatusCard({ data }: { data: Extract<"budget"> }) {
  if (data.budgets.length === 0)
    return <Shell title="Budgets"><Empty>No budgets set. Try “budget $400 for dining”.</Empty></Shell>;
  return (
    <Shell eyebrow="Budget">
      <div className="space-y-4">
        {data.budgets.map((b) => {
          const over = b.pct_used >= 100;
          const near = b.pct_used >= 80;
          const barColor = over ? "bg-danger" : near ? "bg-warn" : "bg-accent";
          return (
            <div key={b.category}>
              <div className="mb-1 flex justify-between text-sm">
                <span className="capitalize text-text">
                  {b.category === "__all__" ? "Overall" : b.category}
                </span>
                <span className="text-text-muted">
                  <Money cents={b.spent_cents} currency={b.currency} /> /{" "}
                  <Money cents={b.limit_cents} currency={b.currency} />
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-sunk">
                <div className={cn("h-2 rounded-full", barColor)} style={{ width: `${Math.min(100, b.pct_used)}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-xs">
                <span className={cn(over ? "text-danger" : near ? "text-warn" : "text-text-faint")}>
                  {b.pct_used}% used
                </span>
                {b.exclusionsApplied.length > 0 && (
                  <span className="text-text-faint">excluding {b.exclusionsApplied.join(", ")}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

function SummaryCard({ data }: { data: Extract<"summary"> }) {
  return (
    <Shell eyebrow="Summary">
      <p className="whitespace-pre-wrap text-sm text-text">{data.summary}</p>
      {data.stats.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-4 border-t border-border pt-3">
          {data.stats.map((s, i) => (
            <div key={i}>
              <div className="text-[11px] uppercase tracking-wide text-text-faint">{s.label}</div>
              <div className="tnum text-sm font-medium">{s.value}</div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

function CutbacksCard({ data }: { data: Extract<"cutbacks"> }) {
  if (data.suggestions.length === 0)
    return <Shell title="Cutbacks"><Empty>No clear cutbacks found.</Empty></Shell>;
  return (
    <Shell eyebrow="Where you could cut back">
      <ul className="space-y-3">
        {data.suggestions.map((s, i) => (
          <li key={i} className="text-sm">
            <div className="flex justify-between">
              <span className="font-medium text-text">{s.title}</span>
              <span className="tnum text-income">
                save {data.currency
                  ? formatCents(s.monthly_savings_cents, data.currency)
                  : `${(s.monthly_savings_cents / 100).toFixed(2)} · currency not set`}/mo
              </span>
            </div>
            <p className="text-text-muted">{s.detail}</p>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function MerchantLookupCard({ data }: { data: Extract<"merchant"> }) {
  if (data.couldNotDetermine || !data.merchant)
    return (
      <Shell eyebrow="Merchant lookup">
        <Empty>I couldn&apos;t confidently determine what this charge is.</Empty>
      </Shell>
    );
  return (
    <Shell eyebrow="Merchant lookup" title={data.merchant}>
      <p className="text-sm text-text-muted">{data.description}</p>
      {data.sourceUrl && (
        <a href={data.sourceUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-accent hover:underline">
          Source
        </a>
      )}
    </Shell>
  );
}

function ClarificationChips({ data }: { data: Extract<"clarification"> }) {
  return (
    <Shell>
      <p className="text-sm text-text">{data.question}</p>
      {data.suggestions && data.suggestions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {data.suggestions.map((s, i) => (
            <span key={i} className="rounded-full border border-border bg-surface-sunk px-3 py-1 text-xs text-text-muted">
              {s}
            </span>
          ))}
        </div>
      )}
    </Shell>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-text-faint">{children}</p>;
}
