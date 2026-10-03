/**
 * The carbon estimate, assembled over synced inventory.
 *
 * All the arithmetic and every coefficient are in `@infrawrench/client-core`
 * (`carbon.ts`, `carbon-factors.ts`); which fields to read is each plugin's
 * `carbon` declaration (or, failing that, its `rightsizing` one). This module
 * only gathers the inputs: the rows, the declarations, and the size
 * catalogues that turn an instance type into a vCPU count.
 *
 * It lives in server-core rather than web so every caller that prices
 * something can put carbon beside it: the Costs page, a resource's detail
 * view and edit modal, the environment estimate, right-sizing, the MCP tools.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  createCarbonHint,
  effectiveCarbonDeclaration,
  estimateCarbon,
  estimateCreateFormCarbon,
  readCarbonInputs,
  resourceCarbonEstimate,
  type CarbonCatalogueLoader,
  type CarbonEstimate,
  type CarbonFootprint,
  type CarbonInputResource,
  type CarbonTypeShape,
  type ResourceCarbonEstimate,
} from "@infrawrench/client-core";
import type { CreateResourceConfig, SizeOption } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { getOrgAccountClient } from "../org-accounts";

export interface CarbonOptions {
  windowDays?: number;
  now?: number;
}

/**
 * Size catalogues and create configs, cached across requests for an hour.
 *
 * A detail view asking for one resource's carbon must not cost a provider
 * round trip every time it opens, and a catalogue of instance sizes changes on
 * the scale of months. One entry per (account, type): an estate with three
 * hundred instances of six types is six reads, once an hour.
 */
const CATALOGUE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 2000;
const configCache = new Map<string, { at: number; value: Promise<CreateResourceConfig | null> }>();

function cachedCreateConfig(
  organizationId: string,
  accountId: string,
  typeId: string,
): Promise<CreateResourceConfig | null> {
  const key = `${organizationId}|${accountId}|${typeId}`;
  const hit = configCache.get(key);
  if (hit && Date.now() - hit.at < CATALOGUE_TTL_MS) return hit.value;
  const value = (async () => {
    try {
      const ctx = await getOrgAccountClient(accountId, organizationId);
      if (!ctx?.client.getCreateConfig) return null;
      return await ctx.client.getCreateConfig(typeId);
    } catch (err) {
      // One provider's catalogue failing costs its resources an estimate,
      // never the report. They surface as `unknown-size`, which is true.
      console.error(`[carbon] size catalogue failed for ${accountId}/${typeId}:`, err);
      return null;
    }
  })();
  if (configCache.size >= MAX_CACHE_ENTRIES) configCache.clear();
  configCache.set(key, { at: Date.now(), value });
  return value;
}

function catalogueLoader(organizationId: string, accountId: string): CarbonCatalogueLoader {
  return async (typeId, fieldKey) => {
    const config = await cachedCreateConfig(organizationId, accountId, typeId);
    const field = config?.fields.find((f) => f.key === fieldKey && f.kind === "size-picker");
    return (field?.sizes ?? []) as SizeOption[];
  };
}

/** pluginId:typeId → the parts of the type definition carbon reads. */
async function typeShapes(): Promise<Map<string, CarbonTypeShape>> {
  const shapes = new Map<string, CarbonTypeShape>();
  for (const loaded of await loadPlugins()) {
    for (const type of loaded.plugin.resourceTypes) {
      shapes.set(`${loaded.plugin.manifest.id}:${type.id}`, {
        carbon: type.carbon,
        rightsizing: type.rightsizing,
      });
    }
  }
  return shapes;
}

/** The create-form hint for a type, for the host to attach to its config. */
export async function carbonHintFor(pluginId: string, resourceTypeId: string) {
  const shape = (await typeShapes()).get(`${pluginId}:${resourceTypeId}`);
  return shape ? createCarbonHint(pluginId, shape) : undefined;
}

/**
 * Names a Kubernetes node may share with the instance it runs on: GKE, DOKS,
 * Kapsule and OVH name nodes after the VM; EKS names them `ip-a-b-c-d...`
 * after the private IP.
 */
function nodeAliases(name: string): string[] {
  const lower = name.toLowerCase();
  const aliases = [lower, lower.split(".")[0]!];
  const ip = /^ip-(\d+)-(\d+)-(\d+)-(\d+)/.exec(lower);
  if (ip) aliases.push(`${ip[1]}.${ip[2]}.${ip[3]}.${ip[4]}`);
  return aliases;
}

/** Names an instance row is known by, for matching against node names. */
function instanceAliases(row: {
  displayName: string;
  externalId: string | null;
  fields: Record<string, unknown>;
  outputs: Record<string, unknown>;
}): string[] {
  const out = [row.displayName, row.externalId, row.fields["name"], row.outputs["privateIp"]];
  return out
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map((v) => v.toLowerCase());
}

/**
 * The org's estimated operational carbon over a window.
 *
 * Only types with a carbon declaration are candidates: a bucket or a DNS
 * record is outside the scope, not "unestimated". Aggregates (a managed
 * cluster whose nodes are listed in their own right) are left out of the
 * total, and a Kubernetes node whose machine is already an instance row is
 * counted once, with the number skipped reported.
 */
