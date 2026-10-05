import { useGT } from "gt-react";
import {
  COST_ANOMALY_DIMENSION_LABELS,
  COST_DIMENSION_LABELS,
  formatBucketLabel,
  formatCostCanvasChange,
  formatCostCanvasKpi,
  formatMoney,
  type CostCanvasBlock,
  type CostCanvasBlockResult,
  type CostCanvasRunResult,
  type CostCanvasSpec,
} from "@infrawrench/client-core";
import { CostGraphCard } from "../cost/CostGraphCard.js";
import { BudgetCard } from "../cost/BudgetCard.js";
import type { CostApi } from "../cost/types.js";
import { ChatMarkdown } from "../chat/ChatMarkdown.js";
import { CustomGraphChart } from "../custom-graphs/CustomGraphChart.js";
import { useDataString } from "../i18n/data-strings.js";

export interface CostCanvasBlockEditing {
  onMove(index: number, direction: -1 | 1): void;
  onRemove(index: number): void;
  /** Chart blocks only: open the cost graph editor. */
  onEditChart(index: number): void;
}

export interface CostCanvasViewProps {
  spec: CostCanvasSpec;
  /** Null while the first run is in flight. */
  result: CostCanvasRunResult | null;
  api: CostApi;
  /** Dashboard-card density: no per-block controls, shorter charts. */
  compact?: boolean | undefined;
  /** Manual edits (move, remove, edit chart); absent renders read-only. */
  editing?: CostCanvasBlockEditing | undefined;
  /** Blocks to mark as changed, for previewing a proposed edit. */
  changedBlockIds?: ReadonlySet<string> | undefined;
}

const CARD = "rounded-2xl border border-border bg-surface-raised";

/**
 * Renders a canvas: each block from the spec with its result from the run.
 * Charts draw through {@link CostGraphCard} (the dashboard's own component,
 * querying live through the host's {@link CostApi}); everything else draws
 * from the run result, which the server computed from the same services.
 */
