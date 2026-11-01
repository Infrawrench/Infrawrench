"use client";

import { useGT, useLocale } from "gt-react";
import { useMemo, useRef, useState } from "react";
import { displayColumns, toCsv, viewPlatform, type DisplayColumn } from "@/lib/chat/format";
import type { Cell, ViewData } from "@/lib/chat/types";
import { localePath } from "@/lib/i18n/locales";
import {
  BarChartIcon,
  BellIcon,
  CheckIcon,
  CodeIcon,
  DownloadIcon,
  LinkIcon,
  TableIcon,
} from "../icons";
import { AlertForm } from "./AlertForm";
import { DataTable } from "./DataTable";
import { ViewChart } from "./ViewChart";

function FooterButton({
  onClick,
  pressed,
  children,
}: {
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-surface hover:text-ink ${pressed ? "text-ink" : "text-ink-2"}`}
    >
      {children}
    </button>
  );
}

/**
 * One view in the conversation: the table or chart, then a footer with what
 * it is and what can be done with it (see its query, download CSV, email
 * alerts, copy a link to `/v/<id>`).
 */
export function ViewCard({
  data,
  watch = false,
  fill = false,
}: {
  data: ViewData;
  watch?: boolean;
  /** Grows to its parent's height at most (the shared page), the table scrolling inside it. */
  fill?: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  const { view, result } = data;
  const [alerting, setAlerting] = useState(watch);
  const [showSql, setShowSql] = useState(false);
  const [copied, setCopied] = useState(false);
  const columns = useMemo(() => displayColumns(view, result), [view, result]);
  const visible = useRef<{ columns: DisplayColumn[]; rows: Cell[][] } | null>(null);

  const copyLink = async () => {
    const url = `${window.location.origin}${localePath(locale, `/v/${view.id}`)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt(gt("Copy this link"), url);
    }
  };

  const download = () => {
    const { columns: cols, rows } = visible.current ?? { columns, rows: result.rows };
    const blob = new Blob([toCsv(cols, rows)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${view.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "instances"}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <section
      className={`overflow-hidden rounded-xl border border-line bg-surface shadow-sm ${fill ? "flex min-h-0 flex-col" : ""}`}
    >
      <header className="flex shrink-0 items-baseline justify-between gap-3 border-b border-line px-3 py-2.5">
        <h3 className="font-semibold">{view.title}</h3>
        {result.truncated && (
          <span className="shrink-0 text-xs text-ink-3">
            {gt("First {count} rows", { count: result.rows.length })}
          </span>
        )}
      </header>
      {view.kind === "table" ? (
        <DataTable
          columns={columns}
          rows={result.rows}
          initialSort={view.sort}
          platform={viewPlatform(view.sql)}
          visibleRef={visible}
          fill={fill}
        />
      ) : (
        <div className={fill ? "min-h-0 flex-1 overflow-auto" : undefined}>
          <ViewChart
            spec={view}
            result={result}
            label={view.title}
            showAllLabel={(count) => gt("Show all {count}", { count })}
          />
        </div>
      )}
      {showSql && (
        <pre className="max-h-64 shrink-0 overflow-auto border-t border-line bg-surface-2 px-3 py-2 text-xs whitespace-pre-wrap">
          {view.sql}
        </pre>
      )}
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-2 px-2 py-1.5">
        <span className="flex items-center gap-1.5 px-1 text-xs text-ink-3">
          {view.kind === "table" ? (
            <>
              <TableIcon className="h-3.5 w-3.5" />
              {gt("Interactive table")}
            </>
          ) : (
            <>
              <BarChartIcon className="h-3.5 w-3.5" />
              {view.chart === "line" ? gt("Line chart") : gt("Bar chart")}
            </>
          )}
        </span>
        <div className="flex flex-wrap items-center gap-0.5">
          <FooterButton onClick={() => setShowSql((s) => !s)} pressed={showSql}>
            <CodeIcon className="h-3.5 w-3.5" />
            {gt("SQL")}
          </FooterButton>
          <FooterButton onClick={download}>
            <DownloadIcon className="h-3.5 w-3.5" />
            {gt("CSV")}
          </FooterButton>
          <FooterButton onClick={() => setAlerting((a) => !a)} pressed={alerting}>
            <BellIcon className="h-3.5 w-3.5" />
            {gt("Email if this changes")}
          </FooterButton>
          <FooterButton onClick={copyLink}>
            {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <LinkIcon className="h-3.5 w-3.5" />}
            {copied ? gt("Copied") : gt("Copy link")}
          </FooterButton>
        </div>
      </footer>
      {alerting && <AlertForm viewId={view.id} onClose={() => setAlerting(false)} />}
    </section>
  );
}
