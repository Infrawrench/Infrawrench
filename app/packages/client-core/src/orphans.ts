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
export type {
  OrphanCostAnnotation,
  OrphanCostBasis,
  OrphanedResource,
  OrphanAccountGroup,
  OrphanListResponse,
} from "@infrawrench/plugin-base";
