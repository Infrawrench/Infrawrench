/**
 * Capture — turn a selection of live resources into a draft template.
 *
 * The only provider-specific thing this file touches is each plugin's own
 * `getCreateConfig`, which is what makes the whole feature declarative: the set
 * of fields that can be reproduced is whatever the plugin says its create form
 * takes, so a plugin added tomorrow is captureable with no change here. There
 * is no per-provider table, and no `if (pluginId === …)`.
 *
 * The shaping itself (which field becomes a parameter, which becomes an output
 * reference, what the name field is) is pure and lives in
 * `@infrawrench/client-core`; this module only gathers the inputs it needs.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  ENVIRONMENT_LIMITS,
  buildCaptureDraft,
  extractRecordTags,
  type CaptureCreateField,
  type CaptureDraft,
  type CaptureSourceResource,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { associations, resources, secretFieldStates } from "../db/schema";
import { getOrgAccountClient } from "../org-accounts";
import { EnvironmentInputError } from "./store";

export interface CaptureSelector {
  /** Explicit resource ids. */
  resourceIds?: string[];
  /** Everything (top level) in one account. */
  accountId?: string;
  /** Resources carrying this tag. Combined with `accountId` when both are set. */
  tagKey?: string;
  tagValue?: string;
}

interface ResourceRow {
  id: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  externalId: string | null;
  parentResourceId: string | null;
  fieldsJson: Record<string, unknown> | null;
  outputsJson: Record<string, unknown> | null;
}

function stringifyFields(fields: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
  }
  return out;
}

/** Resolve the selector to resource rows, newest-listed order preserved. */
async function selectResources(
  organizationId: string,
  selector: CaptureSelector,
): Promise<ResourceRow[]> {
  const hasIds = (selector.resourceIds?.length ?? 0) > 0;
  if (!hasIds && !selector.accountId) {
    throw new EnvironmentInputError("Choose an account or some resources to capture");
  }

  const conditions = [eq(resources.organizationId, organizationId), isNull(resources.deletedAt)];
  if (hasIds) conditions.push(inArray(resources.id, selector.resourceIds!));
  if (selector.accountId) conditions.push(eq(resources.accountId, selector.accountId));

  let rows = (await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      displayName: resources.displayName,
      externalId: resources.externalId,
      parentResourceId: resources.parentResourceId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
    })
    .from(resources)
    .where(and(...conditions))
    .orderBy(resources.resourceTypeId, resources.displayName)
    // One over the cap so an oversized selection is *reported*, not truncated.
    .limit(ENVIRONMENT_LIMITS.maxMembers + 1)) as ResourceRow[];

  // Tags are not a column: providers spell them a dozen ways inside the
  // fields/outputs bags, and `extractRecordTags` is the one place that knows
  // how. So the tag half of the selector filters in memory, over the same
  // convention tag compliance and metric-alert selectors already read.
  if (selector.tagKey) {
    const wantKey = selector.tagKey.toLowerCase();
    rows = rows.filter((row) => {
      const tags = extractRecordTags({ ...row.outputsJson, ...row.fieldsJson });
      if (!tags) return false;
      const entry = Object.entries(tags).find(([key]) => key.toLowerCase() === wantKey);
      if (!entry) return false;
      return selector.tagValue === undefined || entry[1] === selector.tagValue;
    });
  }

  if (rows.length === 0)
    throw new EnvironmentInputError("That selection matched no resources", 404);
  if (rows.length > ENVIRONMENT_LIMITS.maxMembers) {
    throw new EnvironmentInputError(
      `That selection is larger than the ${ENVIRONMENT_LIMITS.maxMembers}-resource limit — narrow it with a tag or pick resources explicitly`,
    );
  }
  return rows;
}

/**
 * Output references recorded against the selected resources' fields.
 *
 * Both tables are read because both describe the same fact from different
 * ends: `secret_field_states` is the source of truth the create path writes and
 * the poller reconciles, `associations` is the topology row that survives when
 * the field is not secret. Same union the dependency graph endpoint takes.
 */
