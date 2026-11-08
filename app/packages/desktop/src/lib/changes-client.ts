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
import { Effect } from "effect";
import { listCloudAccounts } from "./cloud-accounts";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const changes = () => cloudClient("changes").changes;

/**
 * client-core types a field change's values as always present; on the wire
 * an `undefined` one is left out (the contract marks them optional), so the
 * key is put back.
 */
function fieldChange<Change extends { readonly from?: unknown; readonly to?: unknown }>(
  change: Change,
) {
  return { ...change, from: change.from, to: change.to };
}

/** The same for one field of a revert plan. */
function revertField<
  Field extends {
    readonly revertTo?: unknown;
    readonly changedTo?: unknown;
    readonly current?: unknown;
  },
>(field: Field) {
  return {
    ...field,
    revertTo: field.revertTo,
    changedTo: field.changedTo,
    current: field.current,
  };
}

/**
 * The change timeline is cloud-only: the events are recorded by the cloud
 * poller as it re-syncs accounts, and local-only mode has no poller. Resolves
 * the active org at call time (not at client construction) so switching org
 * under a mounted Changes page reaches the new org's feed: same convention as
 * the costs and orphans clients.
 */
export function createDesktopChangesClient(): ChangesClient {
  const requireOrg = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) {
      throw new Error("The change timeline requires cloud mode: sign in to sync.");
    }
    return orgId;
  };

  return {
    listChanges: (query: ChangeFeedQuery): Promise<ChangeFeedPage> =>
      runRpc(
        changes()
          .list({
            params: { orgId: requireOrg() },
            query: {
              page: String(query.page),
              pageSize: String(query.pageSize),
              ...(query.accountId ? { accountId: query.accountId } : {}),
              ...(query.kind ? { kind: query.kind } : {}),
            },
          })
          .pipe(
            Effect.map((page) => ({
              ...page,
              entries: page.entries.map((entry) => ({
                ...entry,
                diff: entry.diff.map(fieldChange),
              })),
            })),
          ),
      ),
    listAccounts: async (): Promise<ChangeFeedAccount[]> => {
      const rows = await listCloudAccounts(requireOrg());
      return rows.map((a) => ({ id: a.id, displayName: a.displayName }));
    },
    costImpacts: async (changeIds) => {
      const result = await runRpc(
        changes().costImpacts({ params: { orgId: requireOrg() }, payload: { changeIds } }),
      );
      return result.impacts;
    },
    annotateCostImpact: async (changeId) => {
      await runRpc(
        cloudClient("costAnnotations").changeImpactAnnotations.pin({
          params: { orgId: requireOrg() },
          payload: { subjectKind: "change", subjectId: changeId },
        }),
      );
    },
    revert: createDesktopChangeRevertClient(requireOrg),
  };
}

/**
 * Time-travel undo: the dry run and the real revert, two endpoints on one path. Takes the org resolver
 * rather than an id for the same reason the feed does: an org switch under a
 * mounted panel must reach the new org.
 */
function createDesktopChangeRevertClient(requireOrg: () => string): ChangeRevertClient {
  return {
    preview: (changeId): Promise<RevertPreviewResponse> =>
      runRpc(
        changes()
          .revertPreview({ params: { orgId: requireOrg(), changeId } })
          .pipe(
            Effect.map((preview) => ({
              ...preview,
              plan: { ...preview.plan, fields: preview.plan.fields.map(revertField) },
            })),
          ),
      ),
    apply: (changeId): Promise<RevertApplyResponse> =>
      runRpc(
        changes()
          .revert({ params: { orgId: requireOrg(), changeId } })
          .pipe(
            Effect.map((applied) => ({
              ...applied,
              plan: { ...applied.plan, fields: applied.plan.fields.map(revertField) },
            })),
          ),
      ),
  };
}
