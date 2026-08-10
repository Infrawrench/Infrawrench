/**
 * Synthetic probes — cloud-mode only (checks run in the cloud poller through
 * the egress proxy). One wrapper per allowlisted IPC channel, matching
 * `cloud-metric-alerts.ts`.
 */
import type {
  ProbeCreate,
  ProbeListResponse,
  ProbeMetricsResponse,
  ProbePatch,
  ProbeSuggestionsResponse,
  SyntheticProbe,
} from "@infrawrench/client-core";
import { invoke } from "./invoke";

export async function listCloudProbes(orgId: string): Promise<ProbeListResponse> {
  return invoke("cloud_probes_list", { orgId });
}

export async function listCloudProbeSuggestions(orgId: string): Promise<ProbeSuggestionsResponse> {
  return invoke("cloud_probes_suggestions", { orgId });
}

export async function fetchCloudProbeMetrics(
  orgId: string,
  probeId: string,
  range: { startMs: number; endMs: number },
): Promise<ProbeMetricsResponse> {
  return invoke("cloud_probes_metrics", { orgId, probeId, ...range });
}

export async function createCloudProbe(orgId: string, input: ProbeCreate): Promise<SyntheticProbe> {
  return invoke("cloud_probes_create", { orgId, input });
}

export async function updateCloudProbe(
  orgId: string,
  probeId: string,
  patch: ProbePatch,
): Promise<SyntheticProbe> {
  return invoke("cloud_probes_update", { orgId, probeId, patch });
}

export async function deleteCloudProbe(orgId: string, probeId: string): Promise<void> {
  await invoke("cloud_probes_delete", { orgId, probeId });
}
