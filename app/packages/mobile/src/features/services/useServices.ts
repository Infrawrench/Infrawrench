import { useQuery } from "@tanstack/react-query";
import {
  fetchOrgScorecard,
  fetchScorecardOverview,
  fetchServiceDetail,
  fetchServiceScorecards,
  fetchServiceSummary,
  fetchServices,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * Services and scorecards, read-only. Membership and scores are computed
 * server-side (scores by the poller), so these are ordinary reads in the
 * `useSlos` shape.
 */
export function useServices() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["services", orgId],
    queryFn: () => fetchServices(api, orgId),
  });
}

/** `GET /services/:id`: the service with its resolved members. */
export function useServiceDetail(serviceId: string) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["services", orgId, serviceId],
    queryFn: () => fetchServiceDetail(api, orgId, serviceId),
    enabled: !!serviceId,
  });
}

/** `GET /services/:id/summary`: cost, SLOs, on-call, findings, recent changes. */
export function useServiceSummary(serviceId: string) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["services", orgId, serviceId, "summary"],
    queryFn: () => fetchServiceSummary(api, orgId, serviceId),
    enabled: !!serviceId,
  });
}

/** `GET /services/:id/scorecards`: each result plus its daily history. */
export function useServiceScorecards(serviceId: string) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["services", orgId, serviceId, "scorecards"],
    queryFn: () => fetchServiceScorecards(api, orgId, serviceId),
    enabled: !!serviceId,
  });
}

/** `GET /scorecards/overview`: the service by scorecard matrix. */
export function useScorecardOverview() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["scorecards", orgId, "overview"],
    queryFn: () => fetchScorecardOverview(api, orgId),
  });
}

/**
 * `GET /scorecards/org`: the org grade above the matrix. Computed live over
 * seven feeds server-side, so it is cached a little longer than the matrix.
 */
export function useOrgScorecard() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["scorecards", orgId, "org"],
    queryFn: () => fetchOrgScorecard(api, orgId),
    staleTime: 5 * 60 * 1000,
  });
}
