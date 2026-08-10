import { useQuery } from "@tanstack/react-query";
import { listCostAnnotations } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The dated notes a cost chart should draw.
 *
 * With a `reportId` this is that report's own notes plus the org-wide ones;
 * without one it is the org-wide notes alone, which is what a dashboard cost
 * card wants — a card belongs to no report, and "we changed instance types" is
 * exactly the kind of note that belongs on it anyway.
 *
 * Read-only on mobile, like the reports themselves: writing a note means a date
 * picker, a span toggle and a choice between org-wide and one report, and that
 * choice changes what every other chart in the org shows. It stays on web and
 * desktop. A phone reads the explanation; it doesn't file it.
 */
export function useCostAnnotations(reportId?: string, enabled = true) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["cost-annotations", orgId, reportId ?? null],
    enabled,
    queryFn: () => listCostAnnotations(api, orgId, reportId),
  });
}
