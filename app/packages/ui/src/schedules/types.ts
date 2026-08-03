import type {
  SchedulePreview,
  SchedulePreviewRequest,
  SleepSchedule,
  SleepScheduleCreate,
  SleepScheduleListResponse,
  SleepSchedulePatch,
} from "@infrawrench/client-core";

export type {
  SchedulePreview,
  SchedulePreviewRequest,
  SleepSchedule,
  SleepScheduleCreate,
  SleepScheduleListResponse,
  SleepSchedulePatch,
} from "@infrawrench/client-core";

/**
 * Host-injected data access for the sleep/wake schedule surfaces. Web wraps
 * `apiGet`/`apiPost`; desktop (cloud mode) wraps its cloud IPC — the
 * components stay platform-agnostic.
 */
export interface SchedulesClient {
  listSchedules(): Promise<SleepScheduleListResponse>;
  createSchedule(body: SleepScheduleCreate): Promise<SleepSchedule>;
  updateSchedule(scheduleId: string, patch: SleepSchedulePatch): Promise<SleepSchedule>;
  deleteSchedule(scheduleId: string): Promise<void>;
  previewSchedule(body: SchedulePreviewRequest): Promise<SchedulePreview>;
}
