/**
 * Resolving a metric alert rule's resource selector against the live
 * `resources` table. Rules select by *query* — plugin + resource type + tag —
 * never by id list, so a rule automatically covers resources created after it
 * was written and stops covering resources that are deleted or re-tagged.
 *
 * Plugin and type narrow in SQL; the tag half filters in JS through
 * `extractRecordTags`, the same tags/labels convention the tag-compliance
 * report reads (`web/src/services/tag-policy.ts`) — tags live inside
 * `fields_json`/`outputs_json`, not in a column.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { extractRecordTags } from "@infrawrench/client-core";
import { db } from "../db/client";
import { resources } from "../db/schema";

export interface MetricAlertSelectorFields {
  organizationId: string;
  pluginId: string | null;
  resourceTypeId: string | null;
  tagKey: string | null;
  tagValue: string | null;
}

export interface SelectedResource {
  id: string;
  displayName: string;
}

/**
 * Most resources one rule evaluates per pass. A selector matching more than
 * this is almost certainly "any plugin, no tag" on a huge org; the cap bounds
 * the ClickHouse read rather than failing the rule.
 */
export const MAX_SELECTED_RESOURCES = 500;

/**
 * Most rows a tag-filtered selector reads from Postgres before matching in
 * JS. Tags live inside the JSON payloads, so the tag half cannot narrow in
 * SQL — this bounds the memory of that scan the way
 * {@link MAX_SELECTED_RESOURCES} bounds the ClickHouse read. Both caps take
 * rows in `id` order, so an over-cap selector picks a stable subset instead
 * of flapping between passes.
 */
export const MAX_TAG_SCAN_ROWS = 10_000;

interface TaggableRow extends SelectedResource {
  fieldsJson: Record<string, unknown>;
  outputsJson: Record<string, unknown>;
}

/**
 * The tag half of the selector, pure for tests. Keys match case-insensitively
 * (providers disagree on casing, same stance as `tagPolicyViolations`);
 * values match exactly. A null `tagKey` matches everything.
 */
export function rowMatchesTag(
  row: Pick<TaggableRow, "fieldsJson" | "outputsJson">,
  tagKey: string | null,
  tagValue: string | null,
): boolean {
  if (!tagKey) return true;
  const tags = extractRecordTags({ ...row.outputsJson, ...row.fieldsJson });
  if (!tags) return false;
  const wanted = tagKey.toLowerCase();
  for (const [key, value] of Object.entries(tags)) {
    if (key.toLowerCase() !== wanted) continue;
    if (tagValue === null || value === tagValue) return true;
  }
  return false;
}

/** The resources a rule's selector matches right now, capped at {@link MAX_SELECTED_RESOURCES}. */
export async function resolveSelectorResources(
  selector: MetricAlertSelectorFields,
): Promise<SelectedResource[]> {
  const conditions = [
    eq(resources.organizationId, selector.organizationId),
    isNull(resources.deletedAt),
    ...(selector.pluginId ? [eq(resources.pluginId, selector.pluginId)] : []),
    ...(selector.resourceTypeId ? [eq(resources.resourceTypeId, selector.resourceTypeId)] : []),
  ];

  // No tag half: the SQL narrowing is the whole selector, so the cap pushes
  // into the query and the JSON payloads never leave Postgres.
  if (!selector.tagKey) {
    return db
      .select({ id: resources.id, displayName: resources.displayName })
      .from(resources)
      .where(and(...conditions))
      .orderBy(asc(resources.id))
      .limit(MAX_SELECTED_RESOURCES);
  }

  const rows: TaggableRow[] = await db
    .select({
      id: resources.id,
      displayName: resources.displayName,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
    })
    .from(resources)
    .where(and(...conditions))
    .orderBy(asc(resources.id))
    .limit(MAX_TAG_SCAN_ROWS);

  const matched: SelectedResource[] = [];
  for (const row of rows) {
    if (!rowMatchesTag(row, selector.tagKey, selector.tagValue)) continue;
    matched.push({ id: row.id, displayName: row.displayName });
    if (matched.length >= MAX_SELECTED_RESOURCES) break;
  }
  return matched;
}
