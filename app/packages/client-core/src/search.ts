import type { CloudFetch } from "./fetch";
import type { Service } from "./services";

/**
 * The spotlight search contract (`GET /api/org/:orgId/search?q=`): resources
 * across every account, plus workflows under the `__workflows__` pseudo
 * plugin. At most 50 resources come back; the match is a case-insensitive
 * substring over the name, account, provider and type label.
 */
export interface SearchResult {
  id: string;
  pluginId: string;
  pluginDisplayName: string;
  /** Inline SVG markup for the provider logo. */
  pluginLogoSvg: string;
  resourceTypeId: string;
  resourceTypeLabel: string;
  /** Empty for workflows. */
  accountId: string;
  accountName: string;
  displayName: string;
  subtitle?: string;
}

/** Workflows ride the resource search under this pseudo plugin id. */
export const SEARCH_WORKFLOW_PLUGIN_ID = "__workflows__";

export function isWorkflowSearchResult(r: Pick<SearchResult, "pluginId">): boolean {
  return r.pluginId === SEARCH_WORKFLOW_PLUGIN_ID;
}

export async function searchOrg(
  api: CloudFetch,
  orgId: string,
  query: string,
  init?: RequestInit,
): Promise<SearchResult[]> {
  return (
    (await api.org<SearchResult[]>(orgId, `/search?q=${encodeURIComponent(query.trim())}`, init)) ??
    []
  );
}

/**
 * Services matching a query, by name, slug, owning team or description. The
 * search endpoint does not index services, so clients filter the (small)
 * service list themselves; an empty query returns them all.
 */
export function filterServices(services: readonly Service[], query: string): Service[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...services];
  return services.filter((s) =>
    [s.name, s.slug, s.ownerTeam ?? "", s.description ?? ""].some((v) =>
      v.toLowerCase().includes(q),
    ),
  );
}
