import {
  useUIStore,
  type IacAccountOption,
  type IacClient,
  type IacStateUpload,
} from "@infrawrench/ui";
import type {
  IacImportPlanResponse,
  IacReconciliationResponse,
  IacStateSummary,
} from "@infrawrench/client-core";
import { invoke } from "./invoke";
import { listCloudAccounts } from "./cloud-accounts";

/**
 * IaC reconciliation is cloud-only: it classifies the org's *synced*
 * inventory, which local-only mode does not have. Resolves the active org at
 * call time (not at construction) so switching org under a mounted page
 * reaches the new org — same convention as the changes and costs clients.
 */
export function createDesktopIacClient(): IacClient {
  const requireOrg = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) {
      throw new Error("IaC reconciliation requires cloud mode — sign in to sync.");
    }
    return orgId;
  };

  return {
    listStates: async () => {
      const res = await invoke<{ states: IacStateSummary[] }>("cloud_iac_states", {
        orgId: requireOrg(),
      });
      return res.states;
    },
    uploadState: async (upload: IacStateUpload) => {
      const res = await invoke<{ state: IacStateSummary }>("cloud_iac_upload_state", {
        orgId: requireOrg(),
        label: upload.label,
        accountId: upload.accountId,
        document: upload.document,
      });
      return res.state;
    },
    deleteState: async (stateId: string) => {
      await invoke("cloud_iac_delete_state", { orgId: requireOrg(), stateId });
    },
    reconcile: (stateId: string) =>
      invoke<IacReconciliationResponse>("cloud_iac_reconcile", { orgId: requireOrg(), stateId }),
    buildImportPlan: (resourceIds: string[]) =>
      invoke<IacImportPlanResponse>("cloud_iac_import_plan", { orgId: requireOrg(), resourceIds }),
    listAccounts: async (): Promise<IacAccountOption[]> => {
      const rows = await listCloudAccounts(requireOrg());
      return rows.map((a) => ({ id: a.id, displayName: a.displayName }));
    },
  };
}
