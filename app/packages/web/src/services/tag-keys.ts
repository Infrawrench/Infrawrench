/**
 * Tag key management: the org's hidden and preferred tag keys, applied to
 * every tag-key listing the server hands a picker, plus the discovery table
 * the settings page edits them from.
 *
 * Applied here, server-side, rather than in each picker, so every surface
 * (web, desktop, mobile, the CLI, the MCP tools) gets the same list without
 * each one fetching the settings and re-implementing the matching. Nothing on
 * the write or query path reads the settings: a hidden key is a display
 * preference, and its cost rows are stored, exported and queryable as before.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  applyTagKeySettings,
  extractRecordTags,
  hiddenTagKeyMatch,
  isTagKeyHidden,
  type CostDimensionOption,
  type DiscoveredTagKey,
  type DiscoveredTagKeysResponse,
  type TagKeySettings,
  type TagKeySource,
} from "@infrawrench/client-core";
import {
  getCostTagKeys,
  getCostTagKeyUsage,
} from "@infrawrench/server-core/clickhouse/cost-readers";
import { getOrgTagKeySettings } from "@infrawrench/server-core/cost/tag-key-settings";
import { addDays, isoDay } from "@infrawrench/server-core/cost/dates";
import { db } from "../db/client";
import { resources } from "../db/schema";

/** Most tag keys a picker is handed; preferred keys always fit. */
export const PICKER_TAG_KEY_LIMIT = 200;

/** Days of cost data the discovery table counts. */
export const TAG_KEY_LOOKBACK_DAYS = 90;

/** Newest resources scanned for inventory tag keys, the metric-alert bound. */
const INVENTORY_SCAN_LIMIT = 2000;

/** Most keys the discovery table returns. */
const DISCOVERY_LIMIT = 1000;

/**
 * Tag keys in the org's cost data, as picker options: preferred keys first,
 * hidden keys dropped (or flagged and last, with `includeHidden`), capped at
 * {@link PICKER_TAG_KEY_LIMIT}.
 */
export async function listPickerCostTagKeys(
  organizationId: string,
  opts: { includeHidden?: boolean } = {},
): Promise<CostDimensionOption[]> {
  const [keys, settings] = await Promise.all([
    getCostTagKeys(organizationId),
    getOrgTagKeySettings(organizationId),
  ]);
  return applyTagKeySettings(keys, settings, opts).slice(0, PICKER_TAG_KEY_LIMIT);
}

/**
 * Apply the org's settings to a plain key list from somewhere other than the
 * cost data (the resource inventory). Returns the visible keys in picker order
 * plus which of them are preferred, for surfaces whose contract is `string[]`.
 */
export function orderTagKeysForPicker(
  keys: readonly string[],
  settings: TagKeySettings,
): { tagKeys: string[]; preferredTagKeys: string[] } {
  const options = applyTagKeySettings(keys, settings);
  return {
    tagKeys: options.map((o) => o.value),
    preferredTagKeys: options.filter((o) => o.preferred).map((o) => o.value),
  };
}

interface InventoryKeyUsage {
  pluginIds: Set<string>;
  count: number;
}

/** Tag keys on the newest synced resources, with which plugins carry them. */
async function inventoryTagKeyUsage(
  organizationId: string,
): Promise<Map<string, InventoryKeyUsage>> {
  const rows = await db
    .select({
      pluginId: resources.pluginId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt)))
    .orderBy(desc(resources.updatedAt))
    .limit(INVENTORY_SCAN_LIMIT);
  const usage = new Map<string, InventoryKeyUsage>();
  for (const row of rows) {
    const tags = extractRecordTags({ ...row.outputsJson, ...row.fieldsJson });
    if (!tags) continue;
    for (const key of Object.keys(tags)) {
      const entry = usage.get(key) ?? { pluginIds: new Set<string>(), count: 0 };
      entry.pluginIds.add(row.pluginId);
      entry.count += 1;
      usage.set(key, entry);
    }
  }
  return usage;
}

/**
 * Every tag key the org's data carries, with where it comes from and how much
 * it is used, flagged against the current settings: what the settings page's
 * picker lists. Cost usage is read only when the caller may read costs, so a
 * member without `costs:read` still sees the inventory half.
 */
export async function discoverTagKeys(
  organizationId: string,
  opts: { includeCosts: boolean; now?: Date },
): Promise<DiscoveredTagKeysResponse> {
  const from = addDays(isoDay(opts.now ?? new Date()), -TAG_KEY_LOOKBACK_DAYS);
  const [settings, costUsage, inventory] = await Promise.all([
    getOrgTagKeySettings(organizationId),
    opts.includeCosts ? getCostTagKeyUsage(organizationId, from) : Promise.resolve([]),
    inventoryTagKeyUsage(organizationId),
  ]);

  const byKey = new Map<string, DiscoveredTagKey>();
  const entry = (key: string): DiscoveredTagKey => {
    let row = byKey.get(key);
    if (!row) {
      const hiddenBy = settings.preferred.includes(key)
        ? null
        : hiddenTagKeyMatch(key, settings.hidden);
      row = {
        key,
        providers: [],
        sources: [],
        costRowCount: 0,
        costResourceCount: 0,
        inventoryCount: 0,
        lastSeen: null,
        hidden: isTagKeyHidden(key, settings),
        hiddenBy,
        preferred: settings.preferred.includes(key),
      };
      byKey.set(key, row);
    }
    return row;
  };
  const addSource = (row: DiscoveredTagKey, source: TagKeySource, pluginIds: Iterable<string>) => {
    if (!row.sources.includes(source)) row.sources.push(source);
    row.providers = [...new Set([...row.providers, ...pluginIds])].sort();
  };

  for (const usage of costUsage) {
    const row = entry(usage.key);
    addSource(row, "costs", usage.pluginIds);
    row.costRowCount = usage.rowCount;
    row.costResourceCount = usage.resourceCount;
    row.lastSeen = usage.lastSeen;
  }
  for (const [key, usage] of inventory) {
    const row = entry(key);
    addSource(row, "resources", usage.pluginIds);
    row.inventoryCount = usage.count;
  }

  // Preferred first (in the org's order), then the busiest keys: the ones most
  // worth a decision. Ties alphabetically so the table is stable.
  const preferredRank = new Map(settings.preferred.map((k, i) => [k, i]));
  const keys = [...byKey.values()].sort((a, b) => {
    const pa = preferredRank.get(a.key);
    const pb = preferredRank.get(b.key);
    if (pa !== undefined || pb !== undefined) return (pa ?? Infinity) - (pb ?? Infinity);
    const usageA = a.costRowCount + a.inventoryCount;
    const usageB = b.costRowCount + b.inventoryCount;
    return usageB - usageA || a.key.localeCompare(b.key);
  });

  return {
    keys: keys.slice(0, DISCOVERY_LIMIT),
    settings,
    lookbackDays: TAG_KEY_LOOKBACK_DAYS,
    truncated: keys.length > DISCOVERY_LIMIT,
  };
}
