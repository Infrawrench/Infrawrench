import { useMemo } from "react";
import { T, useGT } from "gt-react";
import {
  ComplianceSection,
  downloadBlob,
  evidencePackFileName,
  useUIStore,
  type ComplianceClient,
} from "@infrawrench/ui";
import {
  createCloudCompliancePackSchedule,
  deleteCloudComplianceControl,
  deleteCloudCompliancePackSchedule,
  fetchCloudComplianceFrameworks,
  fetchCloudCompliancePackTargets,
  fetchCloudComplianceStatus,
  listCloudCompliancePackSchedules,
  loadCloudCompliancePack,
  putCloudComplianceControl,
  sendCloudCompliancePackScheduleNow,
  updateCloudCompliancePackSchedule,
} from "@/lib/cloud-resources";
import { listCloudOwnerCandidates } from "@/lib/cloud-ownership";

interface DesktopCompliancePanelProps {
  framework?: string | undefined;
  onFrameworkChange: (framework: string) => void;
}

/**
 * Desktop host for the shared Compliance section. Cloud only: the evidence is
 * org state (the audit log, access decisions, scanner findings, restore
 * drills) and a local workspace has none of it, so local mode gets an
 * explanation instead of a table of gaps that would read as a failed audit.
 */
export function DesktopCompliancePanel({
  framework,
  onFrameworkChange,
}: DesktopCompliancePanelProps) {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);

  // The desktop does not read `/team/me`, so the editors are always offered
  // and a member without `org:settings:write` gets the server's 403 where
  // they tried: the Vulnerabilities stance.
  const client = useMemo<ComplianceClient | null>(() => {
    if (!activeCloudOrgId) return null;
    const orgId = activeCloudOrgId;
    return {
      getFrameworks: () => fetchCloudComplianceFrameworks(orgId),
      getStatus: (frameworkId, period) => fetchCloudComplianceStatus(orgId, frameworkId, period),
      downloadPack: async (frameworkId, period) => {
        const bytes = await loadCloudCompliancePack(orgId, frameworkId, period);
        // Copy into a fresh ArrayBuffer-backed view: an IPC payload's buffer
        // is typed `ArrayBufferLike`, which `BlobPart` does not accept.
        downloadBlob(
          new Blob([new Uint8Array(bytes)], { type: "application/zip" }),
          evidencePackFileName(frameworkId, period),
        );
      },
      putControl: (frameworkId, controlId, input) =>
        putCloudComplianceControl(orgId, frameworkId, controlId, input),
      deleteControl: (frameworkId, controlId) =>
        deleteCloudComplianceControl(orgId, frameworkId, controlId),
      // The ownership picker's member list: the same people, the same route.
      listMembers: () => listCloudOwnerCandidates(orgId),
      listSchedules: (frameworkId) => listCloudCompliancePackSchedules(orgId, frameworkId),
      getTargets: () => fetchCloudCompliancePackTargets(orgId),
      createSchedule: (input) => createCloudCompliancePackSchedule(orgId, input),
      updateSchedule: (id, input) => updateCloudCompliancePackSchedule(orgId, id, input),
      deleteSchedule: (id) => deleteCloudCompliancePackSchedule(orgId, id),
      sendScheduleNow: (id) => sendCloudCompliancePackScheduleNow(orgId, id),
    };
  }, [activeCloudOrgId]);

  if (!client) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h1 className="mb-1 text-xl font-semibold">{gt("Compliance")}</h1>
        <p className="text-sm text-on-surface-muted">
          <T>
            Compliance is a cloud feature: its evidence is your organization&apos;s audit log,
            access decisions, scanner findings and restore drills, and a local workspace has none of
            them. Sign in to an organization to map that evidence to SOC 2 and ISO 27001 controls
            and export an evidence pack.
          </T>
        </p>
      </div>
    );
  }

  return (
    <ComplianceSection
      client={client}
      framework={framework}
      onFrameworkChange={onFrameworkChange}
    />
  );
}
