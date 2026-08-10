/**
 * Business metric values reported by a workflow (`infra.businessMetrics.write`).
 *
 * The denominator sibling of `cost/workflow-costs.ts`: that module lets a
 * workflow report what was *spent*, this one lets it report how many of the
 * thing the business does happened, so a cost graph can divide one by the
 * other. A nightly workflow that already queries the product database for its
 * customer count is the natural place for that number to come from.
 *
 * Validation and the restating upsert live in `cost/metric-ingest.ts`, shared
 * with the HTTP path so a workflow author and an API client get the same rules
 * and the same messages. What is specific to workflows is the per-run cap and
 * resolving the metric *key* an author typed into the row it belongs to —
 * authors address metrics by key, never by an opaque uuid.
 */
import type {
  WorkflowBusinessMetricValue,
  WorkflowBusinessMetricWriteResult,
} from "@infrawrench/workflow-runtime/client";

import {
  BusinessMetricIngestError,
  ingestMetricValues,
  resolveBusinessMetric,
} from "./metric-ingest";

/** Bounds. A workflow is user code; it must not be able to fill the table. */
const MAX_VALUES_PER_CALL = 1_000;
const MAX_VALUES_PER_RUN = 50_000;

/** A rejected write — surfaced to the workflow author as a thrown error. */
export class WorkflowBusinessMetricError extends Error {
  override readonly name = "WorkflowBusinessMetricError";
}

/**
 * Validate and store a batch of workflow-reported metric values. Throws
 * {@link WorkflowBusinessMetricError} on anything an author can fix; the
 * message reaches them as a thrown error inside the workflow.
 */
export async function writeWorkflowMetricValues(opts: {
  organizationId: string;
  metricKey: string;
  values: WorkflowBusinessMetricValue[];
  /** Values already written by this run, for the per-run cap. */
  writtenSoFar: number;
}): Promise<WorkflowBusinessMetricWriteResult> {
  const { organizationId, metricKey, values } = opts;

  // Checked before the shared validator so the per-run cap is reported as such
  // rather than as a per-call overflow.
  if (Array.isArray(values) && opts.writtenSoFar + values.length > MAX_VALUES_PER_RUN) {
    throw new WorkflowBusinessMetricError(
      `infra.businessMetrics.write is limited to ${MAX_VALUES_PER_RUN} values per run; this ` +
        "call would exceed it.",
    );
  }

  const key = String(metricKey ?? "").trim();
  if (!key) {
    throw new WorkflowBusinessMetricError(
      "infra.businessMetrics.write needs a metric key as its first argument, e.g. " +
        'infra.businessMetrics.write("active-customers", [...]).',
    );
  }

  const metric = await resolveBusinessMetric(organizationId, key);
  if (!metric) {
    // Named rather than silently created: a typo that quietly produced a new
    // empty metric would leave the real one full of gaps and the chart would
    // look like a collection failure rather than a spelling mistake.
    throw new WorkflowBusinessMetricError(
      `infra.businessMetrics.write: no business metric "${key}" in this organization. Create ` +
        "it on the Costs panel first — the key is the slug shown next to its name.",
    );
  }

  try {
    return await ingestMetricValues({
      organizationId,
      metricId: metric.id,
      values,
      source: {
        errorPrefix: "infra.businessMetrics.write",
        source: "workflow",
        // A workflow run has no acting user; the metric's own audit trail and
        // the run record are where "who caused this" is answered.
        userId: null,
        maxValues: MAX_VALUES_PER_CALL,
      },
    });
  } catch (err) {
    // The author sees `WorkflowBusinessMetricError`; the shared validator knows
    // nothing about workflows, so re-wrap rather than leak its class name.
    if (err instanceof BusinessMetricIngestError) {
      throw new WorkflowBusinessMetricError(err.message);
    }
    throw err;
  }
}
