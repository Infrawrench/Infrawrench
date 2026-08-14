import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import type { MetricSeries } from "@infrawrench/plugin-base";
import { formatUptime, type SyntheticProbe } from "@infrawrench/client-core";
import { MetricChart } from "../components/charts/MetricChart.js";
import { SparklineChart } from "../components/charts/SparklineChart.js";
import { ProbeEditorModal } from "./ProbeEditorModal.js";
import type { ProbesClient } from "./types.js";

export interface ProbesPanelProps {
  client: ProbesClient;
  /**
   * Declare an incident from a probe, seeded with the probe's name, its last
   * error and the moment it went down. Optional: a host with no incidents
   * surface (or a caller without `incidents:write`) omits it and the button
   * disappears.
   *
   * A down probe is one of the two places an incident actually starts — the
   * button only renders on probes that are currently down, because offering it
   * on a green one is noise.
   */
  onDeclareIncident?: (seed: {
    title: string;
    summary?: string;
    resourceIds?: string[];
    startedAt?: string;
  }) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function statusDotClass(probe: SyntheticProbe): string {
  if (!probe.enabled) return "bg-neutral-500";
  switch (probe.status) {
    case "up":
      return "bg-emerald-500";
    case "down":
      return "bg-red-500";
    default:
      return "bg-amber-500";
  }
}

function statusTitle(probe: SyntheticProbe, gt: ReturnType<typeof useGT>): string {
  if (!probe.enabled) return gt("Disabled");
  switch (probe.status) {
    case "up":
      return gt("Up");
    case "down":
      return gt("Down");
    default:
      return gt("No results yet");
  }
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Synthetic probes: uptime/latency checks against endpoints, run on an
 * interval from outside the cluster. Shared between web and desktop; write
 * actions are gated on the client exposing the write methods (the
 * `MetricAlertsPanel` convention). A row expands into the recorded latency
 * chart, read from the same metric store the plugin charts use.
 */
export function ProbesPanel({ client, onDeclareIncident }: ProbesPanelProps) {
  const gt = useGT();
  // null = loading, [] = loaded-empty.
  const [probes, setProbes] = useState<SyntheticProbe[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ existing: SyntheticProbe | null } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Per-probe fetched series; undefined = not fetched, null = fetch failed.
  const [seriesById, setSeriesById] = useState<Record<string, MetricSeries[] | null>>({});

  const canWrite = Boolean(client.createProbe && client.updateProbe && client.deleteProbe);

  const reload = useCallback(() => {
    setError(null);
    client
      .listProbes()
      .then(setProbes)
      .catch((e) => setError(e instanceof Error ? e.message : gt("Failed to load probes")));
  }, [client]);

  useEffect(() => {
    reload();
  }, [reload]);

  const loadSeries = useCallback(
    (probeId: string) => {
      const endMs = Date.now();
      client
        .probeMetrics(probeId, { startMs: endMs - DAY_MS, endMs })
        .then((series) => setSeriesById((prev) => ({ ...prev, [probeId]: series })))
        .catch(() => setSeriesById((prev) => ({ ...prev, [probeId]: null })));
    },
    [client],
  );

  const toggleExpanded = (probe: SyntheticProbe) => {
    const next = expandedId === probe.id ? null : probe.id;
    setExpandedId(next);
    if (next !== null && seriesById[probe.id] === undefined) loadSeries(probe.id);
  };

  const toggleEnabled = async (probe: SyntheticProbe) => {
    try {
      await client.updateProbe?.(probe.id, { enabled: !probe.enabled });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to update the probe"));
    }
  };

  const remove = async (probe: SyntheticProbe) => {
    if (!window.confirm(gt('Delete probe "{name}"?', { name: probe.name }))) return;
    try {
      await client.deleteProbe?.(probe.id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to delete the probe"));
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-base font-semibold text-on-surface">{gt("Synthetic probes")}</h2>
            <p className="text-xs text-on-surface-faint">
              {gt(
                "Uptime and latency checks run on an interval from outside your infrastructure — the view your users get. Alerts fire after consecutive failures.",
              )}
            </p>
          </div>
          {canWrite && (
            <button
              type="button"
              onClick={() => setEditing({ existing: null })}
              className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              {gt("New probe")}
            </button>
          )}
        </div>

        {error && (
          <p className="text-sm text-danger">
            {error}{" "}
            <button type="button" onClick={reload} className="underline hover:text-danger">
              {gt("Retry")}
            </button>
          </p>
        )}
        {probes === null && !error && (
          <p className="text-sm text-on-surface-faint">{gt("Loading probes…")}</p>
        )}
        {probes !== null && probes.length === 0 && (
          <p className="text-sm text-on-surface-faint">
            {gt(
              "No probes yet. Create one to watch an endpoint from the outside — the editor suggests URLs from your synced resources.",
            )}
          </p>
        )}

        {probes !== null && probes.length > 0 && (
          <ul className="space-y-2">
            {probes.map((probe) => {
              const expanded = expandedId === probe.id;
              const series = seriesById[probe.id];
              const latency = series?.find((s) => s.label === "Latency");
              return (
                <li
                  key={probe.id}
                  className="rounded-xl border border-border bg-surface-raised px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(probe)}
                      aria-expanded={expanded}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${statusDotClass(probe)}`}
                          title={statusTitle(probe, gt)}
                        />
                        <span className="text-sm font-medium text-on-surface truncate">
                          {probe.name}
                        </span>
                        {probe.status === "down" && (
                          <span className="text-xs text-danger">
                            {gt("down")}
                            {probe.lastError ? gt(" · {error}", { error: probe.lastError }) : ""}
                          </span>
                        )}
                        {!probe.enabled && (
                          <span className="text-xs text-on-surface-faint">{gt("disabled")}</span>
                        )}
                      </div>
                      <p className="text-xs text-on-surface-secondary truncate">
                        {probe.method} {probe.url}{" "}
                        {gt("· every {interval}s", { interval: probe.intervalSeconds })}
                        {probe.uptime24h !== null &&
                          gt(" · {uptime} uptime (24h)", { uptime: formatUptime(probe.uptime24h) })}
                        {probe.lastLatencyMs !== null &&
                          gt(" · {latency}ms", { latency: probe.lastLatencyMs })}
                        {probe.lastProbeAt !== null &&
                          gt(" · checked {when}", { when: formatWhen(probe.lastProbeAt) })}
                      </p>
                    </button>
                    {latency !== undefined && !expanded && (
                      <SparklineChart
                        points={latency.points}
                        label={gt("{name} latency", { name: probe.name })}
                      />
                    )}
                    {onDeclareIncident && probe.status === "down" && probe.enabled && (
                      <button
                        type="button"
                        onClick={() =>
                          onDeclareIncident({
                            title: gt("{name} is down", { name: probe.name }),
                            ...(probe.lastError ? { summary: probe.lastError } : {}),
                            ...(probe.resourceId ? { resourceIds: [probe.resourceId] } : {}),
                            ...(probe.lastStateChangeAt
                              ? { startedAt: probe.lastStateChangeAt }
                              : {}),
                          })
                        }
                        className="shrink-0 px-2 py-1 rounded-lg text-xs text-danger hover:bg-surface-sunken transition-colors"
                      >
                        {gt("Declare incident")}
                      </button>
                    )}
                    {canWrite && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => void toggleEnabled(probe)}
                          className="px-2 py-1 rounded-lg text-xs text-on-surface-secondary hover:bg-surface-sunken transition-colors"
                        >
                          {probe.enabled ? gt("Disable") : gt("Enable")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing({ existing: probe })}
                          className="px-2 py-1 rounded-lg text-xs text-on-surface-secondary hover:bg-surface-sunken transition-colors"
                        >
                          {gt("Edit")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(probe)}
                          className="px-2 py-1 rounded-lg text-xs text-danger hover:bg-surface-sunken transition-colors"
                        >
                          {gt("Delete")}
                        </button>
                      </div>
                    )}
                  </div>

                  {expanded && (
                    <div className="mt-3 border-t border-border pt-3">
                      {series === undefined && (
                        <p className="text-sm text-on-surface-faint">{gt("Loading history…")}</p>
                      )}
                      {series === null && (
                        <p className="text-sm text-on-surface-faint">
                          {gt(
                            "No history available — the metric store is unreachable or the probe hasn't produced results yet.",
                          )}
                        </p>
                      )}
                      {series && latency && latency.points.length > 0 ? (
                        <MetricChart
                          node={{
                            kind: "metric-chart",
                            title: gt("Latency"),
                            series: [latency],
                            timeRangeLabel: gt("Last 24 hours, probed from the edge"),
                          }}
                        />
                      ) : (
                        series !== undefined &&
                        series !== null && (
                          <p className="text-sm text-on-surface-faint">
                            {gt("No latency samples in the last 24 hours.")}
                          </p>
                        )
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {editing && (
        <ProbeEditorModal
          client={client}
          existing={editing.existing}
          onSaved={() => reload()}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
