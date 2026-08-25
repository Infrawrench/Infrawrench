import { useCallback, useEffect, useRef, useState } from "react";
import { T, useGT } from "gt-react";
import {
  QueryMonitorsSection,
  useUIStore,
  type QueryMonitor,
  type QueryMonitorInput,
  type QueryMonitorTestResult,
} from "@infrawrench/ui";
import {
  createCloudQueryMonitor,
  deleteCloudQueryMonitor,
  fetchCloudQueryMonitors,
  testCloudQueryMonitor,
  updateCloudQueryMonitor,
} from "@/lib/cloud-resources";

/**
 * Desktop host for the shared query-monitors screen. Cloud only, and not
 * merely because the rows are org state: the schedule is run by the poller, so
 * a monitor that lived on one laptop would only run while that laptop was open
 * — which is the opposite of what a monitor is for.
 */
export function DesktopQueryMonitorsPanel() {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [monitors, setMonitors] = useState<QueryMonitor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useRef<() => void>(() => {});

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!activeCloudOrgId) return;
    let cancelled = false;
    let latestRequest = 0;
    setMonitors(null);
    setError(null);
    function load() {
      const orgId = activeCloudOrgId;
      if (!orgId) return;
      const request = ++latestRequest;
      fetchCloudQueryMonitors(orgId)
        .then((rows) => {
          if (cancelled || request !== latestRequest) return;
          setMonitors(rows);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled || request !== latestRequest) return;
          setError(e instanceof Error ? e.message : gt("Failed to load the query monitors"));
        });
    }
    load();
    reload.current = load;
    return () => {
      cancelled = true;
    };
  }, [activeCloudOrgId, reloadKey]);

  const create = useCallback(
    async (input: QueryMonitorInput) => {
      if (!activeCloudOrgId) return;
      await createCloudQueryMonitor(activeCloudOrgId, input);
      reload.current();
    },
    [activeCloudOrgId],
  );

  const update = useCallback(
    async (monitorId: string, patch: Partial<QueryMonitorInput>) => {
      if (!activeCloudOrgId) return;
      await updateCloudQueryMonitor(activeCloudOrgId, monitorId, patch);
      reload.current();
    },
    [activeCloudOrgId],
  );

  const remove = useCallback(
    async (monitorId: string) => {
      if (!activeCloudOrgId) return;
      await deleteCloudQueryMonitor(activeCloudOrgId, monitorId);
      reload.current();
    },
    [activeCloudOrgId],
  );

  const test = useCallback(
    async (input: Partial<QueryMonitorInput>): Promise<QueryMonitorTestResult> => {
      if (!activeCloudOrgId) throw new Error("No organization is selected");
      return testCloudQueryMonitor(activeCloudOrgId, input);
    },
    [activeCloudOrgId],
  );

  if (!activeCloudOrgId) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h1 className="text-xl font-semibold mb-1">{gt("Query monitors")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted">
            Query monitors are a cloud feature — the schedule runs in the cloud, so a monitor set up
            here would only run while this app was open. Sign in to an organization to watch what
            your data says.
          </p>
        </T>
      </div>
    );
  }

  return (
    <QueryMonitorsSection
      monitors={monitors}
      error={error}
      onRetry={retry}
      // The desktop does not read `/team/me`, so the editors are always offered
      // and a member without `resources:execute` gets the server's 403 in the
      // section's error banner — the Backups stance.
      onCreate={create}
      onUpdate={update}
      onDelete={remove}
      onTest={test}
    />
  );
}
