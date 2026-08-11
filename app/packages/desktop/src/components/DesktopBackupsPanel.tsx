import { useCallback, useEffect, useRef, useState } from "react";
import {
  RESOURCES_CHANGED_EVENT,
  BackupsSection,
  useUIStore,
  type BackupCoverageResponse,
  type BackupPolicy,
  type BackupPolicyInput,
} from "@infrawrench/ui";
import {
  createCloudBackupPolicy,
  deleteCloudBackupPolicy,
  fetchCloudBackupPolicies,
  fetchCloudBackups,
  updateCloudBackupPolicy,
} from "@/lib/cloud-resources";

interface DesktopBackupsPanelProps {
  openResource: (target: { accountId: string; resourceId: string }) => void;
}

/**
 * Desktop host for the shared backup coverage screen. Cloud only, unlike
 * Posture and Expiring: the coverage itself could be computed locally, but the
 * recovery objectives it is measured against are org state with nowhere to
 * live in a single-machine workspace, and a Backups screen that could only
 * ever say "there is a backup" — never "recent enough" — would be the wrong
 * half of the feature. Local mode gets the Changes/Costs treatment: an
 * explicit "sign in" message rather than an empty table.
 */
export function DesktopBackupsPanel({ openResource }: DesktopBackupsPanelProps) {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [data, setData] = useState<BackupCoverageResponse | null>(null);
  const [policies, setPolicies] = useState<BackupPolicy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // The load effect owns refreshing; policy mutations trigger one through a
  // ref so they don't have to re-run the effect (and tear down its listener).
  const reload = useRef<() => void>(() => {});

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  const createPolicy = useCallback(
    async (input: BackupPolicyInput) => {
      if (!activeCloudOrgId) return;
      await createCloudBackupPolicy(activeCloudOrgId, input);
      reload.current();
    },
    [activeCloudOrgId],
  );

  const updatePolicy = useCallback(
    async (policyId: string, patch: Partial<BackupPolicyInput>) => {
      if (!activeCloudOrgId) return;
      await updateCloudBackupPolicy(activeCloudOrgId, policyId, patch);
      reload.current();
    },
    [activeCloudOrgId],
  );

  const deletePolicy = useCallback(
    async (policyId: string) => {
      if (!activeCloudOrgId) return;
      await deleteCloudBackupPolicy(activeCloudOrgId, policyId);
      reload.current();
    },
    [activeCloudOrgId],
  );

  useEffect(() => {
    if (!activeCloudOrgId) return;
    let cancelled = false;
    // Refreshes within this effect can resolve out of order; only the newest
    // request may write state.
    let latestRequest = 0;
    setData(null);
    setPolicies(null);
    setError(null);
    function load() {
      const orgId = activeCloudOrgId;
      if (!orgId) return;
      const request = ++latestRequest;
      Promise.all([fetchCloudBackups(orgId), fetchCloudBackupPolicies(orgId)])
        .then(([coverage, policyList]) => {
          if (!cancelled && request === latestRequest) {
            setData(coverage);
            setPolicies(policyList);
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
  }, [activeCloudOrgId, reloadKey]);

  if (!activeCloudOrgId) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h1 className="text-xl font-semibold mb-1">Backups</h1>
        <p className="text-sm text-on-surface-muted">
          Backup coverage is a cloud feature. Sign in to an organization to see which of its
          resources are actually recoverable, and to set the recovery objectives they are judged
          against.
        </p>
      </div>
    );
  }

  return (
    <BackupsSection
      data={data}
      policies={policies}
      error={error}
      onRetry={retry}
      onOpenResource={openResource}
      // The desktop does not read `/team/me`, so the editors are always
      // offered and a member without `org:settings:write` gets the server's
      // 403 in the section's error banner. That is the Changes/Costs stance:
      // an extra permission round trip per tab open buys little on a surface
      // whose whole point is the org's own policy.
      onCreatePolicy={createPolicy}
      onUpdatePolicy={updatePolicy}
      onDeletePolicy={deletePolicy}
    />
  );
}