export async function getCarbonEstimate(
  organizationId: string,
  options: CarbonOptions = {},
): Promise<CarbonEstimate> {
  const [shapes, rows] = await Promise.all([
    typeShapes(),
    db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        accountName: accounts.displayName,
        displayName: resources.displayName,
        externalId: resources.externalId,
        fieldsJson: resources.fieldsJson,
        outputsJson: resources.outputsJson,
      })
      .from(resources)
      .innerJoin(accounts, eq(accounts.id, resources.accountId))
      .where(
        and(
          eq(resources.organizationId, organizationId),
          isNull(resources.deletedAt),
          isNull(accounts.deletedAt),
        ),
      ),
  ]);

  const loaders = new Map<string, CarbonCatalogueLoader>();
  const loaderFor = (accountId: string) => {
    let loader = loaders.get(accountId);
    if (!loader) {
      loader = catalogueLoader(organizationId, accountId);
      loaders.set(accountId, loader);
    }
    return loader;
  };

  const candidates = rows.flatMap((row) => {
    const shape = shapes.get(`${row.pluginId}:${row.resourceTypeId}`);
    const declaration = shape ? effectiveCarbonDeclaration(shape) : null;
    if (!declaration || (declaration.role ?? "instance") !== "instance") return [];
    return [{ row, declaration }];
  });

  // Every instance-role row that is not itself a node, by every name it goes by.
  const instanceNames = new Set<string>();
  for (const { row } of candidates) {
    if (row.resourceTypeId === "k8s-node") continue;
    for (const alias of instanceAliases({
      displayName: row.displayName,
      externalId: row.externalId,
      fields: (row.fieldsJson ?? {}) as Record<string, unknown>,
      outputs: (row.outputsJson ?? {}) as Record<string, unknown>,
    })) {
      instanceNames.add(alias);
    }
  }

  let duplicateCount = 0;
  const inputs: CarbonInputResource[] = [];
  await Promise.all(
    candidates.map(async ({ row, declaration }) => {
      if (
        row.resourceTypeId === "k8s-node" &&
        nodeAliases(row.displayName).some((alias) => instanceNames.has(alias))
      ) {
        duplicateCount += 1;
        return;
      }
      const read = await readCarbonInputs(
        declaration,
        (row.fieldsJson ?? {}) as Record<string, unknown>,
        {
          pluginId: row.pluginId,
          resourceTypeId: row.resourceTypeId,
          loadCatalogue: loaderFor(row.accountId),
        },
      );
      inputs.push({
        resourceId: row.id,
        pluginId: row.pluginId,
        resourceTypeId: row.resourceTypeId,
        accountId: row.accountId,
        accountName: row.accountName,
        displayName: row.displayName,
        grid: read.grid,
        region: read.region,
        vcpus: read.vcpus,
        count: read.count,
      });
    }),
  );

  // Reads finish in any order; the unestimated list should not.
  inputs.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
  return estimateCarbon(inputs, {
    duplicateCount,
    ...(options.windowDays !== undefined ? { windowDays: options.windowDays } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

export interface ResourceCarbonInput {
  accountId: string;
  resourceTypeId: string;
  /** An existing resource; its stored fields seed the read. */
  resourceId?: string | undefined;
  /** Overrides merged over the stored fields (a proposed edit). */
  fields?: Record<string, string> | undefined;
}

/**
 * One resource's (or one proposed edit's) monthly footprint. Mirrors
 * `estimateResourceCost`: the same identity binding, the same merge of
 * overrides over stored fields, so the cost and carbon beside it describe
 * the same configuration.
 */
export async function getResourceCarbon(
  organizationId: string,
  input: ResourceCarbonInput,
): Promise<ResourceCarbonEstimate | null> {
  const [account] = await db
    .select({ pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);
  if (!account) return null;

  let stored: Record<string, unknown> = {};
  if (input.resourceId) {
    const [row] = await db
      .select({ fieldsJson: resources.fieldsJson })
      .from(resources)
      .where(
        and(
          eq(resources.id, input.resourceId),
          eq(resources.organizationId, organizationId),
          eq(resources.accountId, input.accountId),
          eq(resources.resourceTypeId, input.resourceTypeId),
        ),
      )
      .limit(1);
    if (!row) return null;
    stored = (row.fieldsJson ?? {}) as Record<string, unknown>;
  }

  const shape = (await typeShapes()).get(`${account.pluginId}:${input.resourceTypeId}`);
  const declaration = shape ? effectiveCarbonDeclaration(shape) : null;
  if (!declaration) return resourceCarbonEstimate(null);
  const read = await readCarbonInputs(
    declaration,
    { ...stored, ...(input.fields ?? {}) },
    {
      pluginId: account.pluginId,
      resourceTypeId: input.resourceTypeId,
      loadCatalogue: catalogueLoader(organizationId, input.accountId),
    },
  );
  return resourceCarbonEstimate(read);
}

/**
 * The monthly footprint of a create-form configuration (an environment
 * template member), read the way the create form reads it.
 */
export async function getConfigCarbon(
  organizationId: string,
  input: {
    accountId: string;
    pluginId: string;
    resourceTypeId: string;
    fields: Record<string, string>;
  },
): Promise<CarbonFootprint | null> {
  const hint = await carbonHintFor(input.pluginId, input.resourceTypeId);
  if (!hint) return null;
  const config = await cachedCreateConfig(organizationId, input.accountId, input.resourceTypeId);
  if (!config) return null;
  return estimateCreateFormCarbon({ ...config, carbon: hint }, input.fields);
}
