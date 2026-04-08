import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * Returns resource types to show on the account page.
 * Only top-level types (no parentTypeId) are shown — child types appear
 * nested under their parent on the resource detail page instead.
 */
export function getAccountResourceTypes(
  resourceTypes: ResourceTypeDefinition[],
): ResourceTypeDefinition[] {
  return resourceTypes.filter((typeDef) => !typeDef.parentTypeId);
}
