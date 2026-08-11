import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type {
  IacImportPlanResponse,
  IacReconciliationEntry,
  IacReconciliationResponse,
  IacResourceStatusResponse,
  TerraformTypeMapDerivation,
} from "@infrawrench/client-core";
import { deriveTerraformTypeMap, reconcileTerraformState } from "@infrawrench/client-core";
import type { ResourceInstance, TerraformExportCapability } from "@infrawrench/plugin-base";
import {
  exportResourcesToTerraform,
  renderTerraformAdoptionDocument,
} from "@infrawrench/plugin-base";
import { db } from "../db/client.js";
import { resourceChanges, resources } from "../db/schema.js";
import { loadPlugins } from "../plugin-loader.js";
import { lookupResourceOwners } from "../ownership/store.js";
import { IacInputError, getIacState, getLatestIacState, loadIacStateResources } from "./store.js";

/**
 * The server half of **IaC reconciliation**: load the org's inventory and a
 * stored state document, run the pure classifier from client-core, then answer
 * the question the classifier cannot — *who* made the unmanaged things, and
 * *when*. That join is the whole point of the feature; a list of unmanaged
 * resources with no name against it is a list nobody acts on.
 *
 * Every mapping decision here is derived from the plugins' own
 * `terraformExport` capabilities. There is no second table.
 */

/** Cached across requests: probing every mapper is cheap but not free. */
let typeMapCache: TerraformTypeMapDerivation | null = null;
let capabilityCache: Map<string, TerraformExportCapability | undefined> | null = null;

async function loadCapabilities(): Promise<{
  capabilityFor: (pluginId: string) => TerraformExportCapability | undefined;
  typeMap: TerraformTypeMapDerivation;
}> {
  if (!capabilityCache || !typeMapCache) {
    const plugins = await loadPlugins();
    capabilityCache = new Map(
      plugins.map((p) => [p.plugin.manifest.id, p.plugin.terraformExport] as const),
    );
    typeMapCache = deriveTerraformTypeMap(
      plugins.map((p) => ({
        pluginId: p.plugin.manifest.id,
        capability: p.plugin.terraformExport,
      })),
    );
  }
  const capabilities = capabilityCache;
  return { capabilityFor: (pluginId) => capabilities.get(pluginId), typeMap: typeMapCache };
}

/** Test seam: forget the derived map (the plugin registry is static in prod). */
export function resetIacTypeMapCache(): void {
  typeMapCache = null;
  capabilityCache = null;
}

interface InventoryRow {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  fieldsJson: Record<string, unknown>;
  outputsJson: Record<string, unknown>;
  parentResourceId: string | null;
}

/**
 * A stored row as the export mappers expect it. Same normalisation the
 * eject-to-Terraform service does — mappers read primitives, so anything
 * structured is dropped rather than stringified.
 */
function toResourceInstance(row: InventoryRow): ResourceInstance {
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(row.fieldsJson)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields[key] = value;
    }
  }
  const outputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.outputsJson)) {
    if (typeof value === "string") outputs[key] = value;
  }
  return {
    id: row.id,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    accountId: row.accountId,
    displayName: row.displayName,
    fields,
    resolvedOutputs: outputs,
    secretStates: [],
    ...(row.externalId ? { externalId: row.externalId } : {}),
    ...(row.parentResourceId ? { parentResourceId: row.parentResourceId } : {}),
    createdAt: "",
    updatedAt: "",
  };
}

async function loadInventory(
  organizationId: string,
  accountId: string | null,
): Promise<InventoryRow[]> {
  const where = accountId
    ? and(
        eq(resources.organizationId, organizationId),
        eq(resources.accountId, accountId),
        isNull(resources.deletedAt),
      )
    : and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt));
  return db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      displayName: resources.displayName,
      externalId: resources.externalId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
      parentResourceId: resources.parentResourceId,
    })
    .from(resources)
    .where(where)
    .orderBy(asc(resources.displayName));
}

/**
 * When the change timeline first saw each resource appear — the "and when"
 * half of attribution. Only `created` events count: an `updated` row says
 * somebody touched it, not that they made it.
 */
async function lookupFirstSeen(
  organizationId: string,
  resourceIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(resourceIds)].filter(Boolean);
  if (unique.length === 0) return out;
  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const rows = await db
      .select({ resourceId: resourceChanges.resourceId, createdAt: resourceChanges.createdAt })
      .from(resourceChanges)
      .where(
        and(
          eq(resourceChanges.organizationId, organizationId),
          eq(resourceChanges.changeKind, "created"),
          inArray(resourceChanges.resourceId, unique.slice(i, i + CHUNK)),
        ),
      )
      .orderBy(asc(resourceChanges.createdAt));
    for (const row of rows) {
      if (!out.has(row.resourceId)) out.set(row.resourceId, row.createdAt.toISOString());
    }
  }
  return out;
}

