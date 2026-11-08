import {
  useUIStore,
  type OversizedResource,
  type RightsizingClient,
  type RightsizingListResponse,
} from "@infrawrench/ui";
import { Effect } from "effect";
import { cloudClient } from "./cloud-client";
import { withoutNullRemediation } from "./cloud-remediation";
import { runRpc } from "./rpc/client";

/**
 * Oversized-section data access; cloud-mode only (the caller leaves the
 * section off without an active cloud org, like schedules): the percentiles
 * live in the cloud metrics warehouse and the size catalogs need the org's
 * account credentials.
 *
 * The org is resolved at call time so switching org under a mounted Costs
 * tab reaches the right data. `applyResize` calls the resources domain's
 * `POST /resources/update`: the same resource-update path the edit form
 * uses, which is what enforces change freezes and writes the audit trail
 * server-side.
 */
export function createDesktopRightsizingClient(): RightsizingClient {
  const requireOrg = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) throw new Error("Sign in to Infrawrench Cloud to see right-sizing suggestions");
    return orgId;
  };
  return {
    listRightsizing: (refresh?: boolean): Promise<RightsizingListResponse> =>
      runRpc(
        cloudClient("rightsizing")
          .rightsizing.list({
            params: { orgId: requireOrg() },
            query: refresh ? { refresh: "true" } : {},
          })
          .pipe(
            Effect.map((res): RightsizingListResponse => ({
              ...res,
              accounts: res.accounts.map((account) => ({
                ...account,
                resources: account.resources.map(withoutNullRemediation),
              })),
            })),
          ),
      ),
    applyResize: async (resource: OversizedResource, accountId: string) => {
      await runRpc(
        cloudClient("resources").resources.update({
          params: { orgId: requireOrg() },
          payload: {
            accountId,
            pluginId: resource.pluginId,
            resourceTypeId: resource.resourceTypeId,
            resourceId: resource.id,
            fields: { [resource.sizeFieldKey]: resource.recommendedSize.id },
          },
        }),
      );
    },
  };
}
