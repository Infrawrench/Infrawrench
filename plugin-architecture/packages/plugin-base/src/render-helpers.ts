import type { ResourceTypeDefinition } from "./resource.js";
import type { KVItem } from "./schema.js";

/**
 * Convert a camelCase or kebab-case key to a human-readable title.
 * Examples: "instanceId" → "Instance ID", "publicIp" → "Public IP",
 * "ec2-instance" → "EC2 Instance"
 */
export function camelToTitle(key: string): string {
  if (key.includes("-")) {
    return key
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\b(id|ip|url|uri|dns|ssl|tls|cpu|ram|vpc|arn|ami)\b/gi, (m) => m.toUpperCase())
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Build labeled KVItems for a resource's fields using labels from the type definition.
 * Falls back to camelToTitle for keys not found in the definition.
 */
export function labeledFieldItems(
  fields: Record<string, string | number | boolean>,
  resourceTypes: ResourceTypeDefinition[],
  resourceTypeId: string,
): KVItem[] {
  const typeDef = resourceTypes.find((rt) => rt.id === resourceTypeId);
  const labelMap = new Map(typeDef?.fields.map((f) => [f.key, f.label]) ?? []);
  return Object.entries(fields)
    .filter(([, v]) => v !== "" && v !== undefined)
    .map(([key, value]) => ({
      key: labelMap.get(key) ?? camelToTitle(key),
      value: String(value),
    }));
}

/**
 * Build labeled KVItems for a resource's resolved outputs using labels from the type definition.
 * Falls back to camelToTitle for keys not found in the definition.
 */
export function labeledOutputItems(
  resolvedOutputs: Record<string, string>,
  resourceTypes: ResourceTypeDefinition[],
  resourceTypeId: string,
): KVItem[] {
  const typeDef = resourceTypes.find((rt) => rt.id === resourceTypeId);
  const labelMap = new Map(typeDef?.outputs.map((o) => [o.key, o.label]) ?? []);
  const hiddenKeys = new Set(
    typeDef?.outputs.filter((o) => o.hidden === true).map((o) => o.key) ?? [],
  );
  return Object.entries(resolvedOutputs)
    .filter(([key]) => !hiddenKeys.has(key))
    .map(([key, value]) => ({
      key: labelMap.get(key) ?? camelToTitle(key),
      value: String(value),
      copyable: true,
    }));
}

/** The separator a detail subtitle joins its parts with, app-wide. */
const SUBTITLE_SEPARATOR = " · ";

/**
 * Join the parts of a detail subtitle, dropping the ones that are not there.
 *
 * Almost every plugin builds its subtitle as "type name, then where it lives"
 * — and writes it as a template literal with a `?? ""` on the tail. That reads
 * fine until a resource type does not carry the field: a DigitalOcean project
 * has no region, so `${typeName} · ${fields.region ?? ""}` renders as
 * "Project ·", a separator pointing at nothing. The same shape appears for a
 * Postgres role with no database, a Vercel resource with no slug, and a Fly
 * app with no region, so the fix belongs here rather than at each call site.
 *
 * Empty and whitespace-only parts are dropped, as are `null` and `undefined`,
 * which is what lets a caller pass `fields["region"]` straight in. `0` and
 * `false` are kept — they are values a field can legitimately hold, and a
 * subtitle that silently omits "0 replicas" is a different kind of wrong.
 *
 * Returns `""` when nothing survives; `DetailViewSchema.subtitle` is optional
 * and the renderers all guard on truthiness, so an empty string draws no line
 * at all rather than an empty one.
 */
export function joinSubtitle(
  ...parts: Array<string | number | boolean | null | undefined>
): string {
  return parts
    .map((part) => (part === null || part === undefined ? "" : String(part).trim()))
    .filter((part) => part !== "")
    .join(SUBTITLE_SEPARATOR);
}

/**
 * Look up a resource type's displayName by its ID.
 * Falls back to camelToTitle of the ID if not found.
 */
export function resourceTypeDisplayName(
  resourceTypes: ResourceTypeDefinition[],
  resourceTypeId: string,
): string {
  return (
    resourceTypes.find((rt) => rt.id === resourceTypeId)?.displayName ??
    camelToTitle(resourceTypeId)
  );
}
