import type {
  MigrationEstimatesClient,
  MigrationScenarioCreated,
} from "@infrawrench/ui/migration-estimates/types";
import type {
  MigrationEstimate,
  MigrationEstimateResult,
  MigrationTargetProvider,
  MigrationTerraformResult,
  ServiceListResponse,
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

/**
 * Web implementation of the shared migration estimates client, per org.
 * `canWrite` (`costs:write`) gates saving, editing, deleting and creating a
 * scenario model; without it the panel is read-only, and the server enforces
 * it either way.
 */
export function createWebMigrationEstimatesClient(
  orgId: string,
  canWrite: boolean,
): MigrationEstimatesClient {
  const org = `/api/org/${encodeURIComponent(orgId)}`;
  const base = `${org}/migration-estimates`;
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
  const read: MigrationEstimatesClient = {
    targets: async () =>
      (await apiGet<{ providers: MigrationTargetProvider[] }>(`${base}/targets`)).providers,
    list: () => apiGet<MigrationEstimate[]>(base),
    get: (id) => apiGet<MigrationEstimate>(one(id)),
    result: (id) => apiGet<MigrationEstimateResult>(`${one(id)}/result`),
    terraform: (id) => apiGet<MigrationTerraformResult>(`${one(id)}/terraform`),
    listServices: async () =>
      (await apiGet<ServiceListResponse>(`${org}/services`)).services.map((s) => ({
        id: s.id,
        name: s.name,
      })),
  };
  if (!canWrite) return read;
  return {
    ...read,
    create: (input) => apiPost<MigrationEstimate>(base, input),
    update: (id, input) => apiPut<MigrationEstimate>(one(id), input),
    remove: async (id) => {
      await apiDelete(one(id));
    },
    createScenario: (id, input) => apiPost<MigrationScenarioCreated>(`${one(id)}/scenario`, input),
  };
}
