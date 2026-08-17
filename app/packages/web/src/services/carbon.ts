/**
 * The carbon estimate, assembled over synced inventory.
 *
 * It lives in `web/src/services` beside right-sizing rather than in server-core
 * for one reason: turning an instance-type id into a vCPU count needs the
 * plugin's own size catalogue, which needs a client and credentials. That is
 * exactly what `rightsizing.ts` already does, and this module deliberately
 * reads the **same plugin declaration** rather than introducing a second way to
 * ask how big a resource is.
 *
 * Reusing `RightsizingDeclaration` also decides the coverage question honestly:
 * a resource type whose plugin has not declared a size field is reported as
 * `unknown-size`, which is a truthful and explainable gap rather than a
 * guess — and it means a plugin that gains right-sizing gains a carbon estimate
 * for free.
 *
 * All the arithmetic and every coefficient are in `@infrawrench/client-core`
 * (`carbon.ts`, `carbon-factors.ts`); this module only gathers the inputs.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  estimateCarbon,
  type CarbonEstimate,
  type CarbonInputResource,
} from "@infrawrench/client-core";
import { db } from "@infrawrench/server-core/db/client";
import { accounts, resources } from "@infrawrench/server-core/db/schema";
import { loadPlugins } from "@infrawrench/server-core/plugin-loader";
import { getOrgAccountClient } from "@infrawrench/server-core/org-accounts";

export interface CarbonOptions {
  windowDays?: number;
  now?: number;
}

/**
 * Look up a field on a resource's stored fields, case-insensitively.
 *
 * Plugins are inconsistent about casing for the same concept (`vmSize` vs
 * `vm_size`), and the declaration names one spelling. Matching loosely here
 * costs nothing and avoids a whole class of "why is this resource unestimated"
 * that has nothing to do with carbon.
 */
function readField(fields: Record<string, unknown>, key: string | undefined): string | null {
  if (!key) return null;
  const direct = fields[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(fields)) {
    if (name.toLowerCase() === lower && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/**
 * The org's estimated operational carbon over a window.
 *
 * Size catalogues are fetched **once per (account, resource type)** and cached
 * for the call: an estate with three hundred instances of six types is six
 * catalogue reads, not three hundred. A catalogue that fails costs its
 * resources an estimate — they come back as `unknown-size` — and never the
 * whole report, the right-sizing stance.
 */
export async function getCarbonEstimate(
  organizationId: string,
  options: CarbonOptions = {},
): Promise<CarbonEstimate> {
  const [plugins, rows] = await Promise.all([
    loadPlugins(),
    db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        accountName: accounts.displayName,
        displayName: resources.displayName,
        fieldsJson: resources.fieldsJson,
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

  const declarationFor = new Map<
    string,
    {
      sizeFieldKey: string;
      createSizeFieldKey?: string | undefined;
      regionFieldKey?: string | undefined;
    }
  >();
  for (const loaded of plugins) {
    for (const type of loaded.plugin.resourceTypes) {
      if (!type.rightsizing) continue;
      declarationFor.set(`${loaded.plugin.manifest.id}:${type.id}`, {
        sizeFieldKey: type.rightsizing.sizeFieldKey,
        createSizeFieldKey: type.rightsizing.createSizeFieldKey,
        regionFieldKey: type.rightsizing.regionFieldKey,
      });
    }
  }

  /** account+type → (size id → vCPUs). Resolved at most once per pair. */
  const catalogues = new Map<string, Promise<Map<string, number>>>();
  function catalogueFor(accountId: string, typeId: string, fieldKey: string) {
    const key = `${accountId}:${typeId}`;
    let entry = catalogues.get(key);
    if (!entry) {
      entry = (async () => {
        try {
          const ctx = await getOrgAccountClient(accountId, organizationId);
          if (!ctx?.client.getCreateConfig) return new Map<string, number>();
          // The same read right-sizing makes: the create form's size-picker is
          // where a provider publishes vCPU counts, and asking for it twice in
          // two shapes is how the two features would come to disagree.
          const config = await ctx.client.getCreateConfig(typeId);
          const field = config.fields.find((f) => f.key === fieldKey && f.kind === "size-picker");
          return new Map(
            (field?.sizes ?? [])
              .filter((size) => typeof size.vcpus === "number" && size.vcpus > 0)
              .map((size) => [size.id, size.vcpus] as const),
          );
        } catch (err) {
          // One provider's catalogue failing costs its resources an estimate,
          // never the report. They surface as `unknown-size`, which is true.
          console.error(`[carbon] size catalogue failed for ${accountId}/${typeId}:`, err);
          return new Map<string, number>();
        }
      })();
      catalogues.set(key, entry);
    }
    return entry;
  }

  const inputs: CarbonInputResource[] = [];
  for (const row of rows) {
    const declaration = declarationFor.get(`${row.pluginId}:${row.resourceTypeId}`);
    const fields = (row.fieldsJson ?? {}) as Record<string, unknown>;
    const region = declaration
      ? (readField(fields, declaration.regionFieldKey) ?? readField(fields, "region"))
      : readField(fields, "region");

    let vcpus: number | null = null;
    if (declaration) {
      const sizeId = readField(fields, declaration.sizeFieldKey);
      if (sizeId) {
        const catalogue = await catalogueFor(
          row.accountId,
          row.resourceTypeId,
          declaration.createSizeFieldKey ?? declaration.sizeFieldKey,
        );
        vcpus = catalogue.get(sizeId) ?? null;
      }
    }

    inputs.push({
      resourceId: row.id,
      pluginId: row.pluginId,
      resourceTypeId: row.resourceTypeId,
      accountId: row.accountId,
      accountName: row.accountName,
      displayName: row.displayName,
      region,
      vcpus,
    });
  }

  return estimateCarbon(inputs, {
    ...(options.windowDays !== undefined ? { windowDays: options.windowDays } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}
