/**
 * SLOs: cloud-mode only. One wrapper per allowlisted IPC channel, matching
 * `cloud-probes.ts`.
 */
import type {
  Slo,
  SloActiveFreeze,
  SloDetailResponse,
  SloFreezeRequest,
  SloInput,
  SloListResponse,
  SloSourcesResponse,
} from "@infrawrench/client-core";
import { invoke } from "./invoke";

export async function listCloudSlos(orgId: string): Promise<SloListResponse> {
  return invoke("cloud_slos_list", { orgId });
}

export async function getCloudSloSources(orgId: string): Promise<SloSourcesResponse> {
  return invoke("cloud_slos_sources", { orgId });
}

export async function getCloudSlo(orgId: string, sloId: string): Promise<SloDetailResponse> {
  return invoke("cloud_slos_get", { orgId, sloId });
}

export async function createCloudSlo(orgId: string, input: SloInput): Promise<Slo> {
  return invoke("cloud_slos_create", { orgId, input });
}

export async function updateCloudSlo(
  orgId: string,
  sloId: string,
  patch: Partial<SloInput>,
): Promise<Slo> {
  return invoke("cloud_slos_update", { orgId, sloId, patch });
}

export async function deleteCloudSlo(orgId: string, sloId: string): Promise<void> {
  await invoke("cloud_slos_delete", { orgId, sloId });
}

export async function startCloudSloFreeze(
  orgId: string,
  sloId: string,
  request: SloFreezeRequest,
): Promise<SloActiveFreeze> {
  return invoke("cloud_slos_freeze", { orgId, sloId, request });
}
