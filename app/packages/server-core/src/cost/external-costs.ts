/**
 * Cost rows pushed over the HTTP API by a server outside Infrawrench
 * (`POST /api/org/{orgId}/costs/rows`).
 *
 * Same escape hatch as `infra.costs.write`, for spend that is easier to report
 * from where it is already known — a nightly job that already parses the
 * Snowflake invoice, a chargeback service, a colo bill — than to fetch from a
 * workflow. Rows land in the same `cost_daily` table the provider collectors
 * write to, so they appear in cost graphs, dimension filters, and budgets with
 * no special-casing downstream.
 *
 * Rows are grouped under a caller-chosen `source` name rather than a workflow
 * id: it becomes the reserved tag value, the synthetic account id when a row
 * names no real account, and the label the account picker shows. Re-pushing the
 * same source over the same days replaces its own rows and nothing else — see
 * `cost/cost-ingest.ts` for why that holds.
 */
import { isValidSourceName, SOURCE_NAME_HELP } from "../source-name";
import { CostIngestError, ingestCostRows, type IngestCostRow } from "./cost-ingest";
import {
  EXTERNAL_COST_PLUGIN_ID,
  EXTERNAL_COST_TAG,
  externalCostAccountId,
} from "./external-cost-ids";

/** Bounds. This is an unattended endpoint; it must not be able to fill the table. */
export const MAX_EXTERNAL_COST_ROWS_PER_CALL = 5_000;

export { CostIngestError };

/**
 * Validate and store a batch of API-pushed cost rows. Throws
 * {@link CostIngestError} on anything the caller can fix; the route maps that
 * onto a 400 with the message.
 */
export async function writeExternalCostRows(opts: {
  organizationId: string;
  /** Stable slug naming the system that owns these rows. */
  source: string;
  rows: IngestCostRow[];
}): Promise<{ written: number }> {
  const { organizationId, source, rows } = opts;

  if (!isValidSourceName(source)) throw new CostIngestError(SOURCE_NAME_HELP);

  return ingestCostRows({
    organizationId,
    rows,
    source: {
      pluginId: EXTERNAL_COST_PLUGIN_ID,
      tag: { key: EXTERNAL_COST_TAG, value: source },
      fallbackAccountId: externalCostAccountId(source),
      errorPrefix: "costs/rows",
      maxRows: MAX_EXTERNAL_COST_ROWS_PER_CALL,
    },
  });
}
