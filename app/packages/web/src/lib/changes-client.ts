import type {
  ChangeFeedAccount,
  ChangeFeedPage,
  ChangeFeedQuery,
  ChangesClient,
} from "@infrawrench/ui";
import { apiGet } from "./api";

/** Web binding for the shared change-timeline panel — a thin `apiGet` wrapper. */
export function createWebChangesClient(orgId: string): ChangesClient {
  return {
    listChanges: (query: ChangeFeedQuery) => {
      const params = new URLSearchParams({
        page: String(query.page),
        pageSize: String(query.pageSize),
      });
      if (query.kind) params.set("kind", query.kind);
      if (query.accountId) params.set("accountId", query.accountId);
      return apiGet<ChangeFeedPage>(`/api/org/${orgId}/changes?${params}`);
    },
    listAccounts: () => apiGet<ChangeFeedAccount[]>(`/api/org/${orgId}/accounts`),
  };
}
