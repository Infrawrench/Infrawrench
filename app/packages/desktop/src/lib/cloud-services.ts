/**
 * Services and scorecards: cloud-mode only. One wrapper per allowlisted IPC
 * channel, matching `cloud-slos.ts`.
 */
import type {
  DiscoveredTagKeysResponse,
  OnCallSchedule,
  Scorecard,
  ScorecardInput,
  ScorecardListResponse,
  ScorecardOverviewResponse,
  Service,
  ServiceDetailResponse,
  ServiceInput,
  ServiceListResponse,
  ServiceScorecardsResponse,
  ServicesForResourcesResponse,
  ServiceSummaryResponse,
  VirtualTag,
} from "@infrawrench/client-core";
import type { ServiceResourceOption } from "@infrawrench/ui/services";
import { invoke } from "./invoke";

export async function listCloudServices(orgId: string): Promise<ServiceListResponse> {
  return invoke("cloud_services_list", { orgId });
}

export async function getCloudService(
  orgId: string,
  serviceId: string,
): Promise<ServiceDetailResponse> {
  return invoke("cloud_services_get", { orgId, serviceId });
}

export async function getCloudServiceSummary(
  orgId: string,
  serviceId: string,
): Promise<ServiceSummaryResponse> {
  return invoke("cloud_services_summary", { orgId, serviceId });
}

export async function getCloudServiceScorecards(
  orgId: string,
  serviceId: string,
): Promise<ServiceScorecardsResponse> {
  return invoke("cloud_services_scorecards", { orgId, serviceId });
}

export async function createCloudService(orgId: string, input: ServiceInput): Promise<Service> {
  return invoke("cloud_services_create", { orgId, input });
}

export async function updateCloudService(
  orgId: string,
  serviceId: string,
  patch: Partial<ServiceInput>,
): Promise<Service> {
  return invoke("cloud_services_update", { orgId, serviceId, patch });
}

export async function deleteCloudService(orgId: string, serviceId: string): Promise<void> {
  await invoke("cloud_services_delete", { orgId, serviceId });
}

export async function addCloudServiceMembers(
  orgId: string,
  serviceId: string,
  resourceIds: string[],
): Promise<ServiceDetailResponse> {
  return invoke("cloud_services_add_members", { orgId, serviceId, resourceIds });
}

export async function removeCloudServiceMember(
  orgId: string,
  serviceId: string,
  resourceId: string,
): Promise<ServiceDetailResponse> {
  return invoke("cloud_services_remove_member", { orgId, serviceId, resourceId });
}

export async function restoreCloudServiceMember(
  orgId: string,
  serviceId: string,
  resourceId: string,
): Promise<ServiceDetailResponse> {
  return invoke("cloud_services_restore_member", { orgId, serviceId, resourceId });
}

export async function getCloudServicesForResources(
  orgId: string,
  resourceIds: string[],
): Promise<ServicesForResourcesResponse> {
  return invoke("cloud_services_for_resources", { orgId, resourceIds });
}

export async function listCloudOnCallSchedules(orgId: string): Promise<OnCallSchedule[]> {
  const res = await invoke<{ schedules: OnCallSchedule[] }>("cloud_services_oncall_schedules", {
    orgId,
  });
  return res?.schedules ?? [];
}

export async function listCloudTagKeys(orgId: string): Promise<DiscoveredTagKeysResponse> {
  return invoke("cloud_services_tag_keys", { orgId });
}

export async function listCloudVirtualTags(orgId: string): Promise<VirtualTag[]> {
  return (await invoke<VirtualTag[] | null>("cloud_services_virtual_tags", { orgId })) ?? [];
}

export async function listCloudScorecards(orgId: string): Promise<ScorecardListResponse> {
  return invoke("cloud_scorecards_list", { orgId });
}

export async function getCloudScorecardOverview(orgId: string): Promise<ScorecardOverviewResponse> {
  return invoke("cloud_scorecards_overview", { orgId });
}

export async function createCloudScorecard(
  orgId: string,
  input: ScorecardInput,
): Promise<Scorecard> {
  return invoke("cloud_scorecards_create", { orgId, input });
}

export async function updateCloudScorecard(
  orgId: string,
  scorecardId: string,
  patch: Partial<ScorecardInput>,
): Promise<Scorecard> {
  return invoke("cloud_scorecards_update", { orgId, scorecardId, patch });
}

export async function deleteCloudScorecard(orgId: string, scorecardId: string): Promise<void> {
  await invoke("cloud_scorecards_delete", { orgId, scorecardId });
}

export async function evaluateCloudScorecard(
  orgId: string,
  scorecardId: string,
): Promise<ScorecardOverviewResponse> {
  return invoke("cloud_scorecards_evaluate", { orgId, scorecardId });
}

/**
 * The spotlight resource index, through the channel the savings log already
 * uses rather than a second one onto the same `GET /search`. The index also
 * returns workflows; only resources can be members.
 */
export async function searchCloudServiceResources(
  orgId: string,
  query: string,
): Promise<ServiceResourceOption[]> {
  const rows = await invoke<ServiceResourceOption[] | null>("cloud_savings_search_resources", {
    orgId,
    query,
  });
  return (rows ?? []).filter((r) => r.pluginId !== "__workflows__");
}
