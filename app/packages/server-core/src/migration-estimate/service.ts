/**
 * The migration estimate's server half: "what would these resources cost on
 * provider X?".
 *
 * Gathers the inputs and leaves the decisions to the pure functions in
 * `@infrawrench/client-core` (`migration-estimates.ts`). Provider knowledge
 * stays on the plugins: each type's `equivalence` says what it is and its
 * `sizing` flags say which fields carry the size; this file reads those and
 * knows nothing about any provider.
 *
 * Per resource:
 *
 * 1. **Category.** `resolveEquivalence` on the source type and its stored
 *    fields. None: listed as having no equivalent.
 * 2. **Size.** The flagged fields; an instance type is resolved to vCPUs,
 *    memory and GPUs through the source's price catalog or its create form's
 *    size picker.
 * 3. **Current cost.** The resource's billed spend over the last 30 days
 *    (as the caller's cost visibility scope sees it), else the plugin's
 *    estimate, else the size's list price. Else unknown.
 * 4. **Target.** The target's type of the same category (or the user's
 *    pick), its sizes from the target's price catalog or create form, the
 *    cheapest one meeting or exceeding the source (or the user's pick), and
 *    its price from the target plugin's estimate or the size's list price.
 *    Else unknown, with the reason.
 *
 * Every I/O dependency is injected (`MigrationEstimateDeps`) so the matching
 * is tested without a database or a provider.
 */
import type {
  CostEstimate,
  CreateFieldConfig,
  CreateResourceConfig,
  HostPlugin,
  ResourceInstance,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";
import {
  buildTargetFields,
  equivalenceCategories,
  equivalenceRuleForCategory,
  exportResourcesToTerraform,
  readResourceSizing,
  resolveEquivalence,
  sizingFieldKeys,
  type EquivalenceCategory,
  type ResourceSizing,
} from "@infrawrench/plugin-base";
import {
  MIGRATION_ESTIMATE_LIMITS,
  MIGRATION_MAX_CANDIDATES,
  chooseMigrationRegion,
  migrationRegionArea,
  migrationTargetRegions,
  pickMigrationSize,
  rankMigrationSizes,
  specIsKnown,
  summarizeMigrationTotals,
  type MigrationCost,
  type MigrationEstimateInput,
  type MigrationEstimateResult,
  type MigrationMoney,
  type MigrationRow,
  type MigrationSizeOption,
  type MigrationSpecTarget,
  type MigrationTargetNote,
  type MigrationTargetProvider,
  type MigrationTerraformResult,
  type MigrationUnmatchedRow,
  type PriceCatalogConverter,
  type PriceCatalogProviderState,
  type PriceCatalogRow,
} from "@infrawrench/client-core";

/** A synced resource, as the estimate reads it. */
export interface MigrationSourceResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  parentResourceId: string | null;
  fields: Record<string, unknown>;
}

export interface MigrationCatalogSlice {
  state: PriceCatalogProviderState;
  /** The region the rows are priced in. */
  region: string | null;
  rows: PriceCatalogRow[];
}

/** What the service needs from the rest of the server; injected for tests. */
export interface MigrationEstimateDeps {
  listPlugins(): Promise<HostPlugin[]>;
  /** A service's name and member resource ids, or null when there is no such service. */
  loadService(
    organizationId: string,
    serviceId: string,
  ): Promise<{ name: string; resourceIds: string[] } | null>;
  /** The org's live resources among `ids`. */
  loadResources(organizationId: string, ids: string[]): Promise<MigrationSourceResource[]>;
  /**
   * Billed spend over the trailing 30 days, keyed `"<accountId> <externalId>"`,
   * read inside the caller's cost visibility scope. Null when cost data
   * cannot be read.
   */
  loadSpend(organizationId: string): Promise<Map<string, MigrationMoney[]> | null>;
  /** The plugin's estimate for an existing resource. */
  estimateExisting(
    organizationId: string,
    resource: MigrationSourceResource,
  ): Promise<CostEstimate | null>;
  /** One provider's machine price list in one region (on-demand). */
  catalogRows(
    organizationId: string,
    pluginId: string,
    region: string | undefined,
  ): Promise<MigrationCatalogSlice>;
  /** The org's live account ids on a plugin, oldest first. */
  listAccountIds(organizationId: string, pluginId: string): Promise<string[]>;
  createConfig(
    organizationId: string,
    accountId: string,
    typeId: string,
  ): Promise<CreateResourceConfig | null>;
  sizePricing(
    organizationId: string,
    accountId: string,
    typeId: string,
    request: { regionId?: string; sizes: Array<{ id: string; vcpus: number; memoryMb: number }> },
  ): Promise<Record<string, number> | null>;
  estimateTarget(
    organizationId: string,
    accountId: string,
    typeId: string,
    fields: Record<string, string>,
  ): Promise<CostEstimate | null>;
  loadConverter(
    organizationId: string,
  ): Promise<{ displayCurrency: string | null; convert: PriceCatalogConverter }>;
  now(): number;
}

