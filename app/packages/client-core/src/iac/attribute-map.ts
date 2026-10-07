import type { ResourceInstance, TerraformExportCapability } from "@infrawrench/plugin-base";

/**
 * Terraform attribute → create-form field key, for one plugin resource type.
 *
 * The same trick as the type map (`type-map.ts`), one level down: each
 * plugin's `terraformExport.mapResource` already says which stored field
 * becomes which Terraform attribute, so the reverse is *derived* by calling
 * it with probe fields whose values name their own key and reading back which
 * attribute each value landed in. No second table; a plugin whose mapper
 * gains an attribute gains it here too.
 *
 * Two passes, because mappers read fields two ways: as strings (an instance
 * type, a region) and as numbers (a disk size, a node count). The string pass
 * hands every key `iwprobe-<key>`; the number pass hands every key its own
 * integer. A value a mapper transforms (lowercases, parses into a list, wraps
 * in a map) does not round-trip and so maps nothing, which is the honest
 * answer: the reverse direction cannot be read off such an attribute.
 *
 * Used by pull request checks to turn a Terraform block in a diff into the
 * fields `estimateCost` (and the posture rules) are keyed by.
 */

export interface TerraformAttributeFieldMap {
  /** Terraform attribute → field key, for attributes that round-trip. */
  fieldByAttribute: Map<string, string>;
  /** Every attribute the mapper was seen to emit, round-tripping or not. */
  attributes: Set<string>;
}

const STRING_PREFIX = "iwprobe-";
const NUMBER_BASE = 900_001;

function probeBag(valueFor: (key: string) => string): Record<string, string> {
  return new Proxy(
    {},
    {
      get: (_target, key) => (typeof key === "string" ? valueFor(key) : undefined),
      has: () => true,
      ownKeys: () => [],
      getOwnPropertyDescriptor: () => undefined,
    },
  ) as Record<string, string>;
}

function probeInstance(
  pluginId: string,
  resourceTypeId: string,
  fields: Record<string, string>,
): ResourceInstance {
  return {
    id: "probe",
    pluginId,
    resourceTypeId,
    accountId: "probe",
    displayName: "infrawrench-probe",
    fields,
    // Outputs answer with a value no field token can collide with.
    resolvedOutputs: probeBag(() => "iwoutput-probe"),
    secretStates: [],
    externalId: "infrawrench-probe",
    createdAt: "",
    updatedAt: "",
  };
}

/** Derive the attribute → field map. Pure: `mapResource` does no I/O. */
export function deriveTerraformAttributeFieldMap(
  capability: TerraformExportCapability | undefined,
  pluginId: string,
  resourceTypeId: string,
): TerraformAttributeFieldMap {
  const fieldByAttribute = new Map<string, string>();
  const attributes = new Set<string>();
  if (!capability || !capability.supportedResourceTypeIds.includes(resourceTypeId)) {
    return { fieldByAttribute, attributes };
  }

  const run = (fields: Record<string, string>) => {
    try {
      return capability.mapResource(probeInstance(pluginId, resourceTypeId, fields));
    } catch {
      return null;
    }
  };

  // String pass. A string attribute that came back as anything other than
  // an exact token was transformed on the way (`toUpperCase`, a prefix), so
  // it is remembered and kept out of the number pass too: digits survive
  // most string transforms unchanged and would otherwise read as a match.
  const transformed = new Set<string>();
  const stringResult = run(probeBag((key) => `${STRING_PREFIX}${key}`));
  if (stringResult) {
    for (const [attr, value] of Object.entries(stringResult.resource.attributes)) {
      attributes.add(attr);
      if (value.kind !== "string") continue;
      const key = value.value.startsWith(STRING_PREFIX)
        ? value.value.slice(STRING_PREFIX.length)
        : null;
      if (key && /^[A-Za-z0-9_.-]+$/.test(key)) fieldByAttribute.set(attr, key);
      else transformed.add(attr);
    }
  }

  // Number pass: each key gets its own integer, assigned on first read.
  const numberByKey = new Map<string, number>();
  const keyByNumber = new Map<number, string>();
  const numberResult = run(
    probeBag((key) => {
      let n = numberByKey.get(key);
      if (n === undefined) {
        n = NUMBER_BASE + numberByKey.size;
        numberByKey.set(key, n);
        keyByNumber.set(n, key);
      }
      return String(n);
    }),
  );
  if (numberResult) {
    for (const [attr, value] of Object.entries(numberResult.resource.attributes)) {
      attributes.add(attr);
      if (fieldByAttribute.has(attr) || transformed.has(attr)) continue;
      const n =
        value.kind === "number"
          ? value.value
          : value.kind === "string" && /^\d+$/.test(value.value)
            ? Number(value.value)
            : null;
      const key = n === null ? undefined : keyByNumber.get(n);
      if (key) fieldByAttribute.set(attr, key);
    }
  }

  return { fieldByAttribute, attributes };
}

/** A literal Terraform value as a create-form string, or null for anything else. */
export type TerraformLiteral = string | number | boolean;

/**
 * Project literal Terraform attributes onto create-form fields through a
 * derived map. Attributes that do not round-trip are dropped, never guessed.
 */
export function terraformAttributesToFields(
  map: TerraformAttributeFieldMap,
  attributes: Record<string, TerraformLiteral>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [attr, value] of Object.entries(attributes)) {
    const key = map.fieldByAttribute.get(attr);
    if (key) out[key] = String(value);
  }
  return out;
}
