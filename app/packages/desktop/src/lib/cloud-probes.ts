/**
 * Synthetic probes: cloud-mode only (checks run in the cloud poller through
 * the egress proxy). Typed calls to the contract's `probes` domain over the
 * cloud transport (`./cloud-client.ts`); each answer is the server's JSON,
 * handed on as the client-core type the panels use, so a contract change the
 * desktop's types disagree with fails here at compile time.
 */
import type {
  ProbeCreate,
  ProbeListResponse,
  ProbeMetricsResponse,
  ProbePatch,
  ProbeSuggestionsResponse,
  SyntheticProbe,
} from "@infrawrench/client-core";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const probes = () => cloudClient("probes").probes;

export function listCloudProbes(orgId: string): Promise<ProbeListResponse> {
  return runRpc(probes().list({ params: { orgId } }));
}

export function listCloudProbeSuggestions(orgId: string): Promise<ProbeSuggestionsResponse> {
  return runRpc(probes().suggestions({ params: { orgId } }));
}

export function fetchCloudProbeMetrics(
  orgId: string,
  probeId: string,
  range: { startMs: number; endMs: number },
): Promise<ProbeMetricsResponse> {
  return runRpc(
    probes().metrics({
      params: { orgId, probeId },
      query: { startMs: String(range.startMs), endMs: String(range.endMs) },
    }),
  );
}

/**
 * The create body the endpoint documents. client-core's `ProbeCreate` also
 * carries the suggestion's `accountId`/`pluginId`/`resourceTypeId` and
 * allows nulls; the server reads only a string `resourceId` and `outputKey`
 * (the store derives the rest from the resource), so those are what is sent.
 */
function createPayload(input: ProbeCreate) {
  const { resourceId, outputKey } = input;
  return {
    name: input.name,
    url: input.url,
    ...(input.method !== undefined ? { method: input.method } : {}),
    ...(input.intervalSeconds !== undefined ? { intervalSeconds: input.intervalSeconds } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.failureThreshold !== undefined ? { failureThreshold: input.failureThreshold } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(resourceId != null ? { resourceId } : {}),
    ...(outputKey != null ? { outputKey } : {}),
  };
}

export function createCloudProbe(orgId: string, input: ProbeCreate): Promise<SyntheticProbe> {
  return runRpc(probes().create({ params: { orgId }, payload: createPayload(input) }));
}

export function updateCloudProbe(
  orgId: string,
  probeId: string,
  patch: ProbePatch,
): Promise<SyntheticProbe> {
  return runRpc(probes().update({ params: { orgId, probeId }, payload: patch }));
}

export function deleteCloudProbe(orgId: string, probeId: string): Promise<void> {
  return runRpc(probes().delete({ params: { orgId, probeId } }));
}
