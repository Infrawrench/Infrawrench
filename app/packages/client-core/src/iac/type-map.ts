import type { ResourceInstance, TerraformExportCapability } from "@infrawrench/plugin-base";

/**
 * The **reverse** of the eject-to-Terraform mapping: given a Terraform
 * resource type (`aws_instance`), which plugin resource types could it be?
 *
 * There is deliberately no second hand-written table. Each plugin's
 * `terraformExport.mapResource` already encodes the plugin-type ↔
 * terraform-type correspondence, so this module *derives* the reverse by
 * calling those mappers with probe resources and reading back the block type
 * they emit. A plugin that gains export support gains reconciliation with it,
 * and the two directions cannot drift apart.
 *
 * Where the reverse cannot be derived — a mapper that returns `null` or throws
 * for every probe because it needs a field shape a probe can't fake — the
 * pair is reported in {@link TerraformTypeMapDerivation.underivable} with a
 * reason, and the UI says so rather than guessing. Matching still works for
 * those types in the inventory→state direction, because there we have the real
 * resource and can call the real mapper.
 */

export interface TerraformTypeMapping {
  pluginId: string;
  resourceTypeId: string;
}

export interface UnderivableTerraformType {
  pluginId: string;
  resourceTypeId: string;
  reason: string;
}

export interface TerraformTypeMapDerivation {
  /** Terraform type → every plugin resource type that maps onto it. */
  byTerraformType: Map<string, TerraformTypeMapping[]>;
  /** Plugin resource type → the Terraform types its mapper was seen to emit. */
  byResourceType: Map<string, string[]>;
  underivable: UnderivableTerraformType[];
}

export interface TerraformCapabilityEntry {
  pluginId: string;
  capability: TerraformExportCapability | undefined;
}

/**
 * Probe values, tried in order. A mapper typically bails with `null` when a
 * field it needs is absent, so a probe supplies *something* for every key it
 * asks for; the variants cover mappers that branch on a value (a numeric
 * field, a boolean flag, a JSON blob).
 */
const PROBE_VALUES = ["infrawrench-probe", "1", "true", "[]"] as const;

/**
 * A `fields` bag that answers every key. Enumeration stays empty on purpose:
 * a mapper that iterates the bag (tags, labels) should see nothing rather than
 * an infinite set of invented keys.
 */
function probeFields(value: string): Record<string, string | number | boolean> {
  return new Proxy(
    {},
    {
      get: (_target, key) => (typeof key === "string" ? value : undefined),
      has: () => true,
      ownKeys: () => [],
      getOwnPropertyDescriptor: () => undefined,
    },
  ) as Record<string, string | number | boolean>;
}

function probeResource(pluginId: string, resourceTypeId: string, value: string): ResourceInstance {
  return {
    id: "probe",
    pluginId,
    resourceTypeId,
    accountId: "probe",
    displayName: "infrawrench-probe",
    fields: probeFields(value),
    resolvedOutputs: probeFields(value) as unknown as Record<string, string>,
    secretStates: [],
    externalId: "infrawrench-probe",
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * Derive the Terraform-type → plugin-type map from the export capabilities.
 *
 * Pure: it calls only `mapResource`, which the capability contract already
 * guarantees is a function of stored state with no I/O.
 */
export function deriveTerraformTypeMap(
  entries: Iterable<TerraformCapabilityEntry>,
): TerraformTypeMapDerivation {
  const byTerraformType = new Map<string, TerraformTypeMapping[]>();
  const byResourceType = new Map<string, string[]>();
  const underivable: UnderivableTerraformType[] = [];

  for (const { pluginId, capability } of entries) {
    if (!capability) continue;
    for (const resourceTypeId of capability.supportedResourceTypeIds) {
      const seen: string[] = [];
      let lastFailure = "the mapper returned no block for any probe resource";
      for (const value of PROBE_VALUES) {
        let terraformType: string | undefined;
        try {
          const result = capability.mapResource(probeResource(pluginId, resourceTypeId, value));
          terraformType = result?.resource.type;
        } catch (e) {
          lastFailure = `the mapper threw for probe resources (${e instanceof Error ? e.message : "unknown error"})`;
          continue;
        }
        if (terraformType && !seen.includes(terraformType)) seen.push(terraformType);
      }
      if (seen.length === 0) {
        underivable.push({ pluginId, resourceTypeId, reason: lastFailure });
        continue;
      }
      byResourceType.set(`${pluginId}/${resourceTypeId}`, seen);
      for (const terraformType of seen) {
        const list = byTerraformType.get(terraformType);
        const mapping: TerraformTypeMapping = { pluginId, resourceTypeId };
        if (list) {
          if (!list.some((m) => m.pluginId === pluginId && m.resourceTypeId === resourceTypeId)) {
            list.push(mapping);
          }
        } else {
          byTerraformType.set(terraformType, [mapping]);
        }
      }
    }
  }

  return { byTerraformType, byResourceType, underivable };
}

/** Terraform types this plugin resource type is known to produce, `[]` when underivable. */
export function terraformTypesFor(
  derivation: TerraformTypeMapDerivation,
  pluginId: string,
  resourceTypeId: string,
): string[] {
  return derivation.byResourceType.get(`${pluginId}/${resourceTypeId}`) ?? [];
}
