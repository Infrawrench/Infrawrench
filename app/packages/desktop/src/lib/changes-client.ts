import {
  useUIStore,
  type ChangeFeedAccount,
  type ChangeFeedPage,
  type ChangeFeedQuery,
  type ChangesClient,
} from "@infrawrench/ui";
import { invoke } from "./invoke";
import { listCloudAccounts } from "./cloud-accounts";

/**
 * The change timeline is cloud-only: the events are recorded by the cloud
 * poller as it re-syncs accounts, and local-only mode has no poller. Resolves
 * the active org at call time (not at client construction) so switching org
 * under a mounted Changes page reaches the new org's feed — same convention as
 * the costs and orphans clients.
 */
export function createDesktopChangesClient(): ChangesClient {
  const requireOrg = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) {
      throw new Error("The change timeline requires cloud mode — sign in to sync.");
    }
    return orgId;
  };

  return {
    listChanges: (query: ChangeFeedQuery) =>
      invoke<ChangeFeedPage>("cloud_changes_list", {
        orgId: requireOrg(),
        page: query.page,
        pageSize: query.pageSize,
        ...(query.accountId ? { accountId: query.accountId } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
      }),
    listAccounts: async (): Promise<ChangeFeedAccount[]> => {
      const rows = await listCloudAccounts(requireOrg());
      return rows.map((a) => ({ id: a.id, displayName: a.displayName }));
    },
  };
}
