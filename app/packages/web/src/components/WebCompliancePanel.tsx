import { useMemo } from "react";
import {
  ComplianceSection,
  complianceQuery,
  downloadBlob,
  evidencePackFileName,
  type ComplianceClient,
  type ComplianceControlSetting,
  type ComplianceFrameworkSummary,
  type CompliancePackSchedule,
  type ComplianceStatusResponse,
} from "@infrawrench/ui";
import type {
  OwnerCandidate,
  ReportDeliveryTargets,
  ReportNotificationSendResult,
} from "@infrawrench/client-core";
import { usePermissions } from "@/auth/permissions-context";
import { apiDelete, apiGet, apiGetBlob, apiPost, apiPut } from "@/lib/api";

interface WebCompliancePanelProps {
  orgId: string;
  framework?: string | undefined;
  onFrameworkChange: (framework: string) => void;
}

/**
 * Web host for the shared Compliance section: binds its client to the
 * org-scoped `/compliance` routes. Reads are `audit:read`; control decisions
 * and pack schedules are `org:settings:write`, so a caller without it gets
 * the section read-only instead of buttons that 403.
 */
export function WebCompliancePanel({
  orgId,
  framework,
  onFrameworkChange,
}: WebCompliancePanelProps) {
  // Until the shell's permission read lands `has()` is false, so the editors
  // stay hidden rather than offering a call that 403s.
  const { has } = usePermissions();
  const canManage = has("org:settings:write");

  const client = useMemo<ComplianceClient>(() => {
    const base = `/api/org/${encodeURIComponent(orgId)}/compliance`;
    const controlPath = (frameworkId: string, controlId: string) =>
      `${base}/controls/${encodeURIComponent(frameworkId)}/${encodeURIComponent(controlId)}`;
    const read: ComplianceClient = {
      getFrameworks: async () =>
        (await apiGet<{ frameworks: ComplianceFrameworkSummary[] }>(`${base}/frameworks`))
          .frameworks,
      getStatus: (frameworkId, period) =>
        apiGet<ComplianceStatusResponse>(`${base}?${complianceQuery(frameworkId, period)}`),
      downloadPack: async (frameworkId, period) => {
        const blob = await apiGetBlob(`${base}/pack?${complianceQuery(frameworkId, period)}`);
        downloadBlob(blob, evidencePackFileName(frameworkId, period));
      },
      listSchedules: (frameworkId) =>
        apiGet<CompliancePackSchedule[]>(
          `${base}/schedules?framework=${encodeURIComponent(frameworkId)}`,
        ),
    };
    if (!canManage) return read;
    return {
      ...read,
      putControl: (frameworkId, controlId, input) =>
        apiPut<ComplianceControlSetting>(controlPath(frameworkId, controlId), input),
      deleteControl: async (frameworkId, controlId) => {
        await apiDelete(controlPath(frameworkId, controlId));
      },
      // The ownership picker's member list: the same people, the same route.
      listMembers: async () =>
        (
          await apiGet<{ members: OwnerCandidate[] }>(
            `/api/org/${encodeURIComponent(orgId)}/ownership/members`,
          )
        ).members,
      getTargets: () => apiGet<ReportDeliveryTargets>(`${base}/schedules/targets`),
      createSchedule: (input) => apiPost<CompliancePackSchedule>(`${base}/schedules`, input),
      updateSchedule: (id, input) =>
        apiPut<CompliancePackSchedule>(`${base}/schedules/${encodeURIComponent(id)}`, input),
      deleteSchedule: async (id) => {
        await apiDelete(`${base}/schedules/${encodeURIComponent(id)}`);
      },
      sendScheduleNow: (id) =>
        apiPost<ReportNotificationSendResult>(`${base}/schedules/${encodeURIComponent(id)}/send`),
    };
  }, [orgId, canManage]);

  return (
    <ComplianceSection
      client={client}
      framework={framework}
      onFrameworkChange={onFrameworkChange}
    />
  );
}
