import { useCallback, useEffect, useRef, useState } from "react";
import { T, useGT } from "gt-react";
import {
  RunbooksSection,
  useUIStore,
  type Runbook,
  type RunbookInput,
  type RunbookRun,
  type RunbookStepStatus,
} from "@infrawrench/ui";
import {
  closeCloudRunbookRun,
  createCloudRunbook,
  deleteCloudRunbook,
  fetchCloudRunbookRuns,
  fetchCloudRunbooks,
  startCloudRunbookRun,
  updateCloudRunbook,
  updateCloudRunbookStep,
} from "@/lib/cloud-resources";

/**
 * Desktop host for the shared runbooks screen. Cloud only: a runbook is a
 * shared document and a run is a record of who did what, so both are org state
 * a single-machine workspace has nowhere to keep. Local mode gets the
 * Changes/Costs treatment — an explicit "sign in" message.
 */
export function DesktopRunbooksPanel() {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [runbooks, setRunbooks] = useState<Runbook[] | null>(null);
  const [runs, setRuns] = useState<RunbookRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useRef<() => void>(() => {});

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!activeCloudOrgId) return;
    let cancelled = false;
    let latestRequest = 0;
    setRunbooks(null);
    setRuns(null);
    setError(null);
    function load() {
      const orgId = activeCloudOrgId;
      if (!orgId) return;
      const request = ++latestRequest;
      Promise.all([fetchCloudRunbooks(orgId), fetchCloudRunbookRuns(orgId)])
        .then(([bookList, runList]) => {
          if (cancelled || request !== latestRequest) return;
          setRunbooks(bookList);
          setRuns(runList);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled || request !== latestRequest) return;
          setError(e instanceof Error ? e.message : gt("Failed to load the runbooks"));
        });
    }
    load();
    reload.current = load;
    return () => {
      cancelled = true;
    };
  }, [activeCloudOrgId, reloadKey]);

  const create = useCallback(
    async (input: RunbookInput) => {
      if (!activeCloudOrgId) return;
      await createCloudRunbook(activeCloudOrgId, input);
      reload.current();
    },
    [activeCloudOrgId],
  );

  const update = useCallback(
    async (runbookId: string, patch: Partial<RunbookInput>) => {
      if (!activeCloudOrgId) return;
      await updateCloudRunbook(activeCloudOrgId, runbookId, patch);
      reload.current();
    },
    [activeCloudOrgId],
  );

  const remove = useCallback(
    async (runbookId: string) => {
      if (!activeCloudOrgId) return;
      await deleteCloudRunbook(activeCloudOrgId, runbookId);
      reload.current();
    },
    [activeCloudOrgId],
  );

  const startRun = useCallback(
    async (runbookId: string) => {
      if (!activeCloudOrgId) return;
      await startCloudRunbookRun(activeCloudOrgId, runbookId);
      reload.current();
    },
    [activeCloudOrgId],
  );

  const updateStep = useCallback(
    async (
      runId: string,
      stepId: string,
      patch: { status: RunbookStepStatus; note?: string | null },
    ) => {
      if (!activeCloudOrgId) return;
      await updateCloudRunbookStep(activeCloudOrgId, runId, stepId, patch);
      reload.current();
    },
    [activeCloudOrgId],
  );

  const closeRun = useCallback(
    async (runId: string, status: "completed" | "abandoned", summary: string | null) => {
      if (!activeCloudOrgId) return;
      await closeCloudRunbookRun(activeCloudOrgId, runId, status, summary);
      reload.current();
    },
    [activeCloudOrgId],
  );

  if (!activeCloudOrgId) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h1 className="text-xl font-semibold mb-1">{gt("Runbooks")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted">
            Runbooks are a cloud feature. Sign in to an organization to write down the procedures
            your team follows, and to keep a record of who did what when one is performed.
          </p>
        </T>
      </div>
    );
  }

  return (
    <RunbooksSection
      runbooks={runbooks}
      runs={runs}
      error={error}
      onRetry={retry}
      // The desktop does not read `/team/me`, so the editors are always offered
      // and a member without `org:settings:write` gets the server's 403 in the
      // section's error banner — the Backups stance.
      onCreate={create}
      onUpdate={update}
      onDelete={remove}
      onStartRun={startRun}
      onUpdateStep={updateStep}
      onCloseRun={closeRun}
    />
  );
}
