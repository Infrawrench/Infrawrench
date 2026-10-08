import type { SlosClient } from "@infrawrench/ui/slos";
import type {
  Slo,
  SloActiveFreeze,
  SloDetailResponse,
  SloInput,
  SloListResponse,
  SloSourcesResponse,
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

/**
 * Web implementation of the shared SLOs client, per org. `canWrite` and
 * `canFreeze` gate the mutating halves (the `ProbesClient` convention): the
 * panel renders read-only without them, and the server enforces regardless.
 */
export function createWebSlosClient(orgId: string, canWrite = true, canFreeze = false): SlosClient {
  const base = `/api/org/${encodeURIComponent(orgId)}/slos`;
  const read: SlosClient = {
    listSlos: async () => (await apiGet<SloListResponse>(base)).slos,
    getSlo: (sloId) => apiGet<SloDetailResponse>(`${base}/${encodeURIComponent(sloId)}`),
    listSources: () => apiGet<SloSourcesResponse>(`${base}/sources`),
  };
  return {
    ...read,
    ...(canWrite
      ? {
          createSlo: (input: SloInput) => apiPost<Slo>(base, input),
          updateSlo: (sloId: string, patch: Partial<SloInput>) =>
            apiPut<Slo>(`${base}/${encodeURIComponent(sloId)}`, patch),
          deleteSlo: async (sloId: string) => {
            await apiDelete(`${base}/${encodeURIComponent(sloId)}`);
          },
        }
      : {}),
    ...(canFreeze
      ? {
          startFreeze: (sloId: string, request) =>
            apiPost<SloActiveFreeze>(`${base}/${encodeURIComponent(sloId)}/freeze`, request),
        }
      : {}),
  };
}
