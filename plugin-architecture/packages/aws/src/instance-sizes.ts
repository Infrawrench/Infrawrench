import {
  fetchInstanceCatalog,
  type CreateResourceConfig,
  type InstanceCatalogEntry,
  type InstancePricingHostServices,
  type SizeOption,
} from "@infrawrench/plugin-base";

/**
 * Which create-form fields pick an instance size, and the price list they come
 * from. The forms keep their own static lists, which go stale as AWS launches
 * instances and are all there is when the host has no warehouse; with one, this
 * swaps in every current-generation type the provider lists.
 */
const SIZE_FIELDS: Readonly<
  Record<string, { fieldKey: string; platform: string; exclude?: RegExp }>
> = {
  "ec2-instance": { fieldKey: "instanceType", platform: "ec2" },
  "eks-cluster": { fieldKey: "instanceType", platform: "ec2" },
  "rds-instance": { fieldKey: "instanceClass", platform: "rds" },
  "elasticache-cluster": { fieldKey: "cacheNodeType", platform: "elasticache" },
  // UltraWarm is a storage tier attached to a domain, not a data node type.
  "opensearch-domain": { fieldKey: "instanceType", platform: "opensearch", exclude: /^ultrawarm/ },
  // DC2 is still in the price list, but can no longer be created.
  "redshift-cluster": { fieldKey: "nodeType", platform: "redshift", exclude: /^dc2\./ },
};

/** Categories in the order people look for them; anything else follows alphabetically. */
const CATEGORY_ORDER = ["General purpose", "Standard", "Compute optimized", "Memory optimized"];

function categoryRank(category: string): number {
  const rank = CATEGORY_ORDER.indexOf(category);
  return rank === -1 ? CATEGORY_ORDER.length : rank;
}

/** Burstable families lead a category, as the smallest thing most people want. */
const burstable = (family: string) => (/^t\d/.test(family) ? 0 : 1);

/** Series together, its newest generation first: t4g, t3, t3a, t2; m8g, m7g, m6i. */
function compareFamilies(a: string, b: string): number {
  const [, aSeries = a, aGen = "0", aRest = ""] = /^([a-z]+)(\d+)(.*)$/.exec(a) ?? [];
  const [, bSeries = b, bGen = "0", bRest = ""] = /^([a-z]+)(\d+)(.*)$/.exec(b) ?? [];
  return (
    aSeries.localeCompare(bSeries) || Number(bGen) - Number(aGen) || aRest.localeCompare(bRest)
  );
}

/** Its family, or the name before the first dot when the warehouse has none (`ra3.xlplus`). */
function familyOf(entry: InstanceCatalogEntry): string {
  return entry.family || entry.instanceType.split(".")[0] || "";
}

function toSizes(catalog: readonly InstanceCatalogEntry[]): SizeOption[] {
  return [...catalog]
    .sort(
      (a, b) =>
        categoryRank(a.category) - categoryRank(b.category) ||
        a.category.localeCompare(b.category) ||
        burstable(familyOf(a)) - burstable(familyOf(b)) ||
        compareFamilies(familyOf(a), familyOf(b)) ||
        a.vcpus - b.vcpus ||
        a.memoryMb - b.memoryMb ||
        a.instanceType.localeCompare(b.instanceType),
    )
    .map((entry) => {
      const name = familyOf(entry);
      const family = name.charAt(0).toUpperCase() + name.slice(1);
      const architecture = entry.architecture ? ` (${entry.architecture})` : "";
      return {
        id: entry.instanceType,
        label: entry.instanceType,
        vcpus: entry.vcpus,
        memoryMb: entry.memoryMb,
        category: `${family}${entry.category ? ` · ${entry.category}` : ""}${architecture}`,
      };
    });
}

/** `config` with its instance size field listing the provider's current types, when known. */
export async function withCurrentInstanceSizes(
  pricing: InstancePricingHostServices | undefined,
  typeId: string,
  config: CreateResourceConfig,
): Promise<CreateResourceConfig> {
  const target = SIZE_FIELDS[typeId];
  if (!target || !pricing) return config;
  const catalog = await fetchInstanceCatalog(pricing, target.platform);
  if (!catalog) return config;
  const sizes = toSizes(catalog.filter((entry) => !target.exclude?.test(entry.instanceType)));
  return {
    ...config,
    fields: config.fields.map((field) => {
      if (field.key !== target.fieldKey) return field;
      // A field the form offered as a plain select loses its options here.
      const { options: _options, ...rest } = field;
      return { ...rest, kind: "size-picker" as const, sizes };
    }),
  };
}

/**
 * What the size picker prices each platform's sizes as. The picker does not know
 * the rest of the form, so these are the commonest configurations; the estimate
 * uses what was actually chosen.
 */
export const SIZE_PICKER_PRICING: Readonly<
  Record<string, { platform: string; selection: Readonly<Record<string, string>> }>
> = {
  "rds-instance": {
    platform: "rds",
    selection: { database_engine: "PostgreSQL", deployment_option: "Single-AZ" },
  },
  "elasticache-cluster": { platform: "elasticache", selection: { cache_engine: "Redis" } },
  "opensearch-domain": { platform: "opensearch", selection: {} },
  "redshift-cluster": { platform: "redshift", selection: {} },
};
