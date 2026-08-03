import {
  useUIStore,
  type SchedulePreview,
  type SchedulePreviewRequest,
  type SchedulesClient,
  type SleepSchedule,
  type SleepScheduleCreate,
  type SleepScheduleListResponse,
  type SleepSchedulePatch,
} from "@infrawrench/ui";
import { invoke } from "./invoke";

/**
 * Sleep/wake schedule data access — cloud-mode only (the rows live
 * server-side and the cloud poller executes the transitions; local mode has
 * no scheduler). The org is resolved at call time so signing in or out under
 * a mounted panel reaches the right store, the costs-client convention.
 */
export function createDesktopSchedulesClient(): SchedulesClient {
  const requireOrgId = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) throw new Error("Sleep schedules require Infrawrench Cloud — sign in first.");
    return orgId;
  };
  return {
    listSchedules: () =>
      invoke<SleepScheduleListResponse>("cloud_schedules_list", { orgId: requireOrgId() }),
    createSchedule: (body: SleepScheduleCreate) =>
      invoke<SleepSchedule>("cloud_schedules_create", { orgId: requireOrgId(), body }),
    updateSchedule: (scheduleId: string, patch: SleepSchedulePatch) =>
      invoke<SleepSchedule>("cloud_schedules_update", { orgId: requireOrgId(), scheduleId, patch }),
    deleteSchedule: async (scheduleId: string) => {
      await invoke("cloud_schedules_delete", { orgId: requireOrgId(), scheduleId });
    },
    previewSchedule: (body: SchedulePreviewRequest) =>
      invoke<SchedulePreview>("cloud_schedules_preview", { orgId: requireOrgId(), body }),
  };
}
