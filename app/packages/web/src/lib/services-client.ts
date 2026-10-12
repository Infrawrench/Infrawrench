import type {
  ServiceAccountOption,
  ServiceResourceOption,
  ServicesClient,
} from "@infrawrench/ui/services";
import type {
  DiscoveredTagKeysResponse,
  OnCallSchedule,
  OrgScorecardResponse,
  OwnerCandidate,
  Runbook,
  Scorecard,
  ScorecardInput,
  ScorecardListResponse,
  ScorecardOverviewResponse,
  Service,
  ServiceDetailResponse,
  ServiceInput,
  ServiceListResponse,
  ServiceRef,
  ServiceScorecardsResponse,
  ServicesForResourcesResponse,
  ServiceSummaryResponse,
  Slo,
  SloListResponse,
  VirtualTag,
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPatch, apiPost } from "./api";

export interface WebServicesPermissions {
  /** `resources:write`: create, edit and delete services and scorecards. */
  canWrite: boolean;
  /** `team:read`: the on-call schedule picker. */
  canReadTeam: boolean;
  /** `costs:read`: the virtual tag picker. */
  canReadCosts: boolean;
}

/**
 * Web implementation of the shared Services client, per org. The write
 * methods are only offered with `resources:write` (the `SlosClient`
 * convention), and the picker reads a caller cannot make answer an empty
 * list rather than a 403 the editor would have to explain.
 */
export function createWebServicesClient(
  orgId: string,
  permissions: WebServicesPermissions,
): ServicesClient {
  const org = `/api/org/${encodeURIComponent(orgId)}`;
  const services = `${org}/services`;
  const scorecards = `${org}/scorecards`;
  const one = (id: string) => `${services}/${encodeURIComponent(id)}`;
  const read: ServicesClient = {
    listServices: async () => (await apiGet<ServiceListResponse>(services)).services,
    getService: (id) => apiGet<ServiceDetailResponse>(one(id)),
    getServiceSummary: (id) => apiGet<ServiceSummaryResponse>(`${one(id)}/summary`),
    getServiceScorecards: (id) => apiGet<ServiceScorecardsResponse>(`${one(id)}/scorecards`),
    listScorecards: async () => (await apiGet<ScorecardListResponse>(scorecards)).scorecards,
    getScorecardOverview: () => apiGet<ScorecardOverviewResponse>(`${scorecards}/overview`),
    getOrgScorecard: () => apiGet<OrgScorecardResponse>(`${scorecards}/org`),
    listOwnerCandidates: async () =>
      (await apiGet<{ members: OwnerCandidate[] }>(`${org}/ownership/members`)).members,
    listOnCallSchedules: async () =>
      permissions.canReadTeam
        ? (await apiGet<{ schedules: OnCallSchedule[] }>(`${org}/on-call/schedules`)).schedules
        : [],
    listSlos: async (): Promise<Slo[]> => (await apiGet<SloListResponse>(`${org}/slos`)).slos,
    listRunbooks: async () => (await apiGet<{ runbooks: Runbook[] }>(`${org}/runbooks`)).runbooks,
    listTagKeys: () => apiGet<DiscoveredTagKeysResponse>(`${org}/tag-keys`),
    listVirtualTags: async () =>
      permissions.canReadCosts ? apiGet<VirtualTag[]>(`${org}/virtual-tags`) : [],
    listAccounts: () => apiGet<ServiceAccountOption[]>(`${org}/accounts`),
    searchResources: async (query) => {
      const rows = await apiGet<ServiceResourceOption[]>(
        `${org}/search?q=${encodeURIComponent(query)}`,
      );
      // The spotlight index also returns workflows; only resources can be members.
      return rows.filter((r) => r.pluginId !== "__workflows__");
    },
  };
  if (!permissions.canWrite) return read;
  return {
    ...read,
    createService: (input: ServiceInput) => apiPost<Service>(services, input),
    updateService: (id: string, patch: Partial<ServiceInput>) => apiPatch<Service>(one(id), patch),
    deleteService: async (id: string) => {
      await apiDelete(one(id));
    },
    addMembers: (id: string, resourceIds: string[]) =>
      apiPost<ServiceDetailResponse>(`${one(id)}/members`, { resourceIds }),
    removeMember: (id: string, resourceId: string) =>
      apiDelete<ServiceDetailResponse>(`${one(id)}/members/${encodeURIComponent(resourceId)}`),
    restoreMember: (id: string, resourceId: string) =>
      apiDelete<ServiceDetailResponse>(
        `${one(id)}/members/${encodeURIComponent(resourceId)}?restore=1`,
      ),
    createScorecard: (input: ScorecardInput) => apiPost<Scorecard>(scorecards, input),
    updateScorecard: (id: string, patch: Partial<ScorecardInput>) =>
      apiPatch<Scorecard>(`${scorecards}/${encodeURIComponent(id)}`, patch),
    deleteScorecard: async (id: string) => {
      await apiDelete(`${scorecards}/${encodeURIComponent(id)}`);
    },
    evaluateScorecard: (id: string) =>
      apiPost<ScorecardOverviewResponse>(`${scorecards}/${encodeURIComponent(id)}/evaluate`),
  };
}

/** The services one resource belongs to, for the resource page's Ownership tab. */
export async function fetchWebServicesForResource(
  orgId: string,
  resourceId: string,
): Promise<ServiceRef[]> {
  const res = await apiGet<ServicesForResourcesResponse>(
    `/api/org/${encodeURIComponent(orgId)}/services/for-resources?ids=${encodeURIComponent(resourceId)}`,
  );
  return res.services[resourceId] ?? [];
}
