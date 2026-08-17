import { useCallback, useEffect, useRef, useState } from "react";
import {
  RunbooksSection,
  type Runbook,
  type RunbookInput,
  type RunbookRun,
  type RunbookStepStatus,
} from "@infrawrench/ui";
import { usePermissions } from "@/auth/permissions-context";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

interface WebRunbooksPanelProps {
  orgId: string;
  openWorkflow: (workflowId: string) => void;
}

interface WorkflowSummary {
  id: string;
  name: string;
}

/**
 * Web host for the shared runbooks screen.
 *
 * Two permission levels, mirroring the API: everyone who can read resources can
 * perform a runbook, and only `org:settings:write` can write one. A checklist
 * nobody on call can open is worse than no checklist.
 */
export function WebRunbooksPanel({ orgId, openWorkflow }: WebRunbooksPanelProps) {
  const [runbooks, setRunbooks] = useState<Runbook[] | null>(null);
  const [runs, setRuns] = useState<RunbookRun[] | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { has } = usePermissions();
  const canEdit = has("org:settings:write");
  // The load effect owns refreshing; mutations trigger one through a ref so
  // they don't have to re-run the effect.
  const reload = useRef<() => void>(() => {});

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    let latestRequest = 0;
    setRunbooks(null);
    setRuns(null);
    setError(null);
    function load() {
      const request = ++latestRequest;
      Promise.all([
        apiGet<{ runbooks: Runbook[] }>(`/api/org/${orgId}/runbooks`),
        apiGet<{ runs: RunbookRun[] }>(`/api/org/${orgId}/runbooks/runs?limit=50`),
      ])
        .then(([bookList, runList]) => {
          if (cancelled || request !== latestRequest) return;
          setRunbooks(bookList.runbooks);
          setRuns(runList.runs);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled || request !== latestRequest) return;
          setError(e instanceof Error ? e.message : "Failed to load the runbooks");
        });
    }
    load();
    reload.current = load;
    return () => {
      cancelled = true;
    };
  }, [orgId, reloadKey]);

  // Workflows are only needed by the editor's step picker, so a failure here
  // costs the picker and nothing else.
  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;
    apiGet<{ workflows: WorkflowSummary[] }>(`/api/org/${orgId}/workflows`)
      .then((response) => {
        if (!cancelled) setWorkflows(response.workflows ?? []);
      })
      .catch(() => {
        if (!cancelled) setWorkflows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, canEdit]);

  const create = useCallback(
    async (input: RunbookInput) => {
      await apiPost(`/api/org/${orgId}/runbooks`, input);
      reload.current();
    },
    [orgId],
  );

  const update = useCallback(
    async (runbookId: string, patch: Partial<RunbookInput>) => {
      await apiPatch(`/api/org/${orgId}/runbooks/${runbookId}`, patch);
      reload.current();
    },
    [orgId],
  );

  const remove = useCallback(
    async (runbookId: string) => {
      await apiDelete(`/api/org/${orgId}/runbooks/${runbookId}`);
      reload.current();
    },
    [orgId],
  );

  const startRun = useCallback(
    async (runbookId: string) => {
      await apiPost(`/api/org/${orgId}/runbooks/${runbookId}/runs`, {});
      reload.current();
    },
    [orgId],
  );

  const updateStep = useCallback(
    async (
      runId: string,
      stepId: string,
      patch: { status: RunbookStepStatus; note?: string | null },
    ) => {
      await apiPatch(`/api/org/${orgId}/runbooks/runs/${runId}/steps/${stepId}`, patch);
      reload.current();
    },
    [orgId],
  );

  const closeRun = useCallback(
    async (runId: string, status: "completed" | "abandoned", summary: string | null) => {
      await apiPost(`/api/org/${orgId}/runbooks/runs/${runId}/close`, { status, summary });
      reload.current();
    },
    [orgId],
  );

  return (
    <RunbooksSection
      runbooks={runbooks}
      runs={runs}
      error={error}
      onRetry={retry}
      workflowOptions={workflows}
      onCreate={canEdit ? create : undefined}
      onUpdate={canEdit ? update : undefined}
      onDelete={canEdit ? remove : undefined}
      // Performing is deliberately not gated on the editing permission.
      onStartRun={startRun}
      onUpdateStep={updateStep}
      onCloseRun={closeRun}
      onOpenWorkflow={openWorkflow}
    />
  );
}
