import { useCallback, useEffect, useRef, useState } from "react";
import {
  QueryMonitorsSection,
  type QueryMonitor,
  type QueryMonitorInput,
  type QueryMonitorTestResult,
} from "@infrawrench/ui";
import { usePermissions } from "@/auth/permissions-context";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

interface WebQueryMonitorsPanelProps {
  orgId: string;
}

interface AccountRow {
  id: string;
  displayName: string;
}

/**
 * Web host for the shared query-monitors screen.
 *
 * Editing and test-running are gated on `resources:execute`, the same
 * permission the SQL editor needs: saving a monitor arranges for a query to run
 * against a customer database on a schedule, forever.
 */
export function WebQueryMonitorsPanel({ orgId }: WebQueryMonitorsPanelProps) {
  const [monitors, setMonitors] = useState<QueryMonitor[] | null>(null);
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { has } = usePermissions();
  const canExecute = has("resources:execute");
  const reload = useRef<() => void>(() => {});

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    let latestRequest = 0;
    setMonitors(null);
    setError(null);
    function load() {
      const request = ++latestRequest;
      apiGet<{ monitors: QueryMonitor[] }>(`/api/org/${orgId}/query-monitors`)
        .then((response) => {
          if (cancelled || request !== latestRequest) return;
          setMonitors(response.monitors);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled || request !== latestRequest) return;
          setError(e instanceof Error ? e.message : "Failed to load the query monitors");
        });
    }
    load();
    reload.current = load;
    return () => {
      cancelled = true;
    };
  }, [orgId, reloadKey]);

  // The account list only feeds the editor's picker, so a failure costs the
  // picker and not the page.
  useEffect(() => {
    let cancelled = false;
    apiGet<AccountRow[]>(`/api/org/${orgId}/accounts`)
      .then((rows) => {
        if (!cancelled) {
          setAccounts((rows ?? []).map((row) => ({ id: row.id, name: row.displayName })));
        }
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const create = useCallback(
    async (input: QueryMonitorInput) => {
      await apiPost(`/api/org/${orgId}/query-monitors`, input);
      reload.current();
    },
    [orgId],
  );

  const update = useCallback(
    async (monitorId: string, patch: Partial<QueryMonitorInput>) => {
      await apiPatch(`/api/org/${orgId}/query-monitors/${monitorId}`, patch);
      reload.current();
    },
    [orgId],
  );

  const remove = useCallback(
    async (monitorId: string) => {
      await apiDelete(`/api/org/${orgId}/query-monitors/${monitorId}`);
      reload.current();
    },
    [orgId],
  );

  const test = useCallback(
    async (input: Partial<QueryMonitorInput>) =>
      apiPost<QueryMonitorTestResult>(`/api/org/${orgId}/query-monitors/test`, input),
    [orgId],
  );

  return (
    <QueryMonitorsSection
      monitors={monitors}
      error={error}
      onRetry={retry}
      accountOptions={accounts}
      onCreate={canExecute ? create : undefined}
      onUpdate={canExecute ? update : undefined}
      onDelete={canExecute ? remove : undefined}
      onTest={canExecute ? test : undefined}
    />
  );
}
