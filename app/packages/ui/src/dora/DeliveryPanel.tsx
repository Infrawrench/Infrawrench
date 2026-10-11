import { useCallback, useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import type { MetricSeries } from "@infrawrench/plugin-base";
import {
  DORA_RANGE_DAYS,
  doraRangeForDays,
  doraTrendDirection,
  formatDeployFrequency,
  formatDoraHours,
  formatDoraRate,
  type DoraBand,
  type DoraChange,
  type DoraMetric,
  type DoraQuery,
  type DoraReport,
  type DoraRestore,
  type DoraSummary,
} from "@infrawrench/client-core";
import { MetricChart } from "../components/charts/MetricChart.js";
import { useDataString } from "../i18n/data-strings.js";
import { DoraSettingsModal } from "./DoraSettingsModal.js";
import type { DoraClient } from "./types.js";

export interface DeliveryPanelProps {
  client: DoraClient;
  /**
   * Open a deploy's link. Desktop passes its `openExternal`; without it links
   * render as ordinary anchors opening a new tab.
   */
  onOpenUrl?: ((url: string) => void) | undefined;
}

type Gt = ReturnType<typeof useGT>;

/** The "not known" scope value's sentinel in a `<select>`. */
const NONE = "\u0000none";

export function doraBandLabel(band: DoraBand | null, gt: Gt): string {
  switch (band) {
    case "elite":
      return gt("Elite");
    case "high":
      return gt("High");
    case "medium":
      return gt("Medium");
    case "low":
      return gt("Low");
    case null:
      return gt("Not enough data");
  }
}

function bandClass(band: DoraBand | null): string {
  switch (band) {
    case "elite":
      return "bg-success/15 text-success";
    case "high":
      return "bg-blue-500/15 text-blue-500";
    case "medium":
      return "bg-warning/15 text-warning";
    case "low":
      return "bg-danger/15 text-danger";
    case null:
      return "bg-surface-sunken text-on-surface-faint";
  }
}

/** A dimension's label: built-ins translated here, registered ones through the data-string lookup. */
function useDimensionLabel(): (id: string, fallback: string) => string {
  const gt = useGT();
  const data = useDataString();
  return useCallback(
    (id: string, fallback: string) => {
      switch (id) {
        case "environment":
          return gt("Environment");
        case "repository":
          return gt("Repository");
        case "owner":
          return gt("Owner");
        default:
          return data(fallback);
      }
    },
    [gt, data],
  );
}

function BandChip({ band }: { band: DoraBand | null }) {
  const gt = useGT();
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${bandClass(band)}`}
    >
      {doraBandLabel(band, gt)}
    </span>
  );
}

function Delta({
  metric,
  current,
  previous,
}: {
  metric: DoraMetric;
  current: number | null;
  previous: number | null;
}) {
  const gt = useGT();
  const dir = doraTrendDirection(metric, current, previous);
  if (dir === null) return null;
  const text =
    dir === "flat"
      ? gt("Same as the previous period")
      : dir === "better"
        ? gt("Better than the previous period")
        : gt("Worse than the previous period");
  const tone =
    dir === "flat" ? "text-on-surface-faint" : dir === "better" ? "text-success" : "text-danger";
  return <p className={`text-[11px] ${tone}`}>{text}</p>;
}

function Tile({
  title,
  value,
  detail,
  band,
  delta,
}: {
  title: string;
  value: string;
  detail: string;
  band: DoraBand | null;
  delta: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-raised p-4 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-on-surface-secondary">{title}</h3>
        <BandChip band={band} />
      </div>
      <p className="text-2xl font-semibold text-on-surface tabular-nums">{value}</p>
      <p className="text-[11px] text-on-surface-faint">{detail}</p>
      {delta}
    </div>
  );
}

function SummaryTiles({ summary, previous }: { summary: DoraSummary; previous: DoraSummary }) {
  const gt = useGT();
  const df = summary.deploymentFrequency;
  const lt = summary.leadTime;
  const cfr = summary.changeFailureRate;
  const ttr = summary.timeToRestore;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      <Tile
        title={gt("Deployment frequency")}
        value={df.deploys > 0 ? formatDeployFrequency(df.value) : gt("None")}
        detail={gt("{count} production deploys", { count: df.deploys })}
        band={df.band}
        delta={
          <Delta
            metric="deployment_frequency"
            current={df.value}
            previous={previous.deploymentFrequency.value}
          />
        }
      />
      <Tile
        title={gt("Lead time for changes")}
        value={formatDoraHours(lt.value)}
        detail={
          lt.sample > 0
            ? gt("Median of {count} deploys with a known commit time; p90 {p90}", {
                count: lt.sample,
                p90: formatDoraHours(lt.p90Hours),
              })
            : gt("No deploy named a commit whose time is known")
        }
        band={lt.band}
        delta={<Delta metric="lead_time" current={lt.value} previous={previous.leadTime.value} />}
      />
      <Tile
        title={gt("Change failure rate")}
        value={formatDoraRate(cfr.value)}
        detail={gt("{failures} of {changes} changes failed", {
          failures: cfr.failures,
          changes: cfr.changes,
        })}
        band={cfr.band}
        delta={
          <Delta
            metric="change_failure_rate"
            current={cfr.value}
            previous={previous.changeFailureRate.value}
          />
        }
      />
      <Tile
        title={gt("Time to restore")}
        value={formatDoraHours(ttr.value)}
        detail={gt("Median of {count} recoveries", { count: ttr.restores })}
        band={ttr.band}
        delta={
          <Delta
            metric="time_to_restore"
            current={ttr.value}
            previous={previous.timeToRestore.value}
          />
        }
      />
    </div>
  );
}

function TrendCharts({ report }: { report: DoraReport }) {
  const gt = useGT();
  const points = (pick: (b: DoraReport["trend"][number]) => number | null) =>
    report.trend.flatMap((b) => {
      const v = pick(b);
      return v === null ? [] : [{ timestamp: Date.parse(b.start), value: v }];
    });
  const rangeLabel =
    report.bucket === "week" ? gt("Per week, production only") : gt("Per day, production only");
  const deploys: MetricSeries[] = [{ label: gt("Deploys"), points: points((b) => b.deploys) }];
  const failure: MetricSeries[] = [
    {
      label: gt("Change failure rate"),
      unit: "%",
      points: points((b) => (b.changeFailureRate === null ? null : b.changeFailureRate * 100)),
    },
  ];
  const hours: MetricSeries[] = [
    { label: gt("Lead time (hours)"), unit: "h", points: points((b) => b.leadTimeMedianHours) },
    {
      label: gt("Time to restore (hours)"),
      unit: "h",
      points: points((b) => b.restoreMedianHours),
    },
  ].filter((s) => s.points.length > 0);
  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <MetricChart
        node={{
          kind: "metric-chart",
          title: gt("Deploys"),
          series: deploys,
          timeRangeLabel: rangeLabel,
        }}
      />
      {failure[0]!.points.length > 0 && (
        <MetricChart
          node={{
            kind: "metric-chart",
            title: gt("Change failure rate"),
            series: failure,
            timeRangeLabel: rangeLabel,
          }}
        />
      )}
      {hours.length > 0 && (
        <MetricChart
          node={{
            kind: "metric-chart",
            title: gt("Lead time and time to restore"),
            series: hours,
            timeRangeLabel: gt("Medians, hours"),
          }}
        />
      )}
    </div>
  );
}

function BreakdownTable({
  report,
  onPick,
}: {
  report: DoraReport;
  onPick: (key: string | null) => void;
}) {
  const gt = useGT();
  if (report.breakdown.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-surface-sunken text-xs text-on-surface-secondary">
          <tr>
            <th className="text-left px-3 py-2 font-medium">{gt("Scope")}</th>
            <th className="text-right px-3 py-2 font-medium">{gt("Deploys")}</th>
            <th className="text-right px-3 py-2 font-medium">{gt("Frequency")}</th>
            <th className="text-right px-3 py-2 font-medium">{gt("Lead time")}</th>
            <th className="text-right px-3 py-2 font-medium">{gt("Failure rate")}</th>
            <th className="text-right px-3 py-2 font-medium">{gt("Restore")}</th>
          </tr>
        </thead>
        <tbody>
          {report.breakdown.map((row) => (
            <tr key={row.key ?? NONE} className="border-t border-border">
              <td className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => onPick(row.key)}
                  className="text-left text-blue-500 hover:underline"
                >
                  {row.key === null ? gt("Not known") : row.label}
                </button>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {row.summary.deploymentFrequency.deploys}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatDeployFrequency(row.summary.deploymentFrequency.value)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatDoraHours(row.summary.leadTime.value)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatDoraRate(row.summary.changeFailureRate.value)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatDoraHours(row.summary.timeToRestore.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExternalLink({
  url,
  label,
  onOpenUrl,
}: {
  url: string;
  label: string;
  onOpenUrl?: ((url: string) => void) | undefined;
}) {
  if (onOpenUrl) {
    return (
      <button
        type="button"
        onClick={() => onOpenUrl(url)}
        className="text-blue-500 hover:underline"
      >
        {label}
      </button>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">
      {label}
    </a>
  );
}

function failureText(change: DoraChange, gt: Gt): string | null {
  const f = change.failure;
  if (!f) return null;
  switch (f.kind) {
    case "incident":
      return gt("Incident: {title}", { title: f.title });
    case "rollback":
      return gt("Rolled back by {name}", { name: f.title });
    case "failed_deploy":
      return gt("The deploy failed");
    case "reverted":
      return gt("Reverted from the change timeline");
  }
}

function ChangeRow({
  change,
  onOpenUrl,
}: {
  change: DoraChange;
  onOpenUrl?: ((url: string) => void) | undefined;
}) {
  const gt = useGT();
  const failure = failureText(change, gt);
  return (
    <li className="px-3 py-2 border-t border-border first:border-t-0 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-on-surface">{change.name}</span>
        {change.environment && (
          <span className="text-xs text-on-surface-secondary">{change.environment}</span>
        )}
        {change.commitSha && (
          <code className="text-xs text-on-surface-faint">{change.commitSha.slice(0, 7)}</code>
        )}
        {change.isRollback && (
          <span className="text-[11px] rounded-full px-2 py-0.5 bg-warning/15 text-warning">
            {gt("Rollback")}
          </span>
        )}
        {change.type === "resource_change" && (
          <span className="text-[11px] text-on-surface-faint">{gt("Resource change")}</span>
        )}
        <span className="ml-auto text-xs text-on-surface-faint tabular-nums">
          {new Date(change.at).toLocaleString()}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 text-xs text-on-surface-secondary mt-0.5">
        {change.leadTimeHours !== null && (
          <span>
            {gt("Lead time {duration}", { duration: formatDoraHours(change.leadTimeHours) })}
          </span>
        )}
        {failure && <span className="text-danger">{failure}</span>}
        {change.url && <ExternalLink url={change.url} label={gt("Open")} onOpenUrl={onOpenUrl} />}
      </div>
    </li>
  );
}

function RestoreRow({ restore }: { restore: DoraRestore }) {
  const gt = useGT();
  return (
    <li className="px-3 py-2 border-t border-border first:border-t-0 text-sm flex flex-wrap items-center gap-x-3">
      <span className="font-medium text-on-surface">{restore.title}</span>
      <span className="text-xs text-on-surface-secondary">
        {restore.kind === "incident" ? gt("Incident resolved") : gt("Rolled back")}
      </span>
      <span className="text-xs tabular-nums">
        {gt("Restored in {duration}", { duration: formatDoraHours(restore.hours) })}
      </span>
      <span className="ml-auto text-xs text-on-surface-faint tabular-nums">
        {new Date(restore.restoredAt).toLocaleString()}
      </span>
    </li>
  );
}

function DrillDown({
  client,
  query,
  onOpenUrl,
}: {
  client: DoraClient;
  query: DoraQuery;
  onOpenUrl?: ((url: string) => void) | undefined;
}) {
  const gt = useGT();
  const [tab, setTab] = useState<"changes" | "restores">("changes");
  const [failedOnly, setFailedOnly] = useState(false);
  const [changes, setChanges] = useState<{ list: DoraChange[]; truncated: boolean } | null>(null);
  const [restores, setRestores] = useState<DoraRestore[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (tab === "changes") {
      setChanges(null);
      client
        .listChanges({ ...query, failedOnly })
        .then((r) => !cancelled && setChanges({ list: r.changes, truncated: r.truncated }))
        .catch(
          (e) =>
            !cancelled && setError(e instanceof Error ? e.message : gt("Failed to load changes")),
        );
    } else {
      setRestores(null);
      client
        .listRestores(query)
        .then((r) => !cancelled && setRestores(r.restores))
        .catch(
          (e) =>
            !cancelled &&
            setError(e instanceof Error ? e.message : gt("Failed to load recoveries")),
        );
    }
    return () => {
      cancelled = true;
    };
  }, [client, query, tab, failedOnly, gt]);

  const tabClass = (active: boolean) =>
    `px-3 py-1.5 text-sm rounded-lg ${active ? "bg-surface-sunken text-on-surface" : "text-on-surface-secondary hover:text-on-surface"}`;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "changes"}
          className={tabClass(tab === "changes")}
          onClick={() => setTab("changes")}
        >
          {gt("Changes")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "restores"}
          className={tabClass(tab === "restores")}
          onClick={() => setTab("restores")}
        >
          {gt("Recoveries")}
        </button>
        {tab === "changes" && (
          <label className="ml-auto flex items-center gap-2 text-xs text-on-surface-secondary">
            <input
              type="checkbox"
              checked={failedOnly}
              onChange={(e) => setFailedOnly(e.target.checked)}
            />
            {gt("Failed changes only")}
          </label>
        )}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {tab === "changes" &&
        (changes === null ? (
          !error && <p className="text-sm text-on-surface-faint">{gt("Loading changes…")}</p>
        ) : changes.list.length === 0 ? (
          <p className="text-sm text-on-surface-faint">
            {gt("No production changes in this range.")}
          </p>
        ) : (
          <>
            <ul className="rounded-xl border border-border">
              {changes.list.map((c) => (
                <ChangeRow key={c.id} change={c} onOpenUrl={onOpenUrl} />
              ))}
            </ul>
            {changes.truncated && (
              <p className="text-xs text-on-surface-faint">
                {gt("Showing the newest {count}. Narrow the range or the scope to see the rest.", {
                  count: changes.list.length,
                })}
              </p>
            )}
          </>
        ))}
      {tab === "restores" &&
        (restores === null ? (
          !error && <p className="text-sm text-on-surface-faint">{gt("Loading recoveries…")}</p>
        ) : restores.length === 0 ? (
          <p className="text-sm text-on-surface-faint">
            {gt("No incidents resolved or deploys rolled back in this range.")}
          </p>
        ) : (
          <ul className="rounded-xl border border-border">
            {restores.map((r) => (
              <RestoreRow key={`${r.kind}:${r.id}`} restore={r} />
            ))}
          </ul>
        ))}
    </section>
  );
}

/**
 * Delivery: the four DORA metrics for production, with bands, deltas against
 * the previous period, trends, a breakdown by any scope dimension, and the
 * changes and recoveries behind every number. Shared between web and desktop.
 */
export function DeliveryPanel({ client, onOpenUrl }: DeliveryPanelProps) {
  const gt = useGT();
  const dimensionLabel = useDimensionLabel();
  const [days, setDays] = useState(30);
  const [dimension, setDimension] = useState<string>("");
  const [value, setValue] = useState<string>(NONE);
  const [groupBy, setGroupBy] = useState("environment");
  const [report, setReport] = useState<DoraReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [nonce, setNonce] = useState(0);

  // The window is fixed when the inputs change, not on every render, so the
  // drill-down's query is stable and does not refetch in a loop.
  const query = useMemo<DoraQuery>(() => {
    const range = doraRangeForDays(days);
    return {
      ...range,
      ...(dimension ? { dimension, value: value === NONE ? null : value } : {}),
      groupBy,
    };
    // `nonce` re-anchors the window to now on a manual refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, dimension, value, groupBy, nonce]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    client
      .getReport(query)
      .then((r) => !cancelled && setReport(r))
      .catch(
        (e) =>
          !cancelled &&
          setError(e instanceof Error ? e.message : gt("Failed to load delivery metrics")),
      );
    return () => {
      cancelled = true;
    };
  }, [client, query, gt]);

  const dimensions = report?.dimensions ?? [];
  const values = dimension ? (report?.scopeValues[dimension] ?? []) : [];
  const empty =
    report !== null && report.eventCount === 0 && report.summary.changeFailureRate.changes === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-on-surface">{gt("Delivery")}</h2>
          <p className="text-xs text-on-surface-faint max-w-2xl">
            {gt(
              "The four DORA metrics for production: how often you deploy, how long a commit takes to reach production, how often a change causes a failure, and how fast you recover.",
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="dora-range">
            {gt("Range")}
          </label>
          <select
            id="dora-range"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
          >
            {DORA_RANGE_DAYS.map((d) => (
              <option key={d} value={d}>
                {gt("Last {days} days", { days: d })}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            className="px-3 py-1.5 rounded-lg text-sm border border-border hover:bg-surface-sunken"
          >
            {gt("Refresh")}
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="px-3 py-1.5 rounded-lg text-sm border border-border hover:bg-surface-sunken"
          >
            {gt("Settings")}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="dora-scope-dimension" className="text-on-surface-secondary">
          {gt("Scope")}
        </label>
        <select
          id="dora-scope-dimension"
          value={dimension}
          onChange={(e) => {
            setDimension(e.target.value);
            setValue(NONE);
          }}
          className="rounded-lg border border-border bg-surface px-2 py-1.5"
        >
          <option value="">{gt("All production")}</option>
          {dimensions.map((d) => (
            <option key={d.id} value={d.id}>
              {dimensionLabel(d.id, d.label)}
            </option>
          ))}
        </select>
        {dimension && (
          <select
            aria-label={gt("Scope value")}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="rounded-lg border border-border bg-surface px-2 py-1.5"
          >
            <option value={NONE}>{gt("Not known")}</option>
            {values.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <p className="text-sm text-danger">
          {error}{" "}
          <button type="button" onClick={() => setNonce((n) => n + 1)} className="underline">
            {gt("Retry")}
          </button>
        </p>
      )}

      {report === null && !error && (
        <p className="text-sm text-on-surface-faint">{gt("Loading delivery metrics…")}</p>
      )}

      {report && empty && (
        <div className="rounded-xl border border-dashed border-border p-6 text-sm text-on-surface-secondary space-y-2">
          <p>{gt("No deploys in this range yet.")}</p>
          <p className="text-xs text-on-surface-faint">
            {gt(
              "Delivery metrics come from Infrawrench deploys, deploys your connected providers already sync (Vercel, Netlify, Render, Railway, Koyeb, Heroku, Pulumi, Spacelift, HCP Terraform), CI pipelines named as deploys in the settings (Buildkite, CircleCI, GitLab, Bitbucket), GitHub deployments through the GitHub App, and deploys recorded over the API. Failures come from declared incidents and rollbacks.",
            )}
          </p>
        </div>
      )}

      {report && !empty && (
        <>
          <SummaryTiles summary={report.summary} previous={report.previous} />
          <TrendCharts report={report} />
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <h3 className="font-medium text-on-surface">{gt("Breakdown")}</h3>
              <label className="sr-only" htmlFor="dora-group-by">
                {gt("Group by")}
              </label>
              <select
                id="dora-group-by"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value)}
                className="rounded-lg border border-border bg-surface px-2 py-1"
              >
                {dimensions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {gt("By {dimension}", { dimension: dimensionLabel(d.id, d.label) })}
                  </option>
                ))}
              </select>
            </div>
            <BreakdownTable
              report={report}
              onPick={(key) => {
                setDimension(groupBy);
                setValue(key ?? NONE);
              }}
            />
          </section>
        </>
      )}

      {report && <DrillDown client={client} query={query} onOpenUrl={onOpenUrl} />}

      {settingsOpen && (
        <DoraSettingsModal
          client={client}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => setNonce((n) => n + 1)}
        />
      )}
    </div>
  );
}