/** The request cannot be answered as asked (HTTP 400). */
export class MigrationEstimateInputError extends Error {}
/** The source does not exist (HTTP 404). */
export class MigrationEstimateSourceNotFoundError extends Error {}

/** Billed spend covers 30 days; a month here is 730 hours. */
const BILLED_TO_MONTH = 730 / (30 * 24);

/** Categories whose sizes are machines, so a provider's machine catalog prices them. */
const MACHINE_CATEGORIES = new Set<EquivalenceCategory>([
  "vm",
  "kubernetes-cluster",
  "kubernetes-node-pool",
]);

const round2 = (n: number) => Math.round(n * 100) / 100;

function typeOf(plugin: HostPlugin | undefined, typeId: string) {
  return plugin?.resourceTypes.find((t) => t.id === typeId);
}

function sizePickerFor(
  config: CreateResourceConfig | null,
  type: ResourceTypeDefinition,
): CreateFieldConfig | null {
  const pickers = (config?.fields ?? []).filter((f) => f.kind === "size-picker");
  if (pickers.length === 0) return null;
  const flagged = sizingFieldKeys(type)["instance-type"];
  return (
    pickers.find((f) => f.key === flagged) ??
    pickers.find((f) => f.key === type.rightsizing?.createSizeFieldKey) ??
    (pickers.length === 1 ? pickers[0]! : null)
  );
}

function sizeCurrency(type: ResourceTypeDefinition): string {
  return type.rightsizing?.priceCurrency ?? "USD";
}

function costFromEstimate(estimate: CostEstimate, count = 1): MigrationCost {
  return {
    amount: round2(estimate.monthlyAmount * count),
    currency: estimate.currency,
    basis: "estimate",
    partial: estimate.partial === true,
  };
}

function rowToOption(row: PriceCatalogRow): Omit<MigrationSizeOption, "meetsSpec"> {
  return {
    id: row.sku,
    label: row.name,
    vcpus: row.specs.vcpus ?? null,
    memoryGb: row.specs.memoryGb ?? null,
    gpuCount: row.specs.gpuCount ?? null,
    gpuModel: row.specs.gpuModel ?? null,
    monthly:
      row.monthlyAmount !== null
        ? { amount: round2(row.monthlyAmount), currency: row.price.currency }
        : null,
  };
}

