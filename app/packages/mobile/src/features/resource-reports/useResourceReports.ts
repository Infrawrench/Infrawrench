import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  fetchResourceReportFolders,
  fetchResourceReportRows,
  fetchResourceReports,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The org's saved resource reports. One list fetch serves the list screen and
 * the detail screen's header, the cost reports pattern.
 */
export function useResourceReports() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["resource-reports", orgId],
    queryFn: () => fetchResourceReports(api, orgId),
  });
}

/** The report folders (shared with cost reports), for grouping the list. */
export function useResourceReportFolders() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["resource-report-folders", orgId],
    queryFn: () => fetchResourceReportFolders(api, orgId),
  });
}

export const RESOURCE_REPORT_MOBILE_PAGE = 25;

/**
 * A saved report's rows, a page at a time with **Load more** (the changes
 * feed's paging). The report runs with its saved sort and filters.
 */
export function useResourceReportRows(reportId: string | undefined) {
  const { api, orgId } = useOrgApi();
  return useInfiniteQuery({
    queryKey: ["resource-report-rows", orgId, reportId],
    enabled: Boolean(reportId),
    queryFn: ({ pageParam }) =>
      fetchResourceReportRows(api, orgId, reportId!, {
        offset: pageParam,
        limit: RESOURCE_REPORT_MOBILE_PAGE,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const next = last.offset + last.rows.length;
      return next < last.total && last.rows.length > 0 ? next : undefined;
    },
  });
}