async function loadOutputRefs(
  resourceIds: string[],
): Promise<Map<string, { fieldKey: string; targetResourceId: string; outputKey: string }[]>> {
  const out = new Map<
    string,
    { fieldKey: string; targetResourceId: string; outputKey: string }[]
  >();
  if (resourceIds.length === 0) return out;

  const push = (
    resourceId: string,
    ref: { fieldKey: string; targetResourceId: string; outputKey: string },
  ) => {
    const list = out.get(resourceId);
    if (!list) out.set(resourceId, [ref]);
    else if (!list.some((r) => r.fieldKey === ref.fieldKey)) list.push(ref);
  };

  const stateRows = await db
    .select({
      resourceId: secretFieldStates.resourceId,
      fieldKey: secretFieldStates.fieldKey,
      sourceResourceId: secretFieldStates.sourceResourceId,
      sourceOutputKey: secretFieldStates.sourceOutputKey,
    })
    .from(secretFieldStates)
    .where(
      and(
        inArray(secretFieldStates.resourceId, resourceIds),
        eq(secretFieldStates.resolutionKind, "output-ref"),
      ),
    );
  for (const row of stateRows) {
    if (!row.sourceResourceId || !row.sourceOutputKey) continue;
    push(row.resourceId, {
      fieldKey: row.fieldKey,
      targetResourceId: row.sourceResourceId,
      outputKey: row.sourceOutputKey,
    });
  }

  const associationRows = await db
    .select({
      consumerResourceId: associations.consumerResourceId,
      consumerFieldKey: associations.consumerFieldKey,
      providerResourceId: associations.providerResourceId,
      providerOutputKey: associations.providerOutputKey,
    })
    .from(associations)
    .where(inArray(associations.consumerResourceId, resourceIds));
  for (const row of associationRows) {
    push(row.consumerResourceId, {
      fieldKey: row.consumerFieldKey,
      targetResourceId: row.providerResourceId,
      outputKey: row.providerOutputKey,
    });
  }
  return out;
}

/**
 * Ask each distinct plugin/type in the selection for its create-form fields,
 * once per (account, type) pair. A type whose plugin has no `getCreateConfig`
 * simply yields nothing and the pure builder reports it as skipped, with a
 * reason — a resource that cannot be created cannot be stamped out, and saying
 * so is better than silently shipping a template that fails on apply.
 */
async function loadCreateFields(
  organizationId: string,
  rows: ResourceRow[],
): Promise<Record<string, CaptureCreateField[]>> {
  const wanted = new Map<string, { accountId: string; pluginId: string; resourceTypeId: string }>();
  for (const row of rows) {
    const key = `${row.pluginId}:${row.resourceTypeId}`;
    if (!wanted.has(key)) {
      wanted.set(key, {
        accountId: row.accountId,
        pluginId: row.pluginId,
        resourceTypeId: row.resourceTypeId,
      });
    }
  }

  const clients = new Map<string, Awaited<ReturnType<typeof getOrgAccountClient>>>();
  const out: Record<string, CaptureCreateField[]> = {};
  for (const [key, want] of wanted) {
    let ctx = clients.get(want.accountId);
    if (ctx === undefined) {
      ctx = await getOrgAccountClient(want.accountId, organizationId).catch(() => null);
      clients.set(want.accountId, ctx);
    }
    if (!ctx?.client.getCreateConfig) continue;
    const config = await ctx.client.getCreateConfig(want.resourceTypeId).catch(() => null);
    if (!config?.fields?.length) continue;
    out[key] = config.fields.map((field) => ({
      key: field.key,
      label: field.label,
      kind: field.kind,
      required: field.required,
      ...(field.options ? { options: field.options } : {}),
      ...(field.transient ? { transient: true } : {}),
    }));
  }
  return out;
}

/**
 * Build a draft template from a selection. Persists nothing — the editor shows
 * the draft, the user picks which fields to vary, and the resulting document
 * is what gets saved.
 */
export async function captureEnvironmentDraft(
  organizationId: string,
  selector: CaptureSelector,
): Promise<CaptureDraft> {
  const rows = await selectResources(organizationId, selector);
  const [createFields, outputRefs] = await Promise.all([
    loadCreateFields(organizationId, rows),
    loadOutputRefs(rows.map((r) => r.id)),
  ]);

  const selectedIds = new Set(rows.map((r) => r.id));
  const sources: CaptureSourceResource[] = rows.map((row) => ({
    resourceId: row.id,
    accountId: row.accountId,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    displayName: row.displayName,
    externalId: row.externalId ?? "",
    // A parent outside the selection is not containment we can reproduce, so
    // it is dropped rather than becoming a dangling member reference.
    parentResourceId:
      row.parentResourceId && selectedIds.has(row.parentResourceId) ? row.parentResourceId : null,
    fields: stringifyFields(row.fieldsJson),
    outputRefs: outputRefs.get(row.id) ?? [],
  }));

  return buildCaptureDraft({ resources: sources, createFields });
}