export function CostCanvasView({
  spec,
  result,
  api,
  compact,
  editing,
  changedBlockIds,
}: CostCanvasViewProps) {
  const gt = useGT();
  const byId = new Map((result?.blocks ?? []).map((b) => [b.id, b]));

  if (spec.blocks.length === 0) {
    return (
      <div className={`${CARD} px-6 py-10 text-center text-sm text-on-surface-faint`}>
        {gt("This canvas has no blocks yet. Describe what it should show in the chat.")}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {spec.blocks.map((block, index) => (
        <div
          key={block.id}
          className={`group relative ${spanFor(block, compact)} ${
            changedBlockIds?.has(block.id) ? "ring-2 ring-warning rounded-2xl" : ""
          }`}
        >
          <BlockBody block={block} result={byId.get(block.id)} api={api} compact={compact} />
          {editing && !compact && (
            <BlockControls
              index={index}
              count={spec.blocks.length}
              isChart={block.kind === "chart"}
              editing={editing}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function spanFor(block: CostCanvasBlock, compact: boolean | undefined): string {
  if (block.kind === "kpi") return "col-span-1";
  if (compact) return "col-span-2 md:col-span-4";
  return "col-span-2 md:col-span-4";
}

function BlockControls({
  index,
  count,
  isChart,
  editing,
}: {
  index: number;
  count: number;
  isChart: boolean;
  editing: CostCanvasBlockEditing;
}) {
  const gt = useGT();
  const btn =
    "rounded bg-surface-overlay border border-border px-1.5 py-0.5 text-[11px] text-on-surface-muted hover:text-on-surface";
  return (
    <div className="absolute right-2 top-2 z-10 hidden gap-1 group-hover:flex group-focus-within:flex">
      {isChart && (
        <button type="button" className={btn} onClick={() => editing.onEditChart(index)}>
          {gt("Edit")}
        </button>
      )}
      <button
        type="button"
        className={btn}
        disabled={index === 0}
        onClick={() => editing.onMove(index, -1)}
        aria-label={gt("Move up")}
      >
        ↑
      </button>
      <button
        type="button"
        className={btn}
        disabled={index === count - 1}
        onClick={() => editing.onMove(index, 1)}
        aria-label={gt("Move down")}
      >
        ↓
      </button>
      <button type="button" className={btn} onClick={() => editing.onRemove(index)}>
        {gt("Remove")}
      </button>
    </div>
  );
}

function BlockError({ title, message }: { title: string; message: string }) {
  return (
    <div className={`${CARD} p-4`}>
      {title && <div className="text-xs font-medium text-on-surface-muted mb-1">{title}</div>}
      <div role="alert" className="text-sm text-danger">
        {message}
      </div>
    </div>
  );
}

function Loading() {
  const gt = useGT();
  return (
    <div className={`${CARD} p-4 text-sm text-on-surface-faint animate-pulse`}>
      {gt("Loading…")}
    </div>
  );
}

function BlockBody({
  block,
  result,
  api,
  compact,
}: {
  block: CostCanvasBlock;
  result: CostCanvasBlockResult | undefined;
  api: CostApi;
  compact: boolean | undefined;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const chartHeight = compact ? "h-64" : "h-80";

  // Charts query live through the host's CostApi, so they need no result.
  if (block.kind === "chart") {
    return (
      <div className={`${chartHeight} [&>*]:h-full`}>
        <CostGraphCard title={block.title} config={block.config} api={api} />
      </div>
    );
  }
  if (!result) return <Loading />;
  if (result.error) {
    const title = block.kind === "text" ? "" : (block.title ?? "");
    return <BlockError title={title} message={result.error} />;
  }

  switch (result.kind) {
    case "text":
      return (
        <div className="px-1 py-1">
          <ChatMarkdown text={result.text} />
        </div>
      );
    case "kpi": {
      const title = block.kind === "kpi" ? block.title : "";
      const change = formatCostCanvasChange(result.kpi?.changePercent);
      const up = (result.kpi?.changePercent ?? 0) > 0;
      return (
        <div className={`${CARD} p-4 h-full flex flex-col gap-1`}>
          <div className="text-xs text-on-surface-muted truncate" title={title}>
            {title}
          </div>
          <div className="text-xl font-semibold text-on-surface tabular-nums">
            {formatCostCanvasKpi(result.kpi)}
          </div>
          {change && (
            <div className={`text-xs tabular-nums ${up ? "text-danger" : "text-success"}`}>
              {gt("{change} vs previous period", { change })}
            </div>
          )}
          {result.kpi?.from && result.kpi.to && (
            <div className="text-[11px] text-on-surface-faint">
              {gt("{from} to {to}", { from: result.kpi.from, to: result.kpi.to })}
            </div>
          )}
          {result.kpi?.note && (
            <div className="text-[11px] text-on-surface-faint">{result.kpi.note}</div>
          )}
        </div>
      );
    }
    case "table": {
      if (block.kind !== "table" || !result.table) return null;
      const t = result.table;
      const binning = block.query.binning;
      const collapsed = binning === "none";
      const money = (v: number) => formatMoney(v, t.currency ?? "USD");
      return (
        <div className={`${CARD} p-4 overflow-x-auto`}>
          <div className="flex items-baseline justify-between gap-3 mb-2">
            <div className="text-sm font-medium text-on-surface">{block.title}</div>
            <div className="text-[11px] text-on-surface-faint">
              {gt("{from} to {to}", { from: t.from, to: t.to })}
            </div>
          </div>
          {t.rows.length === 0 ? (
            <div className="text-sm text-on-surface-faint">{gt("No spend in this window.")}</div>
          ) : (
            <table className="w-full text-xs tabular-nums">
              <thead>
                <tr className="text-on-surface-faint">
                  <th className="text-left font-normal py-1 pr-3">
                    {block.query.groupBy === "tag"
                      ? (block.query.groupByTagKey ?? "")
                      : gtData(COST_DIMENSION_LABELS[block.query.groupBy])}
                  </th>
                  {!collapsed &&
                    t.columns.map((c) => (
                      <th key={c} className="text-right font-normal py-1 px-2 whitespace-nowrap">
                        {formatBucketLabel(c, binning)}
                      </th>
                    ))}
                  <th className="text-right font-normal py-1 pl-2">{gt("Total")}</th>
                </tr>
              </thead>
              <tbody>
                {t.rows.map((r) => (
                  <tr key={r.key} className="border-t border-border">
                    <td className="py-1 pr-3 text-on-surface-secondary truncate max-w-[16rem]">
                      {r.key === "__other__" ? gt("Other") : r.label}
                    </td>
                    {!collapsed &&
                      r.values.map((v, i) => (
                        <td key={i} className="text-right py-1 px-2 text-on-surface-secondary">
                          {money(v)}
                        </td>
                      ))}
                    <td className="text-right py-1 pl-2 font-medium text-on-surface">
                      {money(r.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {t.otherCurrencies.length > 0 && (
            <div className="mt-2 text-[11px] text-on-surface-faint">
              {gt("Spend in {currencies} is not included in this table.", {
                currencies: t.otherCurrencies.join(", "),
              })}
            </div>
          )}
        </div>
      );
    }
    case "budgets": {
      const title = block.kind === "budgets" ? block.title : "";
      return (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium text-on-surface px-1">{title}</div>
          {result.budgets.length === 0 ? (
            <div className={`${CARD} p-4 text-sm text-on-surface-faint`}>
              {gt("No budgets to show.")}
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {result.budgets.map((b) => (
                <BudgetCard key={b.id} budget={b} />
              ))}
            </div>
          )}
          {result.missing.length > 0 && (
            <div className="text-[11px] text-on-surface-faint px-1">
              {gt("{count} budget(s) on this canvas were deleted or are not visible to you.", {
                count: result.missing.length,
              })}
            </div>
          )}
        </div>
      );
    }
    case "anomalies": {
      const title = block.kind === "anomalies" ? block.title : "";
      return (
        <div className={`${CARD} p-4`}>
          <div className="text-sm font-medium text-on-surface mb-2">{title}</div>
          {result.withheld ? (
            <div className="text-sm text-on-surface-faint">
              {gt(
                "Anomalies are detected over all of the organization's spend, so they are not shown to viewers with a cost visibility scope.",
              )}
            </div>
          ) : result.anomalies.length === 0 ? (
            <div className="text-sm text-on-surface-faint">
              {gt("No anomalies in this window.")}
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-border text-xs">
              {result.anomalies.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="text-on-surface-secondary truncate">
                    {a.day} · {gtData(COST_ANOMALY_DIMENSION_LABELS[a.dimension])}: {a.dimensionKey}
                  </span>
                  <span className="tabular-nums text-on-surface">
                    {formatMoney(a.actualCents / 100, a.currency)}
                    {a.kind === "new_source" ? (
                      <span className="ml-2 text-warning">{gt("New source")}</span>
                    ) : (
                      <span className="ml-2 text-on-surface-faint">
                        {gt("usually {amount}", {
                          amount: formatMoney(a.baselineCents / 100, a.currency),
                        })}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    case "cost_report": {
      if (!result.report) return null;
      const title = (block.kind === "cost_report" && block.title) || result.report.name;
      return (
        <div className={`${chartHeight} [&>*]:h-full`}>
          <CostGraphCard title={title} config={result.report.config} api={api} />
        </div>
      );
    }
    case "custom_graph": {
      const title = (block.kind === "custom_graph" && block.title) || result.graph?.name || "";
      return (
        <div className={`${CARD} p-4 flex flex-col gap-2 ${compact ? "" : "min-h-[16rem]"}`}>
          <div className="text-sm font-medium text-on-surface">{title}</div>
          {result.spec ? (
            <div className="flex-1 min-h-[12rem]">
              <CustomGraphChart spec={result.spec.chart} />
            </div>
          ) : (
            <div className="text-sm text-on-surface-faint">{gt("No output.")}</div>
          )}
          {result.spec?.notice && (
            <div className="text-[11px] text-on-surface-faint">{result.spec.notice}</div>
          )}
        </div>
      );
    }
    case "chart":
      return null;
  }
}
