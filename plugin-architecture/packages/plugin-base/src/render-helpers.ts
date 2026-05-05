import type { ResourceTypeDefinition } from "./resource.js";
import type { KVItem } from "./schema.js";

/**
 * Convert a camelCase or kebab-case key to a human-readable title.
 * Examples: "instanceId" → "Instance ID", "publicIp" → "Public IP",
 * "ec2-instance" → "EC2 Instance"
 */
export function camelToTitle(key: string): string {
  // Handle kebab-case first
  if (key.includes("-")) {
    return key
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  // Handle camelCase
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
  return Object.entries(resolvedOutputs).map(([key, value]) => ({
    key: labelMap.get(key) ?? camelToTitle(key),
    value: String(value),
    copyable: true,
  }));
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
