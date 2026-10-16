import { useQuery } from "@tanstack/react-query";
import {
  listKubernetesEfficiencyReports,
  runKubernetesEfficiencyReport,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/** The org's Kubernetes efficiency reports (read-only on mobile). */
export function useKubernetesEfficiencyReports() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["k8s-efficiency-reports", orgId],
    queryFn: () => listKubernetesEfficiencyReports(api, orgId),
  });
}

/** Run one report: the definition's name plus its figures. */
export function useKubernetesEfficiencyRun(reportId: string | undefined) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["k8s-efficiency-run", orgId, reportId],
    enabled: !!reportId,
    queryFn: () => runKubernetesEfficiencyReport(api, orgId, reportId!),
  });
}
