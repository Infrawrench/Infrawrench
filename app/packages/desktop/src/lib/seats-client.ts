import {
  useUIStore,
  type SeatListResponse,
  type SeatRemovalResponse,
  type SeatSettings,
  type SeatsClient,
} from "@infrawrench/ui";
import { invoke } from "./invoke";

/**
 * Seats-section data access; cloud-mode only (the caller leaves the section
 * off without an active cloud org): the inventory is collected by the cloud
 * poller. The org is resolved at call time, the rightsizing-client
 * convention, so switching org under a mounted Costs tab reaches the right
 * data.
 */
export function createDesktopSeatsClient(): SeatsClient {
  const requireOrg = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) throw new Error("Sign in to Infrawrench Cloud to see seats");
    return orgId;
  };
  return {
    listSeats: () => invoke<SeatListResponse>("cloud_seats_list", { orgId: requireOrg() }),
    refreshSeats: () => invoke<{ queued: number }>("cloud_seats_refresh", { orgId: requireOrg() }),
    removeSeat: (seatId: string) =>
      invoke<SeatRemovalResponse>("cloud_seats_remove", { orgId: requireOrg(), seatId }),
    updateSeatSettings: (settings: SeatSettings) =>
      invoke<SeatSettings>("cloud_seats_update_settings", {
        orgId: requireOrg(),
        inactiveDays: settings.inactiveDays,
      }),
  };
}
