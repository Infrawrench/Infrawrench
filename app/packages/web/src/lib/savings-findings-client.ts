import type {
  SavingsFindingStatusResult,
  SavingsFindingsResponse,
  SavingsView,
} from "@infrawrench/client-core";
import type { SavingsFindingsClient } from "@infrawrench/ui";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { createWebSharingClient } from "./cost-client";

/** Web implementation of the savings findings workflow's data access. */
export function createWebSavingsFindingsClient(orgId: string): SavingsFindingsClient {
  const base = `/api/org/${orgId}`;
  return {
    listFindings: (opts) =>
      apiGet<SavingsFindingsResponse>(
        `${base}/savings/findings${opts?.refresh ? "?refresh=true" : ""}`,
      ),
    setStatus: (input) =>
      apiPost<SavingsFindingStatusResult>(`${base}/savings/findings/status`, input),
    listViews: () => apiGet<SavingsView[]>(`${base}/savings-views`),
    createView: (input) => apiPost<SavingsView>(`${base}/savings-views`, input),
    updateView: (id, input) =>
      apiPut<SavingsView>(`${base}/savings-views/${encodeURIComponent(id)}`, input),
    deleteView: async (id) => {
      await apiDelete(`${base}/savings-views/${encodeURIComponent(id)}`);
    },
    sharing: createWebSharingClient(orgId),
  };
}
