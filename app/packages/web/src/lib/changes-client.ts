import type {
  ChangeFeedAccount,
  ChangeFeedPage,
  ChangeFeedQuery,
  ChangeRevertClient,
  ChangesClient,
  RevertApplyResponse,
  RevertPreviewResponse,
} from "@infrawrench/ui";
import { apiGet, apiPost } from "./api";

/**
 * Web binding for the revert half of the change timeline. Split out so the
 * per-resource Changes tab, which has no feed client, can use it on its own.
 */
export function createWebChangeRevertClient(orgId: string): ChangeRevertClient {
  return {
    preview: (changeId) =>
      apiGet<RevertPreviewResponse>(`/api/org/${orgId}/changes/${changeId}/revert`),
    apply: (changeId) =>
      apiPost<RevertApplyResponse>(`/api/org/${orgId}/changes/${changeId}/revert`),
  };
}

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
    revert: createWebChangeRevertClient(orgId),
  };
}
