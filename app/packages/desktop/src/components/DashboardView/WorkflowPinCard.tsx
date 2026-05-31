import { useCallback, useEffect, useState } from "react";
import { WorkflowDashboardCard, type WorkflowDashboardCardData } from "@infrawrench/ui/workflows";
import { getDb } from "../../db/client";
import { createDesktopWorkflowClient } from "../../lib/workflow-client";

interface MetricDef {
  key: string;
  label: string;
  unit?: string | null;
  type?: string;
}

// One client for all dashboard workflow runs — building it is cheap, but a
// singleton keeps run state tidy.
let sharedClient: ReturnType<typeof createDesktopWorkflowClient> | null = null;
function client() {
  if (!sharedClient) sharedClient = createDesktopWorkflowClient();
  return sharedClient;
}

/**
 * A pinned (local) workflow on the desktop dashboard. Loads the workflow's
 * declared metrics + current values + last-run status from the local DB, and
 * runs it via the desktop workflow client (re-reading metrics afterwards).
 */
export function WorkflowPinCard({
  workflowId,
  onOpen,
  onUnpin,
}: {
  workflowId: string;
  onOpen: () => void;
  onUnpin: () => void;
}) {
  const [data, setData] = useState<WorkflowDashboardCardData | null>(null);

  const load = useCallback(async () => {
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
  }, [workflowId]);

  useEffect(() => {
    void load();
  }, [load]);

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
        await client().run(workflowId);
        await load();
      }}
    />
  );
}
