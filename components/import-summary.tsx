"use client";

import { useState } from "react";
import Link from "next/link";
import type { IngestSummary } from "@/lib/contracts";

/**
 * Import summary card (UI_SPEC §4.5). Non-negotiable per the edge-case
 * requirements: skipped rows are surfaced with reasons, never silently dropped.
 */
export function ImportSummaryCard({ summary }: { summary: IngestSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="animate-card-in rounded border border-border bg-surface p-4 text-sm shadow-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-income">{summary.imported} added</span>
        <span className="text-text-faint">·</span>
        <span className="text-text-muted">{summary.skipped} skipped</span>
        {summary.duplicates > 0 && (
          <>
            <span className="text-text-faint">·</span>
            <span className="text-text-muted">{summary.duplicates} duplicates</span>
          </>
        )}
        {summary.possibleDuplicates > 0 && (
          <span className="text-text-muted">
            {summary.possibleDuplicates} identical rows kept for your review
          </span>
        )}
      </div>
      {summary.reasons.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setOpen((o) => !o)}
            className="text-xs text-accent hover:underline"
          >
            {open ? "Hide" : "Show"} skip reasons
          </button>
          {open && (
            <ul className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-text-muted">
              {summary.reasons.map((r, i) => (
                <li key={i} className="flex justify-between">
                  <span>{r.reason}</span>
                  <span className="tnum text-text-faint">×{r.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Link href="/report" className="mt-3 inline-block text-xs text-accent hover:underline">
        Open the monthly report
      </Link>
    </div>
  );
}
