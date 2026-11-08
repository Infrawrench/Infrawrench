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
import { Effect } from "effect";
import { listCloudAccounts } from "./cloud-accounts";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const iac = () => cloudClient("iac").iac;

/**
 * IaC reconciliation is cloud-only: it classifies the org's *synced*
 * inventory, which local-only mode does not have. Resolves the active org at
 * call time (not at construction) so switching org under a mounted page
 * reaches the new org: same convention as the changes and costs clients.
 */
export function createDesktopIacClient(): IacClient {
  const requireOrg = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) {
      throw new Error("IaC reconciliation requires cloud mode: sign in to sync.");
    }
    return orgId;
  };

  return {
    listStates: async () => {
      const res = await runRpc(iac().listStates({ params: { orgId: requireOrg() } }));
      const states: IacStateSummary[] = res.states;
      return states;
    },
    uploadState: async (upload: IacStateUpload) => {
      const res = await runRpc(
        iac().uploadState({
          params: { orgId: requireOrg() },
          payload: {
            label: upload.label,
            accountId: upload.accountId,
            document: upload.document,
          },
        }),
      );
      const state: IacStateSummary = res.state;
      return state;
    },
    deleteState: async (stateId: string) => {
      await runRpc(iac().deleteState({ params: { orgId: requireOrg(), stateId } }));
    },
    reconcile: (stateId: string): Promise<IacReconciliationResponse> =>
      runRpc(
        iac()
          .reconciliation({ params: { orgId: requireOrg() }, query: { stateId } })
          .pipe(
            Effect.map((response) => ({
              ...response,
              resources: response.resources.map((resource) => ({
                ...resource,
                // client-core types a drifted field's values as always
                // present; the wire leaves an `undefined` one out.
                drift: resource.drift.map((change) => ({
                  ...change,
                  from: change.from,
                  to: change.to,
                })),
              })),
            })),
          ),
      ),
    buildImportPlan: (resourceIds: string[]): Promise<IacImportPlanResponse> =>
      runRpc(iac().importPlan({ params: { orgId: requireOrg() }, payload: { resourceIds } })),
    listAccounts: async (): Promise<IacAccountOption[]> => {
      const rows = await listCloudAccounts(requireOrg());
      return rows.map((a) => ({ id: a.id, displayName: a.displayName }));
    },
  };
}