export function createMigrationEstimateService(deps: MigrationEstimateDeps) {
  async function pluginMap(): Promise<Map<string, HostPlugin>> {
    return new Map((await deps.listPlugins()).map((p) => [p.manifest.id, p]));
  }

  /** Providers an estimate can target: those with at least one categorised type. */
  async function targets(organizationId: string): Promise<MigrationTargetProvider[]> {
    const plugins = await deps.listPlugins();
    const out: MigrationTargetProvider[] = [];
    for (const plugin of plugins) {
      const categories = [
        ...new Set(plugin.resourceTypes.flatMap((t) => equivalenceCategories(t))),
      ];
      if (categories.length === 0) continue;
      const decl = plugin.manifest.priceCatalog;
      const accountIds = await deps.listAccountIds(organizationId, plugin.manifest.id);
      const sizePickerOnly = !decl;
      out.push({
        pluginId: plugin.manifest.id,
        pluginName: plugin.manifest.displayName,
        categories,
        regions: migrationTargetRegions(plugin.manifest.id, decl?.regions ?? null),
        priceCatalog: Boolean(decl),
        needsAccount: sizePickerOnly || decl!.requiresCredentials,
        hasAccount: accountIds.length > 0,
        terraform: Boolean(plugin.terraformExport),
      });
    }
    return out.sort((a, b) => a.pluginName.localeCompare(b.pluginName));
  }

  async function resolveSource(
    organizationId: string,
    source: MigrationEstimateInput["source"],
  ): Promise<{ label: string; ids: string[] }> {
    if (source.kind === "service") {
      const service = await deps.loadService(organizationId, source.serviceId);
      if (!service) throw new MigrationEstimateSourceNotFoundError("Service not found.");
      return { label: service.name, ids: service.resourceIds };
    }
    return {
      label: `${source.resourceIds.length} resource${source.resourceIds.length === 1 ? "" : "s"}`,
      ids: source.resourceIds,
    };
  }

  async function compute(
    organizationId: string,
    input: MigrationEstimateInput,
    opts: { estimateId?: string | null } = {},
  ): Promise<MigrationEstimateResult> {
    const plugins = await pluginMap();
    const target = plugins.get(input.targetPluginId);
    if (!target) {
      throw new MigrationEstimateInputError(`Unknown target provider "${input.targetPluginId}".`);
    }
    const targetTypesByCategory = new Map<EquivalenceCategory, ResourceTypeDefinition[]>();
    // Types the user can create come first: the default target is something
    // the provider will actually make.
    const orderedTypes = [...target.resourceTypes].sort(
      (a, b) => Number(Boolean(b.supportsCreate)) - Number(Boolean(a.supportsCreate)),
    );
    for (const type of orderedTypes) {
      for (const category of equivalenceCategories(type)) {
        const list = targetTypesByCategory.get(category) ?? [];
        list.push(type);
        targetTypesByCategory.set(category, list);
      }
    }
    if (targetTypesByCategory.size === 0) {
      throw new MigrationEstimateInputError(
        `${target.manifest.displayName} has no resource types an estimate can match.`,
      );
    }

    const { label, ids } = await resolveSource(organizationId, input.source);
    const unique = [...new Set(ids)];
    const truncated = unique.length > MIGRATION_ESTIMATE_LIMITS.maxResources;
    const capped = unique.slice(0, MIGRATION_ESTIMATE_LIMITS.maxResources);

    const [resources, spend, converter, targetAccountIds] = await Promise.all([
      capped.length > 0 ? deps.loadResources(organizationId, capped) : Promise.resolve([]),
      deps.loadSpend(organizationId).catch(() => null),
      deps.loadConverter(organizationId),
      deps.listAccountIds(organizationId, target.manifest.id),
    ]);
    const targetAccountId = targetAccountIds[0] ?? null;
    const convertMoney = (m: MigrationMoney): MigrationMoney | null =>
      converter.convert(m.amount, m.currency);

    // Per-request caches: one catalog read per (plugin, region), one create
    // config per (account, type), however many rows share them.
    const catalogCache = new Map<string, Promise<MigrationCatalogSlice>>();
    const catalog = (pluginId: string, region: string | undefined) => {
      const key = `${pluginId}|${region ?? ""}`;
      let hit = catalogCache.get(key);
      if (!hit) {
        hit = deps
          .catalogRows(organizationId, pluginId, region)
          .catch((): MigrationCatalogSlice => ({ state: "error", region: null, rows: [] }));
        catalogCache.set(key, hit);
      }
      return hit;
    };
    const configCache = new Map<string, Promise<CreateResourceConfig | null>>();
    const config = (accountId: string, typeId: string) => {
      const key = `${accountId}|${typeId}`;
      let hit = configCache.get(key);
      if (!hit) {
        hit = deps.createConfig(organizationId, accountId, typeId).catch(() => null);
        configCache.set(key, hit);
      }
      return hit;
    };
    const pricingCache = new Map<string, Promise<Record<string, number> | null>>();

    // First pass: categorise and read sizes, so the region can be chosen from
    // where the matched resources are.
    interface Pending {
      resource: MigrationSourceResource;
      plugin: HostPlugin | undefined;
      type: ResourceTypeDefinition;
      category: EquivalenceCategory;
      sizing: ResourceSizing;
    }
    const pending: Pending[] = [];
    const unmatched: MigrationUnmatchedRow[] = [];
    const byId = new Map(resources.map((r) => [r.id, r]));

    const currentCost = async (
      resource: MigrationSourceResource,
      listPrice: MigrationMoney | null,
      count: number,
    ): Promise<MigrationCost | null> => {
      if (spend && resource.externalId) {
        const billed = spend.get(`${resource.accountId} ${resource.externalId}`);
        const largest = billed?.slice().sort((a, b) => b.amount - a.amount)[0];
        if (largest && largest.amount > 0) {
          return {
            amount: round2(largest.amount * BILLED_TO_MONTH),
            currency: largest.currency,
            basis: "billed",
            partial: false,
          };
        }
      }
      const estimate = await deps.estimateExisting(organizationId, resource).catch(() => null);
      if (estimate) return costFromEstimate(estimate);
      if (listPrice) {
        return {
          amount: round2(listPrice.amount * count),
          currency: listPrice.currency,
          basis: "list-price",
          partial: false,
        };
      }
      return null;
    };

    for (const id of capped) {
      const resource = byId.get(id);
      if (!resource) continue;
      const plugin = plugins.get(resource.pluginId);
      const type = typeOf(plugin, resource.resourceTypeId);
      const rule = type ? resolveEquivalence(type, resource.fields) : null;
      if (!type || !rule) {
        unmatched.push({
          resourceId: resource.id,
          displayName: resource.displayName,
          pluginId: resource.pluginId,
          pluginName: plugin?.manifest.displayName ?? resource.pluginId,
          resourceTypeId: resource.resourceTypeId,
          resourceTypeName: type?.displayName ?? resource.resourceTypeId,
          category: null,
          reason: "no-category",
          current: await currentCost(resource, null, 1),
        });
        continue;
      }
      pending.push({
        resource,
        plugin,
        type,
        category: rule.category,
        sizing: readResourceSizing(type, resource.fields),
      });
    }

    // A cluster whose node pools are in the set too: the pools carry the
    // nodes, so the cluster row prices the cluster alone rather than counting
    // every node twice.
    const poolParents = new Set(
      pending
        .filter((p) => p.category === "kubernetes-node-pool" && p.resource.parentResourceId)
        .map((p) => p.resource.parentResourceId!),
    );
    for (const p of pending) {
      if (p.category !== "kubernetes-cluster" || !poolParents.has(p.resource.id)) continue;
      p.sizing = p.sizing.region ? { region: p.sizing.region } : {};
    }

    const areaOf = (p: Pending) =>
      migrationRegionArea(
        p.resource.pluginId,
        p.sizing.region,
        p.plugin?.manifest.priceCatalog?.regions ?? [],
      );
    const sourceAreas = pending.map(areaOf);
    const targetRegions = migrationTargetRegions(
      target.manifest.id,
      target.manifest.priceCatalog?.regions ?? null,
    );
    const { region: chosenRegion, choice } = chooseMigrationRegion(
      targetRegions,
      sourceAreas,
      input.targetRegion,
    );
    const knownAreas = [...new Set(sourceAreas.filter((a) => a !== null))];

    const targetCatalog = target.manifest.priceCatalog
      ? await catalog(target.manifest.id, chosenRegion?.id)
      : null;
    // A catalog the org cannot read (no account on a credentialed source) is
    // as good as none; the size picker below needs an account too.
    const targetCatalogRows = (targetCatalog?.rows ?? []).filter(
      (r) => r.family === "compute" || r.family === "gpu",
    );

    const rows: MigrationRow[] = [];
    for (const [index, p] of pending.entries()) {
      const { resource, plugin, type, category, sizing } = p;
      const count = sizing.nodeCount && sizing.nodeCount > 0 ? sizing.nodeCount : 1;

      // Source size: flagged capacity, else the instance type looked up in
      // the source's catalog or create form.
      let vcpus = sizing.vcpus ?? null;
      let memoryGb = sizing.memoryGb ?? null;
      let gpuCount = sizing.gpuCount ?? null;
      let gpuModel = sizing.gpuModel ?? null;
      let listPrice: MigrationMoney | null = null;
      if (sizing.instanceType) {
        const wanted = sizing.instanceType.toLowerCase();
        if (plugin?.manifest.priceCatalog) {
          const slice = await catalog(resource.pluginId, sizing.region);
          const match = slice.rows.find(
            (r) => r.sku.toLowerCase() === wanted || r.name.toLowerCase() === wanted,
          );
          if (match) {
            vcpus ??= match.specs.vcpus ?? null;
            memoryGb ??= match.specs.memoryGb ?? null;
            gpuCount ??= match.specs.gpuCount ?? null;
            gpuModel ??= match.specs.gpuModel ?? null;
            // The price is only this resource's when it is priced in its region.
            if (match.monthlyAmount !== null && match.region === slice.region && slice.region) {
              const sameRegion =
                sizing.region && sizing.region.toLowerCase().startsWith(slice.region.toLowerCase());
              if (sameRegion) {
                listPrice = { amount: match.monthlyAmount, currency: match.price.currency };
              }
            }
          }
        }
        if (vcpus === null && memoryGb === null) {
          const picker = sizePickerFor(await config(resource.accountId, type.id), type);
          const size = picker?.sizes?.find((s) => s.id.toLowerCase() === wanted);
          if (size) {
            vcpus = size.vcpus;
            memoryGb = size.memoryMb / 1024;
            if (size.priceMonthly !== undefined && size.priceMonthly > 0) {
              listPrice ??= { amount: size.priceMonthly, currency: sizeCurrency(type) };
            }
          }
        }
      }
      const spec: MigrationSpecTarget = { vcpus, memoryGb, gpuCount };
      const current = await currentCost(resource, listPrice, count);

      // Target type: the user's pick when it is of this category, else the first.
      const candidatesTypes = targetTypesByCategory.get(category) ?? [];
      const override = input.overrides[resource.id];
      const targetType =
        candidatesTypes.find((t) => t.id === override?.resourceTypeId) ?? candidatesTypes[0];
      if (!targetType) {
        unmatched.push({
          resourceId: resource.id,
          displayName: resource.displayName,
          pluginId: resource.pluginId,
          pluginName: plugin?.manifest.displayName ?? resource.pluginId,
          resourceTypeId: resource.resourceTypeId,
          resourceTypeName: type.displayName,
          category,
          reason: "no-target-type",
          current,
        });
        continue;
      }
      const targetRule = equivalenceRuleForCategory(targetType, category);
      const targetKeys = sizingFieldKeys(targetType);
      const sized = targetKeys["instance-type"] !== undefined;

      // Target sizes: the machine catalog for machine categories, else the
      // create form's size picker priced for the region.
      let options: Omit<MigrationSizeOption, "meetsSpec">[] = [];
      let fromCatalog = false;
      if (sized && MACHINE_CATEGORIES.has(category) && targetCatalogRows.length > 0) {
        const forType = targetCatalogRows.filter(
          (r) => r.estimate?.resourceTypeId === targetType.id,
        );
        options = (forType.length > 0 ? forType : targetCatalogRows).map(rowToOption);
        fromCatalog = true;
      } else if (sized && targetAccountId) {
        const picker = sizePickerFor(await config(targetAccountId, targetType.id), targetType);
        const sizes = picker?.sizes ?? [];
        if (sizes.length > 0) {
          const pricingKey = `${targetType.id}|${chosenRegion?.id ?? ""}`;
          let pricing = pricingCache.get(pricingKey);
          if (!pricing) {
            pricing = deps
              .sizePricing(organizationId, targetAccountId, targetType.id, {
                ...(chosenRegion ? { regionId: chosenRegion.id } : {}),
                sizes: sizes.map((s) => ({ id: s.id, vcpus: s.vcpus, memoryMb: s.memoryMb })),
              })
              .catch(() => null);
            pricingCache.set(pricingKey, pricing);
          }
          const prices = (await pricing) ?? {};
          const currency = sizeCurrency(targetType);
          options = sizes.map((s) => {
            const price = prices[s.id] ?? s.priceMonthly;
            return {
              id: s.id,
              label: s.label,
              vcpus: s.vcpus,
              memoryGb: s.memoryMb / 1024,
              gpuCount: null,
              gpuModel: null,
              monthly:
                price !== undefined && price > 0 ? { amount: round2(price), currency } : null,
            };
          });
        }
      }
      const ranked = rankMigrationSizes(options, spec, (m) => convertMoney(m)?.amount ?? null);
      const picked =
        (override?.sizeId ? ranked.find((o) => o.id === override.sizeId) : undefined) ??
        pickMigrationSize(ranked);
      const overridden =
        Boolean(override?.sizeId && picked?.id === override.sizeId) ||
        Boolean(override?.resourceTypeId && targetType.id === override.resourceTypeId);

      // Target cost: the target plugin's own estimate for the whole
      // configuration when it can give one (disks, node counts and all),
      // else the size's list price times the count.
      let cost: MigrationCost | null = null;
      const canEstimate = !sized || picked !== null;
      if (targetAccountId && canEstimate) {
        const fields = buildTargetFields(targetType, targetRule, {
          ...(chosenRegion ? { region: chosenRegion.id } : {}),
          ...(picked ? { instanceType: picked.id } : {}),
          ...(picked?.vcpus != null ? { vcpus: picked.vcpus } : vcpus !== null ? { vcpus } : {}),
          ...(picked?.memoryGb != null
            ? { memoryGb: picked.memoryGb }
            : memoryGb !== null
              ? { memoryGb }
              : {}),
          ...(sizing.diskGb !== undefined ? { diskGb: sizing.diskGb } : {}),
          ...(sizing.nodeCount !== undefined ? { nodeCount: sizing.nodeCount } : {}),
          ...(gpuCount !== null ? { gpuCount } : {}),
        });
        const estimate = await deps
          .estimateTarget(organizationId, targetAccountId, targetType.id, fields)
          .catch(() => null);
        // A node-count field the target reads already multiplies; otherwise
        // the estimate is for one unit.
        if (estimate) {
          cost = costFromEstimate(estimate, targetKeys["node-count"] ? 1 : count);
        }
      }
      if (!cost && picked?.monthly) {
        cost = {
          amount: round2(picked.monthly.amount * count),
          currency: picked.monthly.currency,
          basis: "list-price",
          partial: false,
        };
      }

      let note: MigrationTargetNote | null = null;
      if (!cost) {
        const needsAccount =
          (!fromCatalog && sized && !targetAccountId) ||
          targetCatalog?.state === "no-account" ||
          (!sized && !targetAccountId);
        if (sized && !specIsKnown(spec)) note = "source-size-unknown";
        else if (
          targetCatalog &&
          (targetCatalog.state === "loading" || targetCatalog.state === "error") &&
          MACHINE_CATEGORIES.has(category)
        )
          note = "catalog-unavailable";
        else if (needsAccount && options.length === 0) note = "no-account";
        else if (sized && options.length > 0 && !picked) note = "no-size-match";
        else note = "no-price";
      }

      rows.push({
        resourceId: resource.id,
        displayName: resource.displayName,
        pluginId: resource.pluginId,
        pluginName: plugin?.manifest.displayName ?? resource.pluginId,
        resourceTypeId: resource.resourceTypeId,
        resourceTypeName: type.displayName,
        accountId: resource.accountId,
        category,
        sourceRegion: sizing.region ?? null,
        sourceArea: sourceAreas[index] ?? null,
        instanceType: sizing.instanceType ?? null,
        specs: {
          vcpus,
          memoryGb: memoryGb !== null ? round2(memoryGb) : null,
          gpuCount,
          gpuModel,
          diskGb: sizing.diskGb ?? null,
          count,
        },
        current,
        target: {
          resourceTypeId: targetType.id,
          resourceTypeName: targetType.displayName,
          sizeId: picked?.id ?? null,
          sizeLabel: picked?.label ?? null,
          vcpus: picked?.vcpus ?? null,
          memoryGb: picked?.memoryGb != null ? round2(picked.memoryGb) : null,
          gpuCount: picked?.gpuCount ?? null,
          region: chosenRegion?.id ?? null,
          regionLabel: chosenRegion?.label ?? null,
          cost,
          overridden,
        },
        note,
        candidates: ranked.slice(0, MIGRATION_MAX_CANDIDATES).concat(
          // An overridden size past the cap stays in the list it was picked from.
          picked && ranked.indexOf(picked) >= MIGRATION_MAX_CANDIDATES ? [picked] : [],
        ),
        targetTypes: candidatesTypes.map((t) => ({ id: t.id, name: t.displayName })),
      });
    }

    const supported = new Set(target.terraformExport?.supportedResourceTypeIds ?? []);
    return {
      estimateId: opts.estimateId ?? null,
      name: input.name,
      source: { kind: input.source.kind, label, resourceCount: rows.length + unmatched.length },
      target: { pluginId: target.manifest.id, pluginName: target.manifest.displayName },
      region: {
        region: chosenRegion?.id ?? null,
        regionLabel: chosenRegion?.label ?? null,
        area: chosenRegion?.area ?? null,
        sourceAreas: knownAreas,
        choice,
        crossesArea:
          chosenRegion?.area && knownAreas.length > 0 && !sourceAreas.includes(null)
            ? knownAreas.some((a) => a !== chosenRegion.area)
            : null,
      },
      rows,
      unmatched,
      totals: summarizeMigrationTotals(rows, unmatched, convertMoney),
      displayCurrency: converter.displayCurrency,
      terraform: rows.some((r) => supported.has(r.target.resourceTypeId)),
      truncated,
      generatedAt: new Date(deps.now()).toISOString(),
    };
  }

  /**
   * The target provider's Terraform for the matched rows, through the plugin's
   * own `terraformExport`: one stand-in resource per row, carrying the matched
   * size and region in the target type's flagged fields. Null when the target
   * has no Terraform mapping.
   */
  async function terraform(
    result: MigrationEstimateResult,
  ): Promise<MigrationTerraformResult | null> {
    const plugins = await pluginMap();
    const target = plugins.get(result.target.pluginId);
    const capability = target?.terraformExport;
    if (!target || !capability) return null;
    const now = new Date(deps.now()).toISOString();
    const instances: ResourceInstance[] = result.rows.map((row) => {
      const type = typeOf(target, row.target.resourceTypeId);
      const fields = type
        ? buildTargetFields(type, equivalenceRuleForCategory(type, row.category), {
            ...(row.target.region ? { region: row.target.region } : {}),
            ...(row.target.sizeId ? { instanceType: row.target.sizeId } : {}),
            ...(row.target.vcpus !== null ? { vcpus: row.target.vcpus } : {}),
            ...(row.target.memoryGb !== null ? { memoryGb: row.target.memoryGb } : {}),
            ...(row.specs.diskGb !== null ? { diskGb: row.specs.diskGb } : {}),
            ...(row.specs.count > 1 ? { nodeCount: row.specs.count } : {}),
          })
        : {};
      return {
        id: row.resourceId,
        pluginId: target.manifest.id,
        resourceTypeId: row.target.resourceTypeId,
        accountId: "",
        displayName: row.displayName,
        fields: { name: row.displayName, ...fields },
        resolvedOutputs: {},
        secretStates: [],
        createdAt: now,
        updatedAt: now,
      };
    });
    const outcome = exportResourcesToTerraform(instances, (pluginId) =>
      pluginId === target.manifest.id ? capability : undefined,
    );
    return {
      hcl: outcome.hcl,
      exported: outcome.exported.map((e) => ({ resourceId: e.id, address: e.address })),
      unsupported: outcome.unsupported.map((u) => ({
        resourceId: u.id,
        displayName: u.displayName,
        reason: u.reason,
      })),
    };
  }

  return { targets, compute, terraform };
}

export type MigrationEstimateService = ReturnType<typeof createMigrationEstimateService>;
