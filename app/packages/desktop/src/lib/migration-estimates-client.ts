import { useUIStore } from "@infrawrench/ui";
import type { MigrationEstimatesClient } from "@infrawrench/ui/migration-estimates/types";
import type { MigrationEstimateInput } from "@infrawrench/client-core";
import { cloudClient } from "./cloud-client";
import { listCloudServices } from "./cloud-services";
import { runRpc } from "./rpc/client";

/**
 * Migration estimates are cloud-only: the current side is the org's billed
 * spend and the target side is priced with the org's accounts. Typed calls to
 * the contract's `migrationEstimates` domain over the cloud transport
 * (`./cloud-client.ts`). The active org is resolved at call time, because the
 * org can change under a mounted panel. Every method is offered; the server
 * enforces `costs:write` and the panel shows its error.
 */
const estimates = () => cloudClient("migrationEstimates").migrationEstimates;

function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Migration estimates require cloud mode: sign in to sync.");
  return orgId;
}

/** The body the endpoints take: override keys the editor left `undefined` are dropped. */
function payload(input: MigrationEstimateInput) {
  const overrides: Record<string, { resourceTypeId?: string; sizeId?: string }> = {};
  for (const [id, o] of Object.entries(input.overrides)) {
    overrides[id] = {
      ...(o.resourceTypeId !== undefined ? { resourceTypeId: o.resourceTypeId } : {}),
      ...(o.sizeId !== undefined ? { sizeId: o.sizeId } : {}),
    };
  }
  return {
    name: input.name,
    source: input.source,
    targetPluginId: input.targetPluginId,
    targetRegion: input.targetRegion,
    overrides,
  };
}

export function createDesktopMigrationEstimatesClient(): MigrationEstimatesClient {
  return {
    targets: async () =>
      (await runRpc(estimates().targets({ params: { orgId: requireOrgId() } }))).providers,
    list: () => runRpc(estimates().list({ params: { orgId: requireOrgId() } })),
    get: (id) => runRpc(estimates().get({ params: { orgId: requireOrgId(), id } })),
    result: (id) => runRpc(estimates().result({ params: { orgId: requireOrgId(), id } })),
    terraform: (id) => runRpc(estimates().terraform({ params: { orgId: requireOrgId(), id } })),
    listServices: async () =>
      (await listCloudServices(requireOrgId())).services.map((s) => ({ id: s.id, name: s.name })),
    create: (input) =>
      runRpc(estimates().create({ params: { orgId: requireOrgId() }, payload: payload(input) })),
    update: (id, input) =>
      runRpc(
        estimates().update({ params: { orgId: requireOrgId(), id }, payload: payload(input) }),
      ),
    remove: async (id) => {
      await runRpc(estimates().delete({ params: { orgId: requireOrgId(), id } }));
    },
    createScenario: (id, input) =>
      runRpc(estimates().scenario({ params: { orgId: requireOrgId(), id }, payload: input })),
  };
}
