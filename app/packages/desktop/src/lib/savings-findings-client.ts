import type {
  SavingsFindingFilter,
  SavingsFindingStatusInput,
  SavingsFindingStatusResult,
  SavingsFindingsResponse,
  SavingsView,
  SavingsViewInput,
} from "@infrawrench/client-core";
import { useUIStore, type SavingsFindingsClient } from "@infrawrench/ui";
import type { Effect } from "effect";
import { cloudClient, withServerMessage as serverMessage } from "./cloud-client";
import { createDesktopSharingClient } from "./cost-reports-client";
import { runRpc, type DesktopRpcClient } from "./rpc/client";

/**
 * The call run with the server's `{ error }` sentence in place of the
 * transport's `Cloud request failed: ...` message, which is what the section
 * shows; a body without one keeps the transport's message.
 */
function withServerMessage<A, E>(call: Effect.Effect<A, E, DesktopRpcClient>): Promise<A> {
  return runRpc(serverMessage(call));
}

/**
 * The bodies as the endpoints take them: client-core lets an optional field
 * be explicitly `undefined`, which the schemas refuse, so it is left out
 * (what `JSON.stringify` sent before).
 */
function statusPayload(input: SavingsFindingStatusInput) {
  return {
    keys: input.keys,
    status: input.status,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
}

function filterPayload(filter: SavingsFindingFilter) {
  return {
    ...(filter.kinds !== undefined ? { kinds: filter.kinds } : {}),
    ...(filter.pluginIds !== undefined ? { pluginIds: filter.pluginIds } : {}),
    ...(filter.accountIds !== undefined ? { accountIds: filter.accountIds } : {}),
    ...(filter.regions !== undefined ? { regions: filter.regions } : {}),
    ...(filter.tags !== undefined
      ? {
          tags: filter.tags.map((tag) => ({
            key: tag.key,
            ...(tag.values !== undefined ? { values: tag.values } : {}),
          })),
        }
      : {}),
    ...(filter.minMonthlySavings !== undefined
      ? { minMonthlySavings: filter.minMonthlySavings }
      : {}),
    ...(filter.detectedFrom !== undefined ? { detectedFrom: filter.detectedFrom } : {}),
    ...(filter.detectedTo !== undefined ? { detectedTo: filter.detectedTo } : {}),
    ...(filter.search !== undefined ? { search: filter.search } : {}),
  };
}

function viewPayload(input: SavingsViewInput) {
  return {
    name: input.name,
    status: input.status,
    filter: filterPayload(input.filter),
    sort: input.sort,
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
}

const findings = () => cloudClient("savingsFindings").savingsFindings;
const views = () => cloudClient("savingsFindings").savingsViews;

/**
 * The savings findings workflow's data access; cloud-mode only (the caller
 * leaves the section off without an active cloud org). The org is resolved at
 * call time, the seats-client convention, so switching org under a mounted
 * Costs tab reaches the right data.
 */
export function createDesktopSavingsFindingsClient(): SavingsFindingsClient {
  const requireOrg = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) throw new Error("Sign in to Infrawrench Cloud to see savings findings");
    return orgId;
  };
  return {
    listFindings: (opts): Promise<SavingsFindingsResponse> =>
      withServerMessage(
        findings().list({
          params: { orgId: requireOrg() },
          query: opts?.refresh === true ? { refresh: "true" } : {},
        }),
      ),
    setStatus: (input): Promise<SavingsFindingStatusResult> =>
      withServerMessage(
        findings().setStatus({ params: { orgId: requireOrg() }, payload: statusPayload(input) }),
      ),
    listViews: (): Promise<SavingsView[]> =>
      withServerMessage(views().list({ params: { orgId: requireOrg() } })),
    createView: (input): Promise<SavingsView> =>
      withServerMessage(
        views().create({ params: { orgId: requireOrg() }, payload: viewPayload(input) }),
      ),
    updateView: (id, input): Promise<SavingsView> =>
      withServerMessage(
        views().update({ params: { orgId: requireOrg(), id }, payload: viewPayload(input) }),
      ),
    deleteView: async (id) => {
      await withServerMessage(views().delete({ params: { orgId: requireOrg(), id } }));
    },
    sharing: createDesktopSharingClient(),
  };
}
