import type { IacAccountOption, IacClient, IacStateUpload } from "@infrawrench/ui";
import type {
  IacImportPlanResponse,
  IacManagedBy,
  IacReconciliationResponse,
  IacResourceStatusResponse,
  IacStateSummary,
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPost } from "./api";

/** Web binding for the shared IaC reconciliation panel: thin `api*` wrappers. */
export function createWebIacClient(orgId: string): IacClient {
  const base = `/api/org/${orgId}/iac`;
  return {
    listStates: async () => (await apiGet<{ states: IacStateSummary[] }>(`${base}/states`)).states,
    uploadState: async (upload: IacStateUpload) =>
      (await apiPost<{ state: IacStateSummary }>(`${base}/states`, upload)).state,
    deleteState: async (stateId: string) => {
      await apiDelete(`${base}/states/${encodeURIComponent(stateId)}`);
    },
    reconcile: (stateId: string) =>
      apiGet<IacReconciliationResponse>(
        `${base}/reconciliation?stateId=${encodeURIComponent(stateId)}`,
      ),
    buildImportPlan: (resourceIds: string[]) =>
      apiPost<IacImportPlanResponse>(`${base}/import-plan`, { resourceIds }),
    listAccounts: () => apiGet<IacAccountOption[]>(`/api/org/${orgId}/accounts`),
  };
}

/** The forge workspaces that manage one resource, for the resource page's "Managed by" line. */
export async function fetchWebManagedBy(
  orgId: string,
  resourceId: string,
): Promise<IacManagedBy[]> {
  const res = await apiGet<IacResourceStatusResponse>(
    `/api/org/${encodeURIComponent(orgId)}/iac/resource?resourceId=${encodeURIComponent(resourceId)}`,
  );
  return res.managedBy ?? [];
}
