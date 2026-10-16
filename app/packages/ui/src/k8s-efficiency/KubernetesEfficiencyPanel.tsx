import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  DEFAULT_K8S_EFFICIENCY_CONFIG,
  formatBucketLabel,
  formatKubernetesEfficiency,
  formatMoney,
  K8S_COST_CATEGORIES,
  K8S_USAGE_STATE_COLORS,
  K8S_USAGE_STATES,
  kubernetesEfficiencyCsv,
  type CostBinningId,
  type CostReportFolder,
  type K8sCostCategory,
  type K8sEfficiencyGranularity,
  type KubernetesEfficiencyConfig,
  type KubernetesEfficiencyCurrencyResult,
  type KubernetesEfficiencyFigures,
  type KubernetesEfficiencyReport,
  type KubernetesEfficiencyReportInput,
  type KubernetesEfficiencyResult,
  type KubernetesEfficiencyRow,
} from "@infrawrench/client-core";
import { useChartTheme } from "../chart-theme.js";
import { ShareDialog } from "../sharing/ShareDialog.js";
import { KubernetesEfficiencyEditor } from "./KubernetesEfficiencyEditor.js";
import { useK8sEfficiencyLabels } from "./labels.js";
import type { KubernetesEfficiencyClient } from "./types.js";

export interface KubernetesEfficiencyPanelProps {
  client: KubernetesEfficiencyClient;
  /** Which report to show; absent renders the list. Owned by the host (URL + tab). */
  reportId?: string | undefined;
  onSelectReport?: ((reportId: string | undefined) => void) | undefined;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Hand generated text to the browser's download path (Electron routes it to a save dialog). */
function saveTextFile(filename: string, mediaType: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const BIN_FOR: Record<K8sEfficiencyGranularity, CostBinningId> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
};

function toInput(report: KubernetesEfficiencyReport): KubernetesEfficiencyReportInput {
  return {
    name: report.name,
    ...(report.description ? { description: report.description } : {}),
    config: report.config,
    folderId: report.folderId,
  };
}

/**
 * Kubernetes efficiency reports: saved views over each cluster's derived cost
 * that say how much of the money bought capacity something used.
 *
 * The list files reports in the cost-report folders; a report's page draws
 * the usage-state split over time, the efficiency line, a per-category
 * breakdown and a table per group, and exports it as CSV. Every number comes
 * from the server's one scan and client-core's assembly, so this view, the
 * CLI and mobile always agree.
 */
export function KubernetesEfficiencyPanel({
  client,
  reportId,
  onSelectReport,
}: KubernetesEfficiencyPanelProps) {
  const gt = useGT();
  const [reports, setReports] = useState<KubernetesEfficiencyReport[] | null>(null);
  const [folders, setFolders] = useState<CostReportFolder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setReports(await client.listReports());
      setError(null);
    } catch (e: unknown) {
      setError(errorText(e));
    }
    if (client.listFolders) {
      // Folders only organise the list; a failure leaves it ungrouped.
      client
        .listFolders()
        .then(setFolders)
        .catch(() => {});
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (reportId) {
    return (
      <ReportDetail
        key={reportId}
        client={client}
        reportId={reportId}
        onBack={() => {
          onSelectReport?.(undefined);
          void refresh();
        }}
      />
    );
  }

  const createReport = client.createReport;
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  const grouped = new Map<string, KubernetesEfficiencyReport[]>();
  for (const r of reports ?? []) {
    const key = r.folderId && folderName.has(r.folderId) ? r.folderId : "";
    const list = grouped.get(key) ?? [];
    list.push(r);
    grouped.set(key, list);
  }
  const sections = [...grouped.entries()].sort(([a], [b]) =>
    a === "" ? 1 : b === "" ? -1 : (folderName.get(a) ?? "").localeCompare(folderName.get(b) ?? ""),
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6 flex flex-col gap-6">
        {error !== null && (
          <div role="alert" className="text-sm text-danger">
            {gt("Couldn’t load efficiency reports: {error}", { error })}{" "}
            <button type="button" onClick={() => void refresh()} className="underline">
              {gt("Retry")}
            </button>
          </div>
        )}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-on-surface">{gt("Kubernetes efficiency")}</h2>
            <p className="text-xs text-on-surface-faint mt-0.5 max-w-2xl">
              {gt(
                "How much of each cluster’s cost bought capacity that was actually used, by cluster, namespace, workload, label, node pool or cost category. Idle capacity and cluster overhead are named, never hidden.",
              )}
            </p>
          </div>
          {createReport && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              {gt("New report")}
            </button>
          )}
        </div>

        {reports === null && error === null && (
          <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
        )}
        {reports !== null && reports.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-6 text-sm text-on-surface-secondary">
            {gt(
              "No efficiency reports yet. Create one to see how much of your clusters’ cost is used, requested but unused, or idle.",
            )}
          </div>
        )}
        {sections.map(([folderId, list]) => (
          <section key={folderId || "unfiled"} className="flex flex-col gap-2">
            {sections.length > 1 && (
              <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-faint">
                {folderId ? folderName.get(folderId) : gt("Not in a folder")}
              </h3>
            )}
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {list.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onSelectReport?.(r.id)}
                    className="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left hover:bg-surface-sunken"
                  >
                    <span className="text-sm font-medium text-on-surface">{r.name}</span>
                    {r.description && (
                      <span className="text-xs text-on-surface-faint">{r.description}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {creating && createReport && (
        <KubernetesEfficiencyEditor
          client={client}
          existing={false}
          initial={{ name: "", config: DEFAULT_K8S_EFFICIENCY_CONFIG, folderId: null }}
          onClose={() => setCreating(false)}
          onSave={async (input) => {
            const created = await createReport(input);
            setCreating(false);
            await refresh();
            onSelectReport?.(created.id);
          }}
        />
      )}
    </div>
  );
}

function ReportDetail({
  client,
  reportId,
  onBack,
}: {
  client: KubernetesEfficiencyClient;
  reportId: string;
  onBack: () => void;
}) {
  const gt = useGT();
  const labels = useK8sEfficiencyLabels();
  const [report, setReport] = useState<KubernetesEfficiencyReport | null>(null);
  const [result, setResult] = useState<KubernetesEfficiencyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  /** A view-only category filter; null runs the report as saved. */
  const [viewCategories, setViewCategories] = useState<K8sCostCategory[] | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await client.getReport(reportId);
      setReport(next);
      if (viewCategories === null) {
        setResult((await client.runReport(reportId)).result);
      } else {
        const config: KubernetesEfficiencyConfig = { ...next.config };
        if (viewCategories.length > 0) config.categories = viewCategories;
        else delete config.categories;
        setResult(await client.query(config));
      }
      setError(null);
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [client, reportId, viewCategories]);

  useEffect(() => {
    void load();
  }, [load]);

  const block: KubernetesEfficiencyCurrencyResult | null = useMemo(() => {
    if (!result || result.currencies.length === 0) return null;
    return result.currencies.find((c) => c.currency === currency) ?? result.currencies[0]!;
  }, [result, currency]);

  async function remove() {
    if (!report || !client.deleteReport) return;
    if (!window.confirm(gt('Delete the efficiency report "{name}"?', { name: report.name })))
      return;
    try {
      await client.deleteReport(report.id);
      onBack();
    } catch (e: unknown) {
      setError(errorText(e));
    }
  }

  function download(perPeriod: boolean) {
    if (!report || !result) return;
    const slug =
      report.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "efficiency";
    saveTextFile(
      `${slug}-${result.from}-${result.to}${perPeriod ? "-by-period" : ""}.csv`,
      "text/csv",
      kubernetesEfficiencyCsv(result, { perPeriod }),
    );
  }

  const savedCategories = report?.config.categories ?? [];
  const activeCategories = viewCategories ?? savedCategories;
  const toggleViewCategory = (c: K8sCostCategory) => {
    const base = viewCategories ?? savedCategories;
    setViewCategories(base.includes(c) ? base.filter((x) => x !== c) : [...base, c]);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-6 flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <button
              type="button"
              onClick={onBack}
              className="text-xs text-on-surface-faint hover:text-on-surface"
            >
              {gt("← All efficiency reports")}
            </button>
            <h2 className="mt-1 text-base font-semibold text-on-surface">{report?.name ?? "…"}</h2>
            {report?.description && (
              <p className="text-xs text-on-surface-faint mt-0.5">{report.description}</p>
            )}
            {result && report && (
              <p className="text-xs text-on-surface-secondary mt-1">
                {gt("{from} to {to} · {granularity} · by {groupBy} · {idle} · {basis}", {
                  from: result.from,
                  to: result.to,
                  granularity: labels.granularity(result.granularity),
                  groupBy:
                    result.groupBy === "label" && result.groupByLabelKey
                      ? result.groupByLabelKey
                      : labels.groupBy(result.groupBy),
                  idle: result.idle === "spread" ? gt("idle spread") : gt("idle as its own rows"),
                  basis:
                    result.basis === "allocated"
                      ? gt("efficiency of allocated cost")
                      : gt("efficiency of total cost"),
                })}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-on-surface-secondary hover:text-on-surface disabled:opacity-50"
            >
              {loading ? gt("Refreshing…") : gt("Refresh")}
            </button>
            <button
              type="button"
              onClick={() => download(false)}
              disabled={!result}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-on-surface-secondary hover:text-on-surface disabled:opacity-50"
            >
              {gt("Download CSV")}
            </button>
            <button
              type="button"
              onClick={() => download(true)}
              disabled={!result}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-on-surface-secondary hover:text-on-surface disabled:opacity-50"
            >
              {gt("CSV by period")}
            </button>
            {client.sharing && report && (
              <button
                type="button"
                onClick={() => setSharing(true)}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-on-surface-secondary hover:text-on-surface"
              >
                {gt("Share")}
              </button>
            )}
            {client.updateReport && report && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-on-surface-secondary hover:text-on-surface"
              >
                {gt("Edit")}
              </button>
            )}
            {client.deleteReport && report && (
              <button
                type="button"
                onClick={() => void remove()}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-danger"
              >
                {gt("Delete")}
              </button>
            )}
          </div>
        </div>

        {error !== null && (
          <div role="alert" className="text-sm text-danger">
            {gt("Couldn’t run the report: {error}", { error })}
          </div>
        )}

        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">{gt("Cost categories shown")}</legend>
          <span className="text-xs text-on-surface-faint">{gt("Categories:")}</span>
          {K8S_COST_CATEGORIES.map((c) => (
            <label
              key={c}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-on-surface"
            >
              <input
                type="checkbox"
                checked={activeCategories.includes(c)}
                onChange={() => toggleViewCategory(c)}
                className="accent-blue-500"
              />
              {labels.category(c)}
            </label>
          ))}
          {viewCategories !== null && (
            <button
              type="button"
              onClick={() => setViewCategories(null)}
              className="text-xs underline text-on-surface-secondary"
            >
              {gt("Reset to saved")}
            </button>
          )}
        </fieldset>

        {result?.includesLegacyRows && (
          <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs text-on-surface-secondary">
            {gt(
              "Part of this window was collected before CPU, memory and usage were recorded separately. That cost shows as “CPU and memory (combined)” and counts as unmeasured.",
            )}
          </p>
        )}

        {result && result.currencies.length > 1 && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-on-surface-faint">{gt("Currency:")}</span>
            {result.currencies.map((c) => (
              <button
                key={c.currency}
                type="button"
                onClick={() => setCurrency(c.currency)}
                className={`rounded-md px-2 py-0.5 ${
                  block?.currency === c.currency
                    ? "bg-surface-sunken text-on-surface"
                    : "text-on-surface-faint"
                }`}
              >
                {c.currency}
              </button>
            ))}
          </div>
        )}

        {result && !block && (
          <div className="rounded-lg border border-dashed border-border p-6 text-sm text-on-surface-secondary">
            {gt(
              "No Kubernetes cost in this window. Cost appears once a connected cluster has node prices: from its cloud account, or typed on the Kubernetes account’s node rates field.",
            )}
          </div>
        )}

        {block && result && (
          <>
            <SummaryTiles block={block} />
            <UsageChart result={result} block={block} />
            <CategoryBreakdown block={block} />
            <RowsTable result={result} block={block} />
          </>
        )}
      </div>
      {editing && report && client.updateReport && (
        <KubernetesEfficiencyEditor
          client={client}
          existing
          initial={toInput(report)}
          onClose={() => setEditing(false)}
          onSave={async (input) => {
            await client.updateReport!(report.id, input);
            setEditing(false);
            setViewCategories(null);
            await load();
          }}
        />
      )}
      {sharing && report && client.sharing && (
        <ShareDialog
          client={client.sharing}
          target={{
            objectType: "kubernetes_efficiency_report",
            objectId: report.id,
            name: report.name,
          }}
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  );
}

function SummaryTiles({ block }: { block: KubernetesEfficiencyCurrencyResult }) {
  const gt = useGT();
  const t = block.totals;
  const money = (n: number) => formatMoney(n, block.currency);
  const tiles: Array<{ label: string; value: string; hint?: string | undefined }> = [
    { label: gt("Total cost"), value: money(t.total) },
    {
      label: gt("Efficiency"),
      value: formatKubernetesEfficiency(t.efficiency),
      hint:
        t.measuredShare !== null && t.measuredShare < 0.999
          ? gt("{share} of the cost was measured", {
              share: `${Math.round(t.measuredShare * 100)}%`,
            })
          : undefined,
    },
    { label: gt("Used"), value: money(t.used) },
    { label: gt("Requested, unused"), value: money(t.unused) },
    { label: gt("Idle"), value: money(t.idle) },
    { label: gt("Overhead"), value: money(t.overhead) },
    { label: gt("Unmeasured"), value: money(t.unmeasured) },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-lg border border-border px-3 py-2">
          <dt className="text-xs text-on-surface-faint">{tile.label}</dt>
          <dd className="text-base font-semibold text-on-surface tabular-nums">{tile.value}</dd>
          {tile.hint && <dd className="text-[11px] text-on-surface-faint">{tile.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

function UsageChart({
  result,
  block,
}: {
  result: KubernetesEfficiencyResult;
  block: KubernetesEfficiencyCurrencyResult;
}) {
  const gt = useGT();
  const labels = useK8sEfficiencyLabels();
  const chart = useChartTheme();
  const bin = BIN_FOR[result.granularity];
  const byBucket = new Map(block.points.map((p) => [p.bucket, p]));
  const data = result.buckets.map((bucket) => {
    const p = byBucket.get(bucket);
    return {
      bucket,
      used: p?.used ?? 0,
      unused: p?.unused ?? 0,
      unmeasured: p?.unmeasured ?? 0,
      idle: p?.idle ?? 0,
      overhead: p?.overhead ?? 0,
      efficiency: p?.efficiency == null ? null : Math.round(p.efficiency * 1000) / 10,
    };
  });
  const tooltipStyle = {
    backgroundColor: chart.tooltipBg,
    border: `1px solid ${chart.tooltipBorder}`,
    borderRadius: 8,
    fontSize: 12,
  };
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-xs font-medium text-on-surface-secondary">
        {gt("Cost by usage, with efficiency")}
      </figcaption>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
            <XAxis
              dataKey="bucket"
              tickFormatter={(b: string) => formatBucketLabel(b, bin)}
              tick={{ fill: chart.tick, fontSize: 11 }}
              stroke={chart.axis}
              minTickGap={24}
            />
            <YAxis
              yAxisId="money"
              tick={{ fill: chart.tick, fontSize: 11 }}
              stroke={chart.axis}
              tickFormatter={(v: number) => formatMoney(v, block.currency)}
              width={70}
            />
            <YAxis
              yAxisId="pct"
              orientation="right"
              domain={[0, 100]}
              tick={{ fill: chart.tick, fontSize: 11 }}
              stroke={chart.axis}
              tickFormatter={(v: number) => `${v}%`}
              width={40}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={(b) => formatBucketLabel(String(b), bin)}
              formatter={(value, name) =>
                name === gt("Efficiency")
                  ? [value == null ? "n/a" : `${String(value)}%`, name]
                  : [formatMoney(Number(value), block.currency), name]
              }
            />
            {K8S_USAGE_STATES.map((s) => (
              <Bar
                key={s}
                yAxisId="money"
                dataKey={s}
                name={labels.state(s)}
                stackId="usage"
                fill={K8S_USAGE_STATE_COLORS[s]}
                isAnimationActive={false}
              />
            ))}
            <Line
              yAxisId="pct"
              dataKey="efficiency"
              name={gt("Efficiency")}
              stroke={chart.tick}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap gap-3 text-xs text-on-surface-secondary">
        {K8S_USAGE_STATES.map((s) => (
          <li key={s} className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: K8S_USAGE_STATE_COLORS[s] }}
            />
            {labels.state(s)}
          </li>
        ))}
      </ul>
    </figure>
  );
}

function CategoryBreakdown({ block }: { block: KubernetesEfficiencyCurrencyResult }) {
  const gt = useGT();
  const labels = useK8sEfficiencyLabels();
  if (block.categories.length === 0) return null;
  const total = block.totals.total || 1;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-on-surface-secondary">{gt("By cost category")}</h3>
      <ul className="flex flex-col gap-1.5">
        {block.categories.map(({ category, figures }) => (
          <li
            key={category}
            className="grid grid-cols-[10rem_1fr_6rem_4rem] items-center gap-3 text-xs"
          >
            <span className="text-on-surface">{labels.category(category)}</span>
            <StateBar figures={figures} scale={figures.total / total} />
            <span className="text-right tabular-nums text-on-surface">
              {formatMoney(figures.total, block.currency)}
            </span>
            <span className="text-right tabular-nums text-on-surface-secondary">
              {formatKubernetesEfficiency(figures.efficiency)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StateBar({ figures, scale }: { figures: KubernetesEfficiencyFigures; scale: number }) {
  const labels = useK8sEfficiencyLabels();
  const width = Math.max(0, Math.min(1, scale)) * 100;
  const total = figures.total || 1;
  return (
    <div className="h-2.5 w-full rounded-sm bg-surface-sunken">
      <div className="flex h-full overflow-hidden rounded-sm" style={{ width: `${width}%` }}>
        {K8S_USAGE_STATES.map((s) =>
          figures[s] > 0 ? (
            <span
              key={s}
              title={labels.state(s)}
              style={{
                width: `${(figures[s] / total) * 100}%`,
                backgroundColor: K8S_USAGE_STATE_COLORS[s],
              }}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

function RowsTable({
  result,
  block,
}: {
  result: KubernetesEfficiencyResult;
  block: KubernetesEfficiencyCurrencyResult;
}) {
  const gt = useGT();
  const labels = useK8sEfficiencyLabels();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const money = (n: number) => formatMoney(n, block.currency);
  const nameOf = (row: KubernetesEfficiencyRow) => labels.rowKind(row.kind) ?? row.label;
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const cells = (f: KubernetesEfficiencyFigures) => (
    <>
      <td className="px-3 py-1.5 text-right tabular-nums">{money(f.total)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums">{money(f.used)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums">{money(f.unused)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums">{money(f.unmeasured)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums">{money(f.idle)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums">{money(f.overhead)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums font-medium">
        {formatKubernetesEfficiency(f.efficiency)}
      </td>
    </>
  );
  const groupHeading =
    result.groupBy === "label" && result.groupByLabelKey
      ? result.groupByLabelKey
      : labels.groupBy(result.groupBy);
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-xs text-on-surface">
        <thead className="bg-surface-sunken text-on-surface-secondary">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {groupHeading}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {gt("Total")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {gt("Used")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {gt("Requested, unused")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {gt("Unmeasured")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {gt("Idle")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {gt("Overhead")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {gt("Efficiency")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {block.rows.map((row) => (
            <Fragment key={row.key}>
              <tr>
                <th scope="row" className="px-3 py-1.5 text-left font-normal">
                  <button
                    type="button"
                    onClick={() => toggle(row.key)}
                    aria-expanded={expanded.has(row.key)}
                    className={`text-left hover:underline ${row.kind !== "group" ? "italic text-on-surface-secondary" : ""}`}
                  >
                    {nameOf(row)}
                  </button>
                </th>
                {cells(row.figures)}
              </tr>
              {expanded.has(row.key) &&
                row.categories.map(({ category, figures }) => (
                  <tr
                    key={`${row.key}:${category}`}
                    className="bg-surface-sunken/40 text-on-surface-secondary"
                  >
                    <th scope="row" className="py-1 pl-8 pr-3 text-left font-normal">
                      {labels.category(category)}
                    </th>
                    {cells(figures)}
                  </tr>
                ))}
            </Fragment>
          ))}
          <tr className="bg-surface-sunken font-medium">
            <th scope="row" className="px-3 py-1.5 text-left">
              {gt("Total")}
            </th>
            {cells(block.totals)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
