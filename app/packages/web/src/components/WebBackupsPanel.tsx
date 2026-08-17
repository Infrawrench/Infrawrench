import { useCallback, useEffect, useRef, useState } from "react";
import {
  RESOURCES_CHANGED_EVENT,
  BackupsSection,
  type BackupCoverageResponse,
  type BackupPolicy,
  type BackupPolicyInput,
  type DrillCoverage,
  type RestoreDrillInput,
} from "@infrawrench/ui";
import { usePermissions } from "@/auth/permissions-context";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

interface WebBackupsPanelProps {
  orgId: string;
  openResource: (target: { accountId: string; resourceId: string }) => void;
}

/**
 * Web host for the shared backup coverage screen: fetches the org's coverage
 * and policies and refreshes when resources change. Same wiring as
 * WebPosturePanel — a failed *refresh* must not blank data that is already
 * drawn, so the last loaded coverage stays on screen under the section's
 * banner.
 */
export function WebBackupsPanel({ orgId, openResource }: WebBackupsPanelProps) {
  const [data, setData] = useState<BackupCoverageResponse | null>(null);
  const [policies, setPolicies] = useState<BackupPolicy[] | null>(null);
  const [drills, setDrills] = useState<DrillCoverage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Until the shell's permission read lands `has()` is false, so the policy
  // editors stay hidden rather than offering an action that would 403.
  const { has } = usePermissions();
  const canEdit = has("org:settings:write");
  // The load effect owns the refresh; policy mutations need to trigger one
  // without re-running the effect's teardown, so they go through a ref.
  const reload = useRef<() => void>(() => {});

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  const createPolicy = useCallback(
    async (input: BackupPolicyInput) => {
      await apiPost(`/api/org/${orgId}/backups/policies`, input);
      reload.current();
    },
    [orgId],
  );

  const updatePolicy = useCallback(
    async (policyId: string, patch: Partial<BackupPolicyInput>) => {
      await apiPatch(`/api/org/${orgId}/backups/policies/${policyId}`, patch);
      reload.current();
    },
    [orgId],
  );

  const recordDrill = useCallback(
    async (input: RestoreDrillInput) => {
      await apiPost(`/api/org/${orgId}/backups/drills`, input);
      reload.current();
    },
    [orgId],
  );

  const deletePolicy = useCallback(
    async (policyId: string) => {
      await apiDelete(`/api/org/${orgId}/backups/policies/${policyId}`);
      reload.current();
    },
    [orgId],
  );

  useEffect(() => {
    let cancelled = false;
    // Refreshes within this effect (initial load + RESOURCES_CHANGED_EVENT)
    // can resolve out of order; only the newest request may write state.
    let latestRequest = 0;
    // Clear on org change: without this the previous org's coverage stays on
    // screen until the new fetch resolves, which reads as this org's data.
    setData(null);
    setPolicies(null);
    setDrills(null);
    setError(null);
    function load() {
      const request = ++latestRequest;
      Promise.all([
        apiGet<BackupCoverageResponse>(`/api/org/${orgId}/backups`),
        apiGet<{ policies: BackupPolicy[] }>(`/api/org/${orgId}/backups/policies`),
        // Drills are a third read rather than part of the coverage payload:
        // the standings are computed *over* the coverage, and folding them in
        // would make the existing endpoint pay for them on every page that
        // only wants gaps.
        apiGet<DrillCoverage>(`/api/org/${orgId}/backups/drills`),
      ])
        .then(([coverage, policyList, drillCoverage]) => {
          if (!cancelled && request === latestRequest) {
            setData(coverage);
            setPolicies(policyList.policies);
            setDrills(drillCoverage);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled && request === latestRequest)
            setError(e instanceof Error ? e.message : "Failed to load the backup coverage");
        });
    }
    load();
    reload.current = load;
    window.addEventListener(RESOURCES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RESOURCES_CHANGED_EVENT, load);
    };
  }, [orgId, reloadKey]);

  return (
    <BackupsSection
      data={data}
      policies={policies}
      error={error}
      onRetry={retry}
      onOpenResource={openResource}
      // Members can read the coverage but not relax the objective it is judged
      // against; without the permission the section renders read-only rather
      // than offering an action that would 403.
      onCreatePolicy={canEdit ? createPolicy : undefined}
      onUpdatePolicy={canEdit ? updatePolicy : undefined}
      onDeletePolicy={canEdit ? deletePolicy : undefined}
      drills={drills}
      // Recording a drill is reporting what you did, so it follows
      // `resources:write` rather than the settings permission the policies
      // need. The host does not read that permission separately, so the server
      // is the gate and its 403 surfaces in the section's banner.
      onRecordDrill={recordDrill}
    />
  );
}
