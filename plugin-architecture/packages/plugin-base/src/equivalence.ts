/**
 * Cross-provider equivalence: what a resource *is*, independent of whose it
 * is, and which of its fields say how big it is.
 *
 * The migration estimate ("what would this service cost on provider X?")
 * reads two things off a resource type and nothing else:
 *
 * - `ResourceTypeDefinition.equivalence`: the category the type belongs to
 *   (a virtual machine, a managed Postgres, an object storage bucket). A
 *   resource is matched to the target provider's type of the same category.
 *   A type that hosts several engines (one "managed database" type for
 *   Postgres, MySQL and Redis) declares one rule per engine, each gated on a
 *   stored field, and names the create-form values that pick that engine.
 * - `FieldDefinition.sizing`: which of the type's fields carries each sizing
 *   dimension (the instance type, vCPUs, memory, disk, GPUs, node count, the
 *   region). On the source side the host reads them from the stored fields;
 *   on the target side it writes the matched values into the same-flagged
 *   create-form fields before asking the plugin for an estimate.
 *
 * Both are declarative data. The host knows no provider's field names: a new
 * plugin takes part by flagging its own fields, and a type without a category
 * is reported as having no equivalent rather than guessed at.
 */
import type { FieldDefinition, ResourceTypeDefinition } from "./resource.js";

/**
 * What kind of thing a resource is, across providers. Coarse on purpose: the
 * question is "which of the target's types would run this", not "is it the
 * same product".
 */
export type EquivalenceCategory =
  | "vm"
  | "kubernetes-cluster"
  | "kubernetes-node-pool"
  | "managed-postgres"
  | "managed-mysql"
  | "managed-redis"
  | "managed-mongodb"
  | "object-storage"
  | "block-volume"
  | "file-storage"
  | "load-balancer"
  | "container-app"
  | "serverless-function"
  | "container-registry"
  | "static-ip"
  | "dns-zone";

export const EQUIVALENCE_CATEGORIES: readonly EquivalenceCategory[] = [
  "vm",
  "kubernetes-cluster",
  "kubernetes-node-pool",
  "managed-postgres",
  "managed-mysql",
  "managed-redis",
  "managed-mongodb",
  "object-storage",
  "block-volume",
  "file-storage",
  "load-balancer",
  "container-app",
  "serverless-function",
  "container-registry",
  "static-ip",
  "dns-zone",
];

/**
 * Which sizing dimension a field carries.
 *
 * - `instance-type`: the provider's size id (`m7i.large`, `cx22`,
 *   `db-s-2vcpu-4gb`). The host resolves it to vCPUs and memory through the
 *   price catalog or the create form's size picker, so the field must hold
 *   the same ids the size picker offers.
 * - `vcpus`, `memory-gb`, `memory-mb`, `gpu-count`: the capacity itself, for
 *   types that store it directly rather than as a size id.
 * - `gpu-model`: the GPU's model name (`NVIDIA H100`).
 * - `disk-gb`, `disk-mb`: provisioned storage (a volume's size, a
 *   database's allocated storage).
 * - `node-count`: how many units the resource runs (nodes, replicas,
 *   instances). Absent means one.
 * - `region`: the provider location the resource runs in.
 */
export type SizingRole =
  | "instance-type"
  | "vcpus"
  | "memory-gb"
  | "memory-mb"
  | "gpu-count"
  | "gpu-model"
  | "disk-gb"
  | "disk-mb"
  | "node-count"
  | "region";

export const SIZING_ROLES: readonly SizingRole[] = [
  "instance-type",
  "vcpus",
  "memory-gb",
  "memory-mb",
  "gpu-count",
  "gpu-model",
  "disk-gb",
  "disk-mb",
  "node-count",
  "region",
];

/** One category a type belongs to, under a condition. */
export interface EquivalenceRule {
  category: EquivalenceCategory;
  /**
   * Applies only when this stored field matches: one of `oneOf` exactly
   * (case-insensitive), or starting with `prefix`. Absent = always.
   */
  when?: { fieldKey: string; oneOf?: string[]; prefix?: string };
  /**
   * Create-form values a resource of this category is created with on this
   * type, beyond the sizing fields: the engine a multi-engine database type
   * needs (`{ engine: "pg" }`). Written over the sized fields when the type
   * is a migration target.
   */
  createFields?: Record<string, string>;
}

/**
 * A type's equivalence: one category, or rules evaluated in order (first
 * match wins) for a type whose category depends on what it runs.
 */
export type EquivalenceDeclaration = EquivalenceCategory | EquivalenceRule[];

/** The declaration as a rule list. */
export function equivalenceRules(
  declaration: EquivalenceDeclaration | undefined,
): EquivalenceRule[] {
  if (!declaration) return [];
  return typeof declaration === "string" ? [{ category: declaration }] : declaration;
}

function ruleMatches(rule: EquivalenceRule, fields: Record<string, unknown> | undefined): boolean {
  if (!rule.when) return true;
  const raw = fields?.[rule.when.fieldKey];
  if (raw === undefined || raw === null || raw === "") return false;
  const value = String(raw).toLowerCase();
  if (rule.when.oneOf && rule.when.oneOf.some((v) => v.toLowerCase() === value)) return true;
  if (rule.when.prefix && value.startsWith(rule.when.prefix.toLowerCase())) return true;
  return false;
}

