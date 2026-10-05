import type { ExtendedSupportClient, ExtendedSupportListResponse } from "@infrawrench/ui";
import { apiGet } from "./api";

/** Web implementation of the Extended support section's data access. */
export function createWebExtendedSupportClient(orgId: string): ExtendedSupportClient {
  return {
    listExtendedSupport: (refresh?: boolean) =>
      apiGet<ExtendedSupportListResponse>(
        `/api/org/${orgId}/extended-support${refresh ? "?refresh=true" : ""}`,
      ),
  };
}