export interface RunIacReconciliationArgs {
  organizationId: string;
  stateId: string;
}

/** Classify the org's inventory against one stored state document. */
export async function runIacReconciliation({
  organizationId,
  stateId,
}: RunIacReconciliationArgs): Promise<IacReconciliationResponse> {
  const state = await getIacState(organizationId, stateId);
  if (!state) throw new IacInputError("Unknown state document.", 404);

  const [stateResources, inventoryRows, { capabilityFor, typeMap }] = await Promise.all([
    loadIacStateResources(stateId),
    loadInventory(organizationId, state.accountId),
    loadCapabilities(),
  ]);

  const inventory = inventoryRows.map(toResourceInstance);
  const result = reconcileTerraformState({
    stateResources,
    inventory,
    capabilityFor,
    typeMap,
  });

  // Attribution is only interesting for the things Terraform does not manage —
  // and it is two extra queries, so it is scoped to those rows.
  const unmanagedIds = result.resources
    .filter((r) => r.status === "unmanaged")
    .map((r) => r.resourceId);
  const [owners, firstSeen] = await Promise.all([
    lookupResourceOwners(organizationId, unmanagedIds),
    lookupFirstSeen(organizationId, unmanagedIds),
  ]);

  const entries: IacReconciliationEntry[] = result.resources.map((r) => ({
    ...r,
    owner: owners.get(r.resourceId) ?? null,
    firstSeenAt: firstSeen.get(r.resourceId) ?? null,
  }));

  return {
    state,
    resources: entries,
    stateOnly: result.stateOnly,
    summary: result.summary,
    underivable: typeMap.underivable,
  };
}

/**
 * Generate `import` blocks plus the matching resource stanzas for a set of
 * unmanaged resources — the payoff. Built on the *existing* export mappers and
 * HCL serializer, so what this emits is byte-identical to what
 * "Export to Terraform…" would produce for the same resources, plus the
 * adoption blocks.
 */
export async function buildIacImportPlan(
  organizationId: string,
  resourceIds: readonly string[],
): Promise<IacImportPlanResponse> {
  if (resourceIds.length === 0) throw new IacInputError("Select at least one resource.");
  const rows = await db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      displayName: resources.displayName,
      externalId: resources.externalId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
      parentResourceId: resources.parentResourceId,
    })
    .from(resources)
    .where(
      and(eq(resources.organizationId, organizationId), inArray(resources.id, [...resourceIds])),
    );
  if (rows.length === 0) throw new IacInputError("No matching resources.", 404);

  const { capabilityFor } = await loadCapabilities();
  const outcome = exportResourcesToTerraform(rows.map(toResourceInstance), capabilityFor);

  return {
    hcl: renderTerraformAdoptionDocument(outcome),
    exported: outcome.exported.map((entry) => ({
      resourceId: entry.id,
      address: entry.address,
      importId: entry.importId ?? null,
    })),
    unsupported: outcome.unsupported.map((entry) => ({
      resourceId: entry.id,
      displayName: entry.displayName,
      reason: entry.reason,
    })),
  };
}

/**
 * The managed/unmanaged badge for one resource detail page. Cheap on purpose:
 * it reconciles against the newest state document only, and answers `null`
 * when the org has uploaded none — a resource detail must not imply "nobody
 * manages this" when the truth is "nobody has told us".
 */
export async function getIacResourceStatus(
  organizationId: string,
  resourceId: string,
): Promise<IacResourceStatusResponse> {
  const empty: IacResourceStatusResponse = {
    status: null,
    stateId: null,
    stateLabel: null,
    terraformAddress: null,
    driftFieldCount: 0,
  };

  const rows = await db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      displayName: resources.displayName,
      externalId: resources.externalId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
      parentResourceId: resources.parentResourceId,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), eq(resources.id, resourceId)))
    .limit(1);
  const row = rows[0];
  if (!row) return empty;

  const state =
    (await getLatestIacState(organizationId, row.accountId)) ??
    (await getLatestIacState(organizationId));
  if (!state) return empty;

  const [stateResources, { capabilityFor, typeMap }] = await Promise.all([
    loadIacStateResources(state.id),
    loadCapabilities(),
  ]);
  const result = reconcileTerraformState({
    stateResources,
    inventory: [toResourceInstance(row)],
    capabilityFor,
    typeMap,
  });
  const entry = result.resources[0];
  if (!entry) return empty;
  return {
    status: entry.status,
    stateId: state.id,
    stateLabel: state.label,
    terraformAddress: entry.terraformAddress,
    driftFieldCount: entry.drift.length,
  };
}
