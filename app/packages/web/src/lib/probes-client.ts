import type { ProbesClient } from "@infrawrench/ui/probes";
import type {
  ProbeCreate,
  ProbeListResponse,
  ProbePatch,
  ProbeSuggestionsResponse,
  SyntheticProbe,
} from "@infrawrench/client-core";
import type { MetricSeries } from "@infrawrench/plugin-base";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

/** Web implementation of the shared probes client, per org. */
export function createWebProbesClient(orgId: string): ProbesClient {
  const base = `/api/org/${encodeURIComponent(orgId)}/probes`;
  return {
    listProbes: async () => (await apiGet<ProbeListResponse>(base)).probes,
    listSuggestions: async () =>
      (await apiGet<ProbeSuggestionsResponse>(`${base}/suggestions`)).suggestions,
    probeMetrics: async (probeId, range) => {
      const params = new URLSearchParams({
        startMs: String(range.startMs),
        endMs: String(range.endMs),
      });
      const res = await apiGet<{ series: MetricSeries[] }>(
        `${base}/${encodeURIComponent(probeId)}/metrics?${params.toString()}`,
      );
      return res.series;
    },
    createProbe: (input: ProbeCreate) => apiPost<SyntheticProbe>(base, input),
    updateProbe: (probeId: string, patch: ProbePatch) =>
      apiPut<SyntheticProbe>(`${base}/${encodeURIComponent(probeId)}`, patch),
    deleteProbe: async (probeId: string) => {
      await apiDelete(`${base}/${encodeURIComponent(probeId)}`);
    },
  };
}
