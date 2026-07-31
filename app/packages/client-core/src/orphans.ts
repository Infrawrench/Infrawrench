/**
 * Orphan & idle resource finder — the wire contract for
 * `GET /api/org/:orgId/orphans`, shared by the web app, the desktop app's
 * Potential savings section of Costs, and the `infrawrench orphans` CLI
 * subcommand.
 *
 * Both the classification and the aggregation live in plugin-base
 * (`orphanRule` on resource types, `evaluateOrphanRule`, `collectOrphanGroups`)
 * because the hosts that *run* the scan — the web server over the org's synced
 * rows, desktop and the CLI over the local SQLite workspace — all load plugins
 * anyway. The types are re-exported from here, type-only, so clients that only
 * ever read the JSON (the web app, mobile) keep one import site and never pull
 * plugin-base into their bundle.
 */
import type { OrphanListResponse } from "@infrawrench/plugin-base";

import type { CloudFetch } from "./fetch";

export type {
  OrphanCostAnnotation,
  OrphanCostBasis,
  OrphanedResource,
  OrphanAccountGroup,
  OrphanListResponse,
} from "@infrawrench/plugin-base";

/**
 * Scan an organization's synced resources for likely waste
 * (`GET /api/org/:orgId/orphans`, permission `resources:read`).
 *
 * Cheap and side-effect free: the server classifies rows it already has, makes
 * no provider API calls, and annotates cost best-effort — a caller without
 * `costs:read`, or an org with no per-resource billing rows, gets the same
 * flags with `cost: null` rather than an error.
 *
 * Note the import above is `import type`: this module must stay free of a
 * *runtime* dependency on plugin-base, which would pull zod and the provider
 * SDKs' crypto helpers into the mobile bundle for the sake of five interfaces.
 */
export async function fetchOrphans(api: CloudFetch, orgId: string): Promise<OrphanListResponse> {
  const res = await api.org<OrphanListResponse>(orgId, "/orphans");
  // The route always answers 200 with a body; `org` maps a 204 to null, and an
  // empty scan is exactly what that would mean.
  return (
    res ?? {
      accounts: [],
      totalCount: 0,
      costWindowDays: 0,
      generatedAt: new Date().toISOString(),
    }
  );
}
