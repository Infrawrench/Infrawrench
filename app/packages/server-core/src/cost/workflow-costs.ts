/**
 * Cost rows reported by a workflow (`infra.costs.write`).
 *
 * This is the escape hatch for spend Infrawrench has no provider plugin for —
 * a SaaS invoice, an internal chargeback, a colo bill. A cron workflow fetches
 * the numbers however it likes and writes them into the same `cost_daily`
 * table the provider collectors use, so they appear in cost graphs, dimension
 * filters, and budgets with no special-casing downstream.
 *
 * **Why workflow rows can never clobber provider rows.** `cost_daily` is a
 * ReplacingMergeTree keyed on
 * `(org, account, day, service, region, resource_id, tags_hash, currency)` —
 * `plugin_id` is NOT in that key, and the ORDER BY is frozen. So attributing a
 * workflow row to a real account could otherwise collide with a row the poller
 * collected for the same day/service and silently replace it. Every workflow
 * row therefore carries a reserved `infrawrench:workflow` tag, which changes
 * `tags_hash` and guarantees a disjoint key space. Re-running the same
 * workflow over the same days still replaces its OWN rows (same key, newer
 * `ingested_at`), which is exactly the restatement behaviour providers get.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import type {
  WorkflowCostRow,
  WorkflowCostWriteResult,
} from "@infrawrench/workflow-runtime/client";

import { db } from "../db/client";
import { accounts } from "../db/schema";
import { hashTags, insertCostRows, type CostDailyRow } from "../clickhouse/cost-writers";
import { isClickHouseConfigured } from "../clickhouse/client";
import {
  WORKFLOW_COST_PLUGIN_ID,
  WORKFLOW_COST_TAG,
  workflowCostAccountId,
} from "./workflow-cost-ids";

/** Any tag key an author may not set (we own this namespace). */
const RESERVED_TAG_PREFIX = "infrawrench:";

/** Bounds. A workflow is user code; it must not be able to fill the table. */
const MAX_ROWS_PER_CALL = 1_000;
const MAX_ROWS_PER_RUN = 50_000;
const MAX_TAGS_PER_ROW = 32;
const MAX_FIELD_LENGTH = 256;

/** A rejected row — surfaced to the workflow author as a thrown error. */
export class WorkflowCostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCostError";
  }
}

function bad(index: number, detail: string): never {
  throw new WorkflowCostError(`infra.costs.write: row ${index} ${detail}`);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Za-z]{3}$/;

/** True for a `YYYY-MM-DD` string that is also a real calendar date. */
function isRealDay(day: string): boolean {
  if (!ISO_DAY.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

function shortString(value: unknown, index: number, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") bad(index, `has a non-string ${field}.`);
  if (value.length > MAX_FIELD_LENGTH) {
    bad(index, `has a ${field} longer than ${MAX_FIELD_LENGTH} characters.`);
  }
  return value;
}

function validateTags(raw: unknown, index: number): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) bad(index, "has non-object tags.");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_TAGS_PER_ROW) {
    bad(index, `has more than ${MAX_TAGS_PER_ROW} tags.`);
  }
  const tags: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.startsWith(RESERVED_TAG_PREFIX)) {
      bad(
        index,
        `uses the reserved tag key "${key}" (the "${RESERVED_TAG_PREFIX}" prefix is ours).`,
      );
    }
    tags[shortString(key, index, "tag key")] = shortString(value, index, `tag "${key}"`);
  }
  return tags;
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
  if (!Array.isArray(rows)) throw new WorkflowCostError("infra.costs.write expects an array.");
  if (rows.length === 0) return { written: 0 };
  if (rows.length > MAX_ROWS_PER_CALL) {
    throw new WorkflowCostError(
      `infra.costs.write accepts at most ${MAX_ROWS_PER_CALL} rows per call (got ${rows.length}).`,
    );
  }
  if (opts.writtenSoFar + rows.length > MAX_ROWS_PER_RUN) {
    throw new WorkflowCostError(
      `infra.costs.write is limited to ${MAX_ROWS_PER_RUN} rows per run; this call would exceed it.`,
    );
  }
  if (!isClickHouseConfigured()) {
    throw new WorkflowCostError("Cost storage is not configured on this server.");
  }

  // Resolve every named account in one query — and reject ids from another org
  // before anything is written, so a partial batch can't land.
  const namedAccountIds = [
    ...new Set(rows.map((r) => r?.accountId).filter((id): id is string => !!id)),
  ];
  if (namedAccountIds.length > 0) {
    const found = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organizationId),
          isNull(accounts.deletedAt),
          inArray(accounts.id, namedAccountIds),
        ),
      );
    const known = new Set(found.map((a) => a.id));
    const unknown = namedAccountIds.find((id) => !known.has(id));
    if (unknown) {
      throw new WorkflowCostError(
        `infra.costs.write: accountId "${unknown}" is not an account in this organization.`,
      );
    }
  }

  const fallbackAccountId = workflowCostAccountId(workflowId);

  const mapped: CostDailyRow[] = rows.map((row, index) => {
    if (!row || typeof row !== "object") bad(index, "is not an object.");
    if (!isRealDay(row.date))
      bad(index, `has an invalid date "${row.date}" (expected YYYY-MM-DD).`);
    if (typeof row.currency !== "string" || !CURRENCY.test(row.currency)) {
      bad(index, `has an invalid currency "${row.currency}" (expected a 3-letter ISO code).`);
    }
    if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) {
      bad(index, "has a non-finite amount.");
    }
    if (row.usageAmount !== undefined && !Number.isFinite(row.usageAmount)) {
      bad(index, "has a non-finite usageAmount.");
    }

    // The reserved tag is what keeps this row's ReplacingMergeTree key disjoint
    // from anything a provider collector writes — see the module comment.
    const tags = { ...validateTags(row.tags, index), [WORKFLOW_COST_TAG]: workflowId };

    return {
      organization_id: organizationId,
      account_id: row.accountId || fallbackAccountId,
      plugin_id: WORKFLOW_COST_PLUGIN_ID,
      day: row.date,
      service: shortString(row.service, index, "service"),
      region: shortString(row.region, index, "region"),
      resource_id: shortString(row.resourceId, index, "resourceId"),
      tags,
      tags_hash: hashTags(tags),
      currency: row.currency.toUpperCase(),
      amount: row.amount,
      usage_amount: row.usageAmount ?? 0,
      usage_unit: shortString(row.usageUnit, index, "usageUnit"),
    };
  });

  await insertCostRows(mapped);
  return { written: mapped.length };
}
