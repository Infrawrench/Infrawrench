import type {
  OversizedResource,
  RightsizingClient,
  RightsizingListResponse,
} from "@infrawrench/ui";
import { apiGet, apiPost } from "./api";

/**
 * Web implementation of the Oversized section's host-injected data access.
 *
 * `applyResize` goes through `POST /resources/update` — the same route the
 * resource edit form uses — so the resize inherits change-freeze enforcement
 * (a 423 rejects here with the freeze's own message) and audit logging.
 */
export function createWebRightsizingClient(orgId: string): RightsizingClient {
  return {
    listRightsizing: (refresh?: boolean) =>
      apiGet<RightsizingListResponse>(
        `/api/org/${orgId}/rightsizing${refresh ? "?refresh=true" : ""}`,
      ),
    applyResize: async (resource: OversizedResource, accountId: string) => {
      await apiPost(`/api/org/${orgId}/resources/update`, {
        accountId,
        pluginId: resource.pluginId,
        resourceTypeId: resource.resourceTypeId,
        resourceId: resource.id,
        fields: { [resource.sizeFieldKey]: resource.recommendedSize.id },
      });
    },
  };
}
