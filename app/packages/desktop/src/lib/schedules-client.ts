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
import { Effect } from "effect";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const schedules = () => cloudClient("schedules").schedules;

/**
 * client-core types `remediation` as present or absent; the server sends
 * `null` when the plugin has nothing to offer, which reads as absent here.
 */
function withoutNullRemediation<Row extends { readonly remediation?: unknown }>(row: Row) {
  const { remediation, ...rest } = row;
  return remediation === null || remediation === undefined ? rest : { ...rest, remediation };
}

/**
 * Sleep/wake schedule data access: cloud-mode only (the rows live
 * server-side and the cloud poller executes the transitions; local mode has
 * no scheduler). The org is resolved at call time so signing in or out under
 * a mounted panel reaches the right store, the costs-client convention.
 */
export function createDesktopSchedulesClient(): SchedulesClient {
  const requireOrgId = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) throw new Error("Sleep schedules require Infrawrench Cloud: sign in first.");
    return orgId;
  };
  return {
    listSchedules: (): Promise<SleepScheduleListResponse> =>
      runRpc(
        schedules()
          .list({ params: { orgId: requireOrgId() } })
          .pipe(
            Effect.map((response) => ({
              ...response,
              schedules: response.schedules.map(withoutNullRemediation),
            })),
          ),
      ),
    createSchedule: (body: SleepScheduleCreate): Promise<SleepSchedule> =>
      runRpc(
        schedules()
          .create({ params: { orgId: requireOrgId() }, payload: body })
          .pipe(Effect.map(withoutNullRemediation)),
      ),
    updateSchedule: (scheduleId: string, patch: SleepSchedulePatch): Promise<SleepSchedule> =>
      runRpc(
        schedules()
          .update({ params: { orgId: requireOrgId(), scheduleId }, payload: patch })
          .pipe(Effect.map(withoutNullRemediation)),
      ),
    deleteSchedule: async (scheduleId: string) => {
      await runRpc(schedules().delete({ params: { orgId: requireOrgId(), scheduleId } }));
    },
    previewSchedule: (body: SchedulePreviewRequest): Promise<SchedulePreview> =>
      runRpc(schedules().preview({ params: { orgId: requireOrgId() }, payload: body })),
  };
}
