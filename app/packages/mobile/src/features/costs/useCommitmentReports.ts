import { useQuery } from "@tanstack/react-query";
import { fetchCommitmentReports, runCommitmentReport } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/** Saved commitment reports (`GET /commitments/reports`, permission `costs:read`). */
export function useCommitmentReports() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["commitment-reports", orgId],
    queryFn: () => fetchCommitmentReports(api, orgId),
  });
}

/** One run of a saved report; only fetched while `enabled` (the row is open). */
export function useCommitmentReportRun(reportId: string, enabled: boolean) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["commitment-report-run", orgId, reportId],
    queryFn: () => runCommitmentReport(api, orgId, reportId),
    enabled,
  });
}
