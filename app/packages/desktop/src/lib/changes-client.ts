import type { ChangeCostImpactEntry } from "@infrawrench/client-core";
import {
  useUIStore,
  type ChangeFeedAccount,
  type ChangeFeedPage,
  type ChangeFeedQuery,
  type ChangeRevertClient,
  type ChangesClient,
  type RevertApplyResponse,
  type RevertPreviewResponse,
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
    costImpacts: async (changeIds) => {
      const result = await invoke<{ impacts: ChangeCostImpactEntry[] }>(
        "cloud_changes_cost_impacts",
        { orgId: requireOrg(), changeIds },
      );
      return result?.impacts ?? [];
    },
    annotateCostImpact: async (changeId) => {
      await invoke("cloud_cost_impact_annotate", {
        orgId: requireOrg(),
        subjectKind: "change",
        subjectId: changeId,
      });
    },
    revert: createDesktopChangeRevertClient(requireOrg),
  };
}

/**
 * Time-travel undo over the two cloud IPC channels. Takes the org resolver
 * rather than an id for the same reason the feed does — an org switch under a
 * mounted panel must reach the new org.
 */
function createDesktopChangeRevertClient(requireOrg: () => string): ChangeRevertClient {
  return {
    preview: (changeId) =>
      invoke<RevertPreviewResponse>("cloud_change_revert_preview", {
        orgId: requireOrg(),
        changeId,
      }),
    apply: (changeId) =>
      invoke<RevertApplyResponse>("cloud_change_revert_apply", {
        orgId: requireOrg(),
        changeId,
      }),
  };
}
