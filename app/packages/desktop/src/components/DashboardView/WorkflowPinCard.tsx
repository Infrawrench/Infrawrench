import { useCallback, useEffect, useState } from "react";
import {
  WorkflowDashboardCard,
  type StoredWorkflowMetricDef as MetricDef,
  type WorkflowClient,
  type WorkflowDashboardCardData,
} from "@infrawrench/ui/workflows";
import { getDb } from "../../db/client";
import { createDesktopWorkflowClient } from "../../lib/workflow-client";
import { createCloudWorkflowClient } from "../../lib/cloud-workflows";

// One client per source for all dashboard workflow runs — building them is
// cheap, but stable instances keep run state tidy.
let localClient: WorkflowClient | null = null;
const cloudClients = new Map<string, WorkflowClient>();
function clientFor(orgId: string | null): WorkflowClient {
  if (!orgId) return (localClient ??= createDesktopWorkflowClient());
  let client = cloudClients.get(orgId);
  if (!client) {
    client = createCloudWorkflowClient(orgId);
    cloudClients.set(orgId, client);
  }
  return client;
}

/**
 * A pinned workflow on the desktop dashboard.
 *
 * Local dashboards read the card straight out of SQLite. Cloud dashboards get
 * it inline with the dashboard payload (`initialData`) — the server already
 * joined the metrics and last run — and only re-read after a run, since that is
 * the one moment the values here go stale.
 */
export function WorkflowPinCard({
  workflowId,
  orgId,
  initialData,
  onOpen,
  onUnpin,
}: {
  workflowId: string;
  /** The active cloud org, or null for a local dashboard. */
  orgId?: string | null;
  /** Card contents for cloud pins (the dashboard response carries them). */
  initialData?: WorkflowDashboardCardData | undefined;
  onOpen: () => void;
  onUnpin: () => void;
}) {
  const [data, setData] = useState<WorkflowDashboardCardData | null>(initialData ?? null);

  // Keep the card in step with a dashboard reload (e.g. after a reorder).
  useEffect(() => {
    if (initialData) setData(initialData);
  }, [initialData]);

  const load = useCallback(async () => {
    if (orgId) {
      // Re-read the two things a run changes; name/pin identity are stable.
      const client = clientFor(orgId);
      const [metrics, runs] = await Promise.all([
        client.listMetrics(workflowId).catch(() => []),
        client.listRuns(workflowId).catch(() => []),
      ]);
      setData((prev) =>
        prev
          ? {
              ...prev,
              lastRunAt: runs[0]?.finishedAt ?? runs[0]?.startedAt ?? prev.lastRunAt,
              lastStatus: (runs[0]?.status ?? null) as WorkflowDashboardCardData["lastStatus"],
              metrics: prev.metrics.map((m) => {
                const row = metrics.find((r) => r.key === m.key);
                return row
                  ? {
                      ...m,
                      value: row.value as WorkflowDashboardCardData["metrics"][number]["value"],
                    }
                  : m;
              }),
            }
          : prev,
      );
      return;
    }

    const db = await getDb();
    const wfRows = await db.select<
      { name: string; metric_defs: string; last_run_at: string | null }[]
    >("SELECT name, metric_defs, last_run_at FROM workflows WHERE id = $1 AND deleted_at IS NULL", [
      workflowId,
    ]);
    const wf = wfRows[0];
    if (!wf) {
      setData(null);
      return;
    }
    const metricRows = await db.select<{ key: string; value: string | null }[]>(
      "SELECT key, value FROM workflow_metrics WHERE workflow_id = $1 AND deleted_at IS NULL",
      [workflowId],
    );
    const valueByKey = new Map<string, unknown>();
    for (const m of metricRows) {
      try {
        valueByKey.set(m.key, m.value == null ? null : JSON.parse(m.value));
      } catch {
        valueByKey.set(m.key, m.value);
      }
    }
    const runRows = await db.select<{ status: string }[]>(
      "SELECT status FROM workflow_runs WHERE workflow_id = $1 ORDER BY created_at DESC LIMIT 1",
      [workflowId],
    );
    let defs: MetricDef[] = [];
    try {
      defs = JSON.parse(wf.metric_defs) as MetricDef[];
    } catch {
      defs = [];
    }
    setData({
      workflowId,
      name: wf.name,
      lastRunAt: wf.last_run_at,
      lastStatus: (runRows[0]?.status ?? null) as WorkflowDashboardCardData["lastStatus"],
      metrics: defs.map((d) => ({
        key: d.key,
        label: d.label ?? d.key,
        unit: d.unit ?? null,
        value: (valueByKey.get(d.key) ?? null) as number | string | boolean | null,
      })),
    });
  }, [workflowId, orgId]);

  useEffect(() => {
    // Cloud pins arrive pre-loaded; only the local path has to fetch.
    if (!orgId) void load();
  }, [load, orgId]);

  if (!data) {
    return (
      <div className="rounded-2xl border border-border bg-surface-raised p-5 flex flex-col gap-3 min-h-[140px] animate-pulse">
        <div className="h-4 w-24 rounded bg-surface-sunken" />
        <div className="h-3 w-16 rounded bg-surface-sunken" />
        <div className="mt-auto h-3 w-20 rounded bg-surface-sunken" />
      </div>
    );
  }

  return (
    <WorkflowDashboardCard
      data={data}
      onOpen={onOpen}
      onUnpin={onUnpin}
      onRun={async () => {
        await clientFor(orgId ?? null).run(workflowId);
        await load();
      }}
    />
  );
}
