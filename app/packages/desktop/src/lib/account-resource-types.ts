import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * Returns resource types to show on the account page.
 * Top-level types show their full resource list + create button.
 * Child types with supportsCreate show only the create button (no resource
 * listing — those appear nested under their parent on the detail page).
 */
export function getAccountResourceTypes(
  resourceTypes: ResourceTypeDefinition[],
): ResourceTypeDefinition[] {
  return resourceTypes.filter(
    (typeDef) => !typeDef.parentTypeId || typeDef.supportsCreate,
  );
}

/** Returns only top-level resource types (no parent) whose resources should be listed. */
export function getListableResourceTypes(
  resourceTypes: ResourceTypeDefinition[],
): ResourceTypeDefinition[] {
  return resourceTypes.filter((typeDef) => !typeDef.parentTypeId);
}

/** Whether a type should hide its resource list on the account page */
export function isCreateOnlyType(typeDef: ResourceTypeDefinition): boolean {
  return !!typeDef.parentTypeId && !!typeDef.supportsCreate;
}
