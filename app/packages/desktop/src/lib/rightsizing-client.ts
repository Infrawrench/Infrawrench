import {
  useUIStore,
  type OversizedResource,
  type RightsizingClient,
  type RightsizingListResponse,
} from "@infrawrench/ui";
import { invoke } from "./invoke";

/**
 * Oversized-section data access — cloud-mode only (the caller leaves the
 * section off without an active cloud org, like schedules): the percentiles
 * live in the cloud metrics warehouse and the size catalogs need the org's
 * account credentials.
 *
 * The org is resolved at call time so switching org under a mounted Costs
 * tab reaches the right data. `applyResize` rides the existing
 * `cloud_update_resource` channel — the same resource-update path the edit
 * form uses, which is what enforces change freezes and writes the audit
 * trail server-side.
 */
export function createDesktopRightsizingClient(): RightsizingClient {
  const requireOrg = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) throw new Error("Sign in to Infrawrench Cloud to see right-sizing suggestions");
    return orgId;
  };
  return {
    listRightsizing: (refresh?: boolean) =>
      invoke<RightsizingListResponse>("cloud_rightsizing_list", {
        orgId: requireOrg(),
        ...(refresh ? { refresh: true } : {}),
      }),
    applyResize: async (resource: OversizedResource, accountId: string) => {
      await invoke("cloud_update_resource", {
        orgId: requireOrg(),
        body: {
          accountId,
          pluginId: resource.pluginId,
          resourceTypeId: resource.resourceTypeId,
          resourceId: resource.id,
          fields: { [resource.sizeFieldKey]: resource.recommendedSize.id },
        },
      });
    },
  };
}
