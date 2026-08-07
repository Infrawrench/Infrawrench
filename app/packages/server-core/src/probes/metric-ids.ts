/**
 * The synthetic identity probe results are written to ClickHouse under.
 *
 * A deliberate leaf with no imports, split out of `probes/pass.ts` for the
 * same reason `cost/workflow-cost-ids.ts` is split out of
 * `cost/workflow-costs.ts`: readers only need to *name* a probe's series, and
 * making them import the pass pulls in the poller's whole delivery stack —
 * `db/client`, Slack, Teams, push — for one string template.
 *
 * These are not a real plugin. The constant ids exist so probe series live
 * beside plugin metric series in the same tables and the existing
 * readers/charts work unchanged, while staying unmistakably distinct from any
 * synced resource.
 */
export const PROBE_PLUGIN_ID = "synthetic-probe";
export const PROBE_RESOURCE_TYPE_ID = "probe";

/** The ClickHouse `resource_id` for one probe's series. */
export function probeMetricResourceId(probeId: string): string {
  return `probe:${probeId}`;
}
