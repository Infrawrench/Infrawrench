import { searchResultKind, type SearchResult } from "@infrawrench/client-core";

/**
 * Where a starred item opens on the phone, or null when the app has no screen
 * for its kind (runbooks, status pages, virtual tags and query monitors are
 * edited on web and desktop). Objects that live inside a larger page open
 * that page, as they do in the desktop and web palettes.
 */
export function starredItemHref(orgId: string, item: SearchResult): string | null {
  const base = `/org/${orgId}`;
  const id = encodeURIComponent(item.id);
  switch (searchResultKind(item)) {
    case "resource":
      return `${base}/resources/${encodeURIComponent(item.pluginId)}/${encodeURIComponent(item.resourceTypeId)}/${id}`;
    case "workflow":
      return `${base}/workflows/${id}`;
    case "dashboard":
      return `${base}/dashboard/${id}`;
    case "cost_report":
      return `${base}/cost-reports/${id}`;
    case "cost_report_folder":
      return `${base}/cost-reports`;
    case "cost_canvas":
      return `${base}/cost-canvases/${id}`;
    case "budget":
    case "saved_cost_filter":
    case "business_metric":
    case "scenario_model":
      return `${base}/costs`;
    case "slo":
      return `${base}/slos/${id}`;
    case "service":
      return `${base}/services/${id}`;
    case "probe":
      return `${base}/probes`;
    case "log_query":
      return `${base}/log-workspaces/${id}`;
    case "virtual_tag":
    case "runbook":
    case "status_page":
    case "query_monitor":
      return null;
  }
}
