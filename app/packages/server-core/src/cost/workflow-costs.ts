/**
 * Cost rows reported by a workflow (`infra.costs.write`).
 *
 * This is the escape hatch for spend Infrawrench has no provider plugin for —
 * a SaaS invoice, an internal chargeback, a colo bill. A cron workflow fetches
 * the numbers however it likes and writes them into the same `cost_daily`
 * table the provider collectors use, so they appear in cost graphs, dimension
 * filters, and budgets with no special-casing downstream. A server outside
 * Infrawrench does the same thing over HTTP — see `cost/external-costs.ts`.
 *
 * Validation, the reserved-tag invariant, and the ClickHouse write all live in
 * `cost/cost-ingest.ts`; what is specific to workflows is the per-run cap and
 * the synthetic account a row falls back to when it names no real one.
 */
import type {
  WorkflowCostRow,
  WorkflowCostWriteResult,
} from "@infrawrench/workflow-runtime/client";

import { CostIngestError, ingestCostRows } from "./cost-ingest";
import {
  WORKFLOW_COST_PLUGIN_ID,
  WORKFLOW_COST_TAG,
  workflowCostAccountId,
} from "./workflow-cost-ids";

/** Bounds. A workflow is user code; it must not be able to fill the table. */
const MAX_ROWS_PER_CALL = 1_000;
const MAX_ROWS_PER_RUN = 50_000;

/** A rejected row — surfaced to the workflow author as a thrown error. */
export class WorkflowCostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCostError";
  }
}

/**
 * Validate and store a batch of workflow-reported cost rows. Throws
 * {@link WorkflowCostError} on anything an author can fix; the message reaches
 * them as a thrown error inside the workflow.
 */
export async function writeWorkflowCostRows(opts: {
  organizationId: string;
  workflowId: string;
  rows: WorkflowCostRow[];
  /** Rows already written by this run, for the per-run cap. */
  writtenSoFar: number;
}): Promise<WorkflowCostWriteResult> {
  const { organizationId, workflowId, rows } = opts;

  // Checked before the shared validator so the per-run cap is reported as such
  // rather than as a per-call overflow.
  if (Array.isArray(rows) && opts.writtenSoFar + rows.length > MAX_ROWS_PER_RUN) {
    throw new WorkflowCostError(
      `infra.costs.write is limited to ${MAX_ROWS_PER_RUN} rows per run; this call would exceed it.`,
    );
  }

  try {
    return await ingestCostRows({
      organizationId,
      rows,
      source: {
        pluginId: WORKFLOW_COST_PLUGIN_ID,
        tag: { key: WORKFLOW_COST_TAG, value: workflowId },
        fallbackAccountId: workflowCostAccountId(workflowId),
        errorPrefix: "infra.costs.write",
        maxRows: MAX_ROWS_PER_CALL,
      },
    });
  } catch (err) {
    // The author sees `WorkflowCostError`; the shared validator knows nothing
    // about workflows, so re-wrap rather than leak its class name into runs.
    if (err instanceof CostIngestError) throw new WorkflowCostError(err.message);
    throw err;
  }
}
