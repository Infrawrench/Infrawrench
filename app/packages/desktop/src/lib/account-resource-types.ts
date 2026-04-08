import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export function getAccountResourceTypes(
  resourceTypes: ResourceTypeDefinition[],
): ResourceTypeDefinition[] {
  return resourceTypes.filter((typeDef) => !typeDef.parentTypeId);
}
