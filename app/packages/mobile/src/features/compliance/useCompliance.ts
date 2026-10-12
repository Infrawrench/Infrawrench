import { useQuery } from "@tanstack/react-query";
import {
  fetchComplianceFrameworks,
  fetchComplianceStatus,
  type CompliancePeriod,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/** The frameworks the org can report against (`GET /compliance/frameworks`). */
export function useComplianceFrameworks() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["compliance-frameworks", orgId],
    queryFn: () => fetchComplianceFrameworks(api, orgId),
    // The registry ships with the server; it changes on a deploy, not an hour.
    staleTime: 60 * 60 * 1000,
  });
}

/**
 * Status per control for one framework over one period
 * (`GET /compliance?framework=&from=&to=`). The server gathers every evidence
 * source and computes the statuses; the phone only reads the result.
 */
export function useComplianceStatus(frameworkId: string | null, period: CompliancePeriod) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["compliance-status", orgId, frameworkId, period.from, period.to],
    queryFn: () => fetchComplianceStatus(api, orgId, frameworkId!, period),
    enabled: frameworkId !== null,
  });
}
