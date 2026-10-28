"use client";

import { useState } from "react";
import { SupportedCurrency, type ReceiptDraft } from "@/lib/contracts";
import { cn } from "@/lib/utils";

/**
 * Editable receipt draft (UI_SPEC §5.2). Always requires an explicit Confirm —
 * a receipt is never auto-recorded (SPEC §8). Low-confidence fields are
 * highlighted for review; a near-duplicate surfaces a conflict to resolve.
 */
export function ReceiptDraftCard({
  draft,
  onConfirmed,
  onDiscard,
}: {
  draft: ReceiptDraft;
  onConfirmed: () => void;
  onDiscard: () => void;
}) {
  const d = draft.draft;
  const [merchant, setMerchant] = useState(d.merchant ?? "");
  const [date, setDate] = useState(d.date ?? "");
  const [total, setTotal] = useState(d.total_cents != null ? (d.total_cents / 100).toFixed(2) : "");
  const [currency, setCurrency] = useState(d.currency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictId, setConflictId] = useState<string | null>(null);

  const low = (f: string) => draft.lowConfidenceFields.includes(f);
  const canConfirm = date.trim() !== "" && total.trim() !== "" && Number(total) > 0;

  async function confirm(resolveConflict?: "keep") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/receipts/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          receiptId: draft.receiptId,
          resolveConflict,
          fields: {
            merchant: merchant || null,
            date,
            total_cents: Math.round(Number(total) * 100),
            currency,
            lineItems: d.lineItems,
            confidence: d.confidence,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Confirm failed");
      if (json.conflict) {
        setConflictId(json.conflict.existingTransactionId);
        return;
      }
      onConfirmed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Confirm failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="animate-card-in rounded border border-border bg-surface p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-faint">
          Receipt
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px]",
            d.confidence >= 0.7 ? "bg-[color:var(--accent-soft)] text-accent" : "bg-surface-sunk text-warn",
          )}
        >
          {Math.round(d.confidence * 100)}% confidence
        </span>
      </div>

      <div className="space-y-3">
        <Field label="Merchant" low={low("merchant")}>
          <input
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
            className="w-full bg-transparent text-sm outline-none"
            placeholder="Merchant name"
          />
        </Field>
        <Field label="Date" low={low("date")}>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full bg-transparent text-sm outline-none"
          />
        </Field>
        <Field label="Total" low={low("total")}>
          <input
            type="number"
            step="0.01"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            className="tnum w-full bg-transparent text-sm outline-none"
            placeholder="0.00"
          />
        </Field>
        <Field label="Currency" low={false}>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="w-full bg-transparent text-sm outline-none"
            aria-label="Receipt currency"
          >
            {SupportedCurrency.options.map((supportedCurrency) => (
              <option key={supportedCurrency} value={supportedCurrency}>
                {supportedCurrency}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      {conflictId ? (
        <div className="mt-4 rounded-sm border border-warn/40 bg-surface-sunk p-3 text-sm">
          <p className="text-text-muted">
            This looks like a transaction you already have. Add it anyway, or discard to avoid
            double-counting?
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => confirm("keep")}
              disabled={busy}
              className="rounded-sm bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              Add anyway
            </button>
            <button
              onClick={onDiscard}
              className="rounded-sm border border-border px-3 py-1.5 text-xs"
            >
              Discard
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => confirm()}
            disabled={!canConfirm || busy}
            className="rounded-sm bg-accent px-4 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Confirm"}
          </button>
          <button
            onClick={onDiscard}
            disabled={busy}
            className="rounded-sm border border-border px-4 py-1.5 text-sm text-text-muted hover:text-text"
          >
            Discard
          </button>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  low,
  children,
}: {
  label: string;
  low: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-sm border px-3 py-2",
        low ? "border-warn ring-1 ring-warn/30" : "border-border",
      )}
    >
      <div className="mb-0.5 text-[11px] uppercase tracking-wide text-text-faint">
        {label}
        {low && <span className="ml-1 text-warn">· review</span>}
      </div>
      {children}
    </div>
  );
}
