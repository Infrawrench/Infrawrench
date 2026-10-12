import type {
  ComplianceControlSetting,
  ComplianceControlSettingInput,
  ComplianceFrameworkSummary,
  CompliancePackSchedule,
  CompliancePackScheduleInput,
  CompliancePeriod,
  ComplianceStatusResponse,
  OwnerCandidate,
  ReportDeliveryTargets,
  ReportNotificationSendResult,
} from "@infrawrench/client-core";

/**
 * Host-injected data access for {@link ComplianceSection}. Web wraps
 * `apiGet`/`apiFetch`; desktop (cloud mode) wraps its `cloud_compliance_*`
 * IPC. The section never talks to a network itself.
 *
 * The reads are `audit:read` server-side. Every write is optional: a host
 * omits the control methods (`putControl`, `deleteControl`) for a caller
 * without `org:settings:write` and the control editor is not offered; it
 * omits the schedule writes and the schedule list renders read-only.
 */
export interface ComplianceClient {
  getFrameworks(): Promise<ComplianceFrameworkSummary[]>;
  getStatus(frameworkId: string, period: CompliancePeriod): Promise<ComplianceStatusResponse>;
  /** Build the evidence pack server-side and save the ZIP. Omitted, no download button. */
  downloadPack?(frameworkId: string, period: CompliancePeriod): Promise<void>;
  /** Store the org's decision about one control (a full replace). */
  putControl?(
    frameworkId: string,
    controlId: string,
    input: ComplianceControlSettingInput,
  ): Promise<ComplianceControlSetting>;
  /** Forget the decision: back to applicable and unowned. */
  deleteControl?(frameworkId: string, controlId: string): Promise<void>;
  /** Members the owner picker offers. Omitted, the owner can only be a typed label. */
  listMembers?(): Promise<OwnerCandidate[]>;
  /** Pack schedules for one framework. Omitted, the schedules section is hidden. */
  listSchedules?(frameworkId: string): Promise<CompliancePackSchedule[]>;
  getTargets?(): Promise<ReportDeliveryTargets>;
  createSchedule?(input: CompliancePackScheduleInput): Promise<CompliancePackSchedule>;
  updateSchedule?(
    scheduleId: string,
    input: CompliancePackScheduleInput,
  ): Promise<CompliancePackSchedule>;
  deleteSchedule?(scheduleId: string): Promise<void>;
  sendScheduleNow?(scheduleId: string): Promise<ReportNotificationSendResult>;
}
