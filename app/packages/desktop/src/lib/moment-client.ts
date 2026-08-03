import {
  useUIStore,
  type MomentClient,
  type MomentRequest,
  type MomentResponse,
} from "@infrawrench/ui";
import { invoke } from "./invoke";

/**
 * The moment view is cloud-only: every feed in the union is recorded by the
 * cloud side (poller passes, workflow runner, audit writes), so local-only
 * mode has nothing to merge. Resolves the active org at call time (not at
 * client construction) so switching org under a mounted page reaches the new
 * org's window — same convention as the changes and costs clients.
 */
export function createDesktopMomentClient(): MomentClient {
  const requireOrg = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) {
      throw new Error("The moment view requires cloud mode — sign in to sync.");
    }
    return orgId;
  };

  return {
    getMoment: (request: MomentRequest) =>
      invoke<MomentResponse>("cloud_moment", {
        orgId: requireOrg(),
        ...(request.at ? { at: request.at } : {}),
        ...(typeof request.windowMinutes === "number"
          ? { windowMinutes: request.windowMinutes }
          : {}),
      }),
  };
}