/**
 * The rule a stored resource falls under, or null when the type declares no
 * category or none of its conditions match this resource.
 */
export function resolveEquivalence(
  type: Pick<ResourceTypeDefinition, "equivalence">,
  fields: Record<string, unknown> | undefined,
): EquivalenceRule | null {
  for (const rule of equivalenceRules(type.equivalence)) {
    if (ruleMatches(rule, fields)) return rule;
  }
  return null;
}

/**
 * The rule a type offers for a category when it is the migration *target*:
 * the first rule of that category, whatever its condition, since the target
 * resource does not exist yet and its `createFields` say how to make it one.
 */
export function equivalenceRuleForCategory(
  type: Pick<ResourceTypeDefinition, "equivalence">,
  category: EquivalenceCategory,
): EquivalenceRule | null {
  return equivalenceRules(type.equivalence).find((r) => r.category === category) ?? null;
}

/** The categories a type can be, in declaration order, without duplicates. */
export function equivalenceCategories(
  type: Pick<ResourceTypeDefinition, "equivalence">,
): EquivalenceCategory[] {
  return [...new Set(equivalenceRules(type.equivalence).map((r) => r.category))];
}

/** Field key per sizing role, from the type's flagged fields (first flag wins). */
export function sizingFieldKeys(
  type: Pick<ResourceTypeDefinition, "fields">,
): Partial<Record<SizingRole, string>> {
  const out: Partial<Record<SizingRole, string>> = {};
  for (const field of type.fields as FieldDefinition[]) {
    if (field.sizing && out[field.sizing] === undefined) out[field.sizing] = field.key;
  }
  return out;
}

/** What a stored resource says about its size, read through its type's flags. */
export interface ResourceSizing {
  instanceType?: string;
  vcpus?: number;
  memoryGb?: number;
  gpuCount?: number;
  gpuModel?: string;
  diskGb?: number;
  /** Units the resource runs; absent when the type has no count field. */
  nodeCount?: number;
  region?: string;
}

function positiveNumber(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function nonEmptyString(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  return s.length > 0 ? s : undefined;
}

/**
 * Read a stored resource's sizing. A value that is missing or does not parse
 * is left out, never defaulted: an unknown size must stay unknown so the
 * match says so rather than pricing a guess.
 */
export function readResourceSizing(
  type: Pick<ResourceTypeDefinition, "fields">,
  fields: Record<string, unknown> | undefined,
): ResourceSizing {
  const keys = sizingFieldKeys(type);
  const get = (role: SizingRole) => {
    const key = keys[role];
    return key === undefined ? undefined : fields?.[key];
  };
  const out: ResourceSizing = {};
  const instanceType = nonEmptyString(get("instance-type"));
  if (instanceType) out.instanceType = instanceType;
  const vcpus = positiveNumber(get("vcpus"));
  if (vcpus !== undefined) out.vcpus = vcpus;
  const memoryGb = positiveNumber(get("memory-gb"));
  const memoryMb = positiveNumber(get("memory-mb"));
  if (memoryGb !== undefined) out.memoryGb = memoryGb;
  else if (memoryMb !== undefined) out.memoryGb = memoryMb / 1024;
  const gpuCount = positiveNumber(get("gpu-count"));
  if (gpuCount !== undefined) out.gpuCount = gpuCount;
  const gpuModel = nonEmptyString(get("gpu-model"));
  if (gpuModel) out.gpuModel = gpuModel;
  const diskGb = positiveNumber(get("disk-gb"));
  const diskMb = positiveNumber(get("disk-mb"));
  if (diskGb !== undefined) out.diskGb = diskGb;
  else if (diskMb !== undefined) out.diskGb = diskMb / 1024;
  const nodeCount = positiveNumber(get("node-count"));
  if (nodeCount !== undefined) out.nodeCount = nodeCount;
  const region = nonEmptyString(get("region"));
  if (region) out.region = region;
  return out;
}

/**
 * The create-form fields that make the target type into the matched
 * configuration: each sizing value written into the target's field flagged
 * with the same role, then the rule's `createFields` over them. Roles the
 * target has no field for are dropped; a value the source does not know is
 * never invented.
 */
export function buildTargetFields(
  type: Pick<ResourceTypeDefinition, "fields">,
  rule: EquivalenceRule | null,
  values: ResourceSizing,
): Record<string, string> {
  const keys = sizingFieldKeys(type);
  const out: Record<string, string> = {};
  const put = (role: SizingRole, value: string | number | undefined) => {
    const key = keys[role];
    if (key === undefined || value === undefined) return;
    out[key] = String(value);
  };
  put("region", values.region);
  put("instance-type", values.instanceType);
  put("vcpus", values.vcpus);
  if (keys["memory-gb"]) put("memory-gb", values.memoryGb);
  else if (values.memoryGb !== undefined) put("memory-mb", Math.round(values.memoryGb * 1024));
  put("gpu-count", values.gpuCount);
  put("gpu-model", values.gpuModel);
  if (keys["disk-gb"]) put("disk-gb", values.diskGb);
  else if (values.diskGb !== undefined) put("disk-mb", Math.round(values.diskGb * 1024));
  put("node-count", values.nodeCount);
  return { ...out, ...(rule?.createFields ?? {}) };
}
