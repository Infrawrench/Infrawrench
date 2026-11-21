import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import { heartbeatScheduleOf, type Heartbeat, type HeartbeatPing } from "@infrawrench/client-core";
import { MetricChart } from "../components/charts/MetricChart.js";
import { IssueIndicator } from "../components/IssueIndicator.js";
import { HeartbeatEditorModal } from "./HeartbeatEditorModal.js";
import { PingInstructions } from "./PingInstructions.js";
import { formatDuration, formatWhen, scheduleLabel, statusLabel } from "./format.js";
import type { HeartbeatsClient } from "./types.js";

export interface HeartbeatsPanelProps {
  client: HeartbeatsClient;
  /**
   * Declare an incident from a down heartbeat, seeded with its name and the
   * moment it went down. Optional: the probes panel's convention.
   */
  onDeclareIncident?: (seed: {
    title: string;
    summary?: string;
    resourceIds?: string[];
    startedAt?: string;
  }) => void;
}

function statusTone(heartbeat: Heartbeat): string {
  if (!heartbeat.enabled) return "text-on-surface-faint";
  if (heartbeat.status === "down") return "text-danger";
  if (heartbeat.status === "up") return "text-success";
  return "text-on-surface-faint";
}

function PingHistory({ pings }: { pings: HeartbeatPing[] }) {
  const gt = useGT();
  const durations = pings
    .filter((p) => p.durationMs !== null)
    .map((p) => ({ timestamp: Date.parse(p.receivedAt), value: p.durationMs! / 1000 }))
    .sort((a, b) => a.timestamp - b.timestamp);
  const kindLabel = (kind: HeartbeatPing["kind"]) =>
    kind === "start" ? gt("Start") : kind === "fail" ? gt("Failure") : gt("Success");
  return (
    <div className="space-y-3">
      {durations.length > 1 && (
        <MetricChart
          node={{
            kind: "metric-chart",
            title: gt("Run duration"),
            series: [{ label: gt("Duration"), unit: "s", points: durations }],
            timeRangeLabel: gt("Runs opened with /start"),
          }}
        />
      )}
      {pings.length === 0 ? (
        <p className="text-sm text-on-surface-faint">{gt("No pings yet.")}</p>
      ) : (
        <ul className="divide-y divide-border text-xs">
          {pings.slice(0, 25).map((ping) => (
            <li key={ping.id} className="flex items-baseline gap-3 py-1.5">
              <span
                className={`w-16 shrink-0 font-medium ${
                  ping.kind === "fail"
                    ? "text-danger"
                    : ping.kind === "start"
                      ? "text-on-surface-secondary"
                      : "text-success"
                }`}
              >
                {kindLabel(ping.kind)}
              </span>
              <span className="w-32 shrink-0 text-on-surface-secondary">
                {formatWhen(ping.receivedAt)}
              </span>
              <span className="w-20 shrink-0 text-on-surface-secondary">
                {ping.durationMs !== null ? formatDuration(ping.durationMs) : ""}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-on-surface-faint">
                {ping.body ?? ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Heartbeat monitors: every heartbeat with its status, schedule and last
 * ping. A row expands into its ping URL, the snippet that calls it, the run
 * duration chart and the ping history. Shared between web and desktop; write
 * actions are gated on the client exposing the write methods.
 */
export function HeartbeatsPanel({ client, onDeclareIncident }: HeartbeatsPanelProps) {
  const gt = useGT();
  const [heartbeats, setHeartbeats] = useState<Heartbeat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ existing: Heartbeat | null } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // undefined = not fetched, null = fetch failed.
  const [pingsById, setPingsById] = useState<Record<string, HeartbeatPing[] | null>>({});

  const canWrite = Boolean(
    client.createHeartbeat && client.updateHeartbeat && client.deleteHeartbeat,
  );

  const reload = useCallback(() => {
    setError(null);
    client
      .listHeartbeats()
      .then(setHeartbeats)
      .catch((e) => setError(e instanceof Error ? e.message : gt("Failed to load heartbeats")));
  }, [client, gt]);

  useEffect(() => {
    reload();
  }, [reload]);

  const loadPings = useCallback(
    (id: string) => {
      client
        .listPings(id)
        .then((pings) => setPingsById((prev) => ({ ...prev, [id]: pings })))
        .catch(() => setPingsById((prev) => ({ ...prev, [id]: null })));
    },
    [client],
  );

  const toggleExpanded = (heartbeat: Heartbeat) => {
    const next = expandedId === heartbeat.id ? null : heartbeat.id;
    setExpandedId(next);
    if (next !== null) loadPings(heartbeat.id);
  };

  const act = async (fn: () => Promise<unknown>, failure: string) => {
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : failure);
    }
  };

  const remove = (heartbeat: Heartbeat) => {
    if (!window.confirm(gt('Delete heartbeat "{name}"?', { name: heartbeat.name }))) return;
    void act(() => client.deleteHeartbeat!(heartbeat.id), gt("Failed to delete the heartbeat"));
  };

  const rotate = (heartbeat: Heartbeat) => {
    if (
      !window.confirm(
        gt("Replace the ping URL? Jobs using the current URL stop being recorded at once."),
      )
    ) {
      return;
    }
    void act(() => client.rotateToken!(heartbeat.id), gt("Failed to replace the ping URL"));
  };

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-base font-semibold text-on-surface">{gt("Heartbeats")}</h2>
          {canWrite && (
            <button
              type="button"
              onClick={() => setEditing({ existing: null })}
              className="px-3 py-1.5 rounded-lg text-sm bg-accent hover:bg-accent-hover text-on-accent transition-colors"
            >
              {gt("New heartbeat")}
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
        {heartbeats === null && !error && (
          <p className="text-sm text-on-surface-faint">{gt("Loading heartbeats…")}</p>
        )}
        {heartbeats !== null && heartbeats.length === 0 && (
          <p className="text-sm text-on-surface-faint">{gt("No heartbeats yet.")}</p>
        )}

        {heartbeats !== null && heartbeats.length > 0 && (
          <ul className="space-y-2">
            {heartbeats.map((heartbeat) => {
              const expanded = expandedId === heartbeat.id;
              const schedule = heartbeatScheduleOf(heartbeat);
              const pings = pingsById[heartbeat.id];
              const down = heartbeat.enabled && heartbeat.status === "down";
              return (
                <li
                  key={heartbeat.id}
                  className="rounded-xl border border-border bg-surface-raised px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(heartbeat)}
                      aria-expanded={expanded}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="flex items-center gap-2">
                        {down && (
                          <IssueIndicator tone="danger" reason={statusLabel(heartbeat, gt)} />
                        )}
                        <span className="text-sm font-medium text-on-surface truncate">
                          {heartbeat.name}
                        </span>
                        <span className={`text-xs ${statusTone(heartbeat)}`}>
                          {statusLabel(heartbeat, gt)}
                        </span>
                      </div>
                      <p className="text-xs text-on-surface-secondary truncate">
                        {schedule ? scheduleLabel(schedule, gt) : ""}
                        {gt(" · grace {count} min", { count: heartbeat.graceMinutes })}
                        {heartbeat.lastPingAt
                          ? gt(" · last ping {when}", { when: formatWhen(heartbeat.lastPingAt) })
                          : gt(" · never pinged")}
                        {heartbeat.nextExpectedAt &&
                          gt(" · next due {when}", { when: formatWhen(heartbeat.nextExpectedAt) })}
                        {heartbeat.lastDurationMs !== null &&
                          gt(" · last run {duration}", {
                            duration: formatDuration(heartbeat.lastDurationMs),
                          })}
                      </p>
                    </button>
                    {onDeclareIncident && down && (
                      <button
                        type="button"
                        onClick={() =>
                          onDeclareIncident({
                            title:
                              heartbeat.downReason === "failed"
                                ? gt("{name} failed", { name: heartbeat.name })
                                : gt("{name} stopped running", { name: heartbeat.name }),
                            ...(heartbeat.resourceId
                              ? { resourceIds: [heartbeat.resourceId] }
                              : {}),
                            ...(heartbeat.lastStateChangeAt
                              ? { startedAt: heartbeat.lastStateChangeAt }
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
                          onClick={() =>
                            void act(
                              () =>
                                client.updateHeartbeat!(heartbeat.id, {
                                  enabled: !heartbeat.enabled,
                                }),
                              gt("Failed to update the heartbeat"),
                            )
                          }
                          className="px-2 py-1 rounded-lg text-xs text-on-surface-secondary hover:bg-surface-sunken transition-colors"
                        >
                          {heartbeat.enabled ? gt("Pause") : gt("Resume")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing({ existing: heartbeat })}
                          className="px-2 py-1 rounded-lg text-xs text-on-surface-secondary hover:bg-surface-sunken transition-colors"
                        >
                          {gt("Edit")}
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(heartbeat)}
                          className="px-2 py-1 rounded-lg text-xs text-danger hover:bg-surface-sunken transition-colors"
                        >
                          {gt("Delete")}
                        </button>
                      </div>
                    )}
                  </div>

                  {expanded && (
                    <div className="mt-3 space-y-4 border-t border-border pt-3">
                      <PingInstructions
                        pingUrl={heartbeat.pingUrl}
                        onRotate={client.rotateToken ? () => rotate(heartbeat) : undefined}
                      />
                      {pings === undefined && (
                        <p className="text-sm text-on-surface-faint">{gt("Loading pings…")}</p>
                      )}
                      {pings === null && (
                        <p className="text-sm text-danger">{gt("Failed to load pings")}</p>
                      )}
                      {pings && <PingHistory pings={pings} />}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {editing && (
        <HeartbeatEditorModal
          client={client}
          existing={editing.existing}
          onSaved={() => reload()}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
