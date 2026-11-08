import {
  useUIStore,
  type SeatListResponse,
  type SeatRemovalResponse,
  type SeatSettings,
  type SeatsClient,
} from "@infrawrench/ui";
import { Effect } from "effect";
import { cloudClient, withServerMessage } from "./cloud-client";
import { withoutNullRemediation } from "./cloud-remediation";
import { runRpc } from "./rpc/client";

// The Seats row shows a refusal (a freeze, a provider error) verbatim, so the
// writes fail with the server's `{ error }` sentence (`withServerMessage`).

const seats = () => cloudClient("seats").seats;

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
    listSeats: (): Promise<SeatListResponse> =>
      runRpc(
        seats()
          .list({ params: { orgId: requireOrg() } })
          .pipe(
            Effect.map((res): SeatListResponse => ({
              ...res,
              findings: res.findings.map(withoutNullRemediation),
            })),
          ),
      ),
    refreshSeats: (): Promise<{ queued: number }> =>
      runRpc(
        seats()
          .refresh({ params: { orgId: requireOrg() } })
          .pipe(withServerMessage),
      ),
    removeSeat: (seatId: string): Promise<SeatRemovalResponse> =>
      runRpc(
        seats()
          .remove({ params: { orgId: requireOrg(), seatId } })
          .pipe(withServerMessage),
      ),
    updateSeatSettings: (settings: SeatSettings): Promise<SeatSettings> =>
      runRpc(
        seats()
          .updateSettings({
            params: { orgId: requireOrg() },
            payload: { inactiveDays: settings.inactiveDays },
          })
          .pipe(withServerMessage),
      ),
  };
}
