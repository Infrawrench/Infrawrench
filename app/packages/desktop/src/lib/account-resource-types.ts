import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * Returns resource types to show on the account page.
 * Includes all top-level types, plus child types that support create
 * so users get a direct "+ Create" button without navigating into the parent first.
 */
export function getAccountResourceTypes(
  resourceTypes: ResourceTypeDefinition[],
): ResourceTypeDefinition[] {
  return resourceTypes.filter(
    (typeDef) => !typeDef.parentTypeId || typeDef.supportsCreate,
  );
}
