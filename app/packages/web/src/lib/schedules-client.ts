import type {
  SchedulePreview,
  SchedulePreviewRequest,
  SchedulesClient,
  SleepSchedule,
  SleepScheduleCreate,
  SleepScheduleListResponse,
  SleepSchedulePatch,
} from "@infrawrench/ui";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

/** Web implementation of the sleep-schedule surfaces' host-injected data access. */
export function createWebSchedulesClient(orgId: string): SchedulesClient {
  const base = `/api/org/${orgId}/schedules`;
  return {
    listSchedules: () => apiGet<SleepScheduleListResponse>(base),
    createSchedule: (body: SleepScheduleCreate) => apiPost<SleepSchedule>(base, body),
    updateSchedule: (scheduleId: string, patch: SleepSchedulePatch) =>
      apiPut<SleepSchedule>(`${base}/${encodeURIComponent(scheduleId)}`, patch),
    deleteSchedule: async (scheduleId: string) => {
      await apiDelete(`${base}/${encodeURIComponent(scheduleId)}`);
    },
    previewSchedule: (body: SchedulePreviewRequest) =>
      apiPost<SchedulePreview>(`${base}/preview`, body),
  };
}
