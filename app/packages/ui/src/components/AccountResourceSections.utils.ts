import type {
  SectionCategoryState,
  SectionResource,
  SectionTypeDef,
} from "./AccountResourceSections.js";

/** Returns the search-relevant fields object from a resource (supports both web and desktop shapes). */
function getFields(resource: SectionResource): Record<string, unknown> {
  if (resource.fields && typeof resource.fields === "object") return resource.fields;
  if (resource.fieldsJson && typeof resource.fieldsJson === "object") return resource.fieldsJson;
  return {};
}

export function getVisibleAccountCategories<T extends SectionTypeDef, R extends SectionResource>(
  categories: SectionCategoryState<T, R>[],
  normalizedQuery: string,
): SectionCategoryState<T, R>[] {
  return categories
    .filter((cat) => {
      // When not searching, hide child resource types — they appear under their parent detail page.
      // Exception: types that opted in via `showInSidebar` stay visible as their own section.
      if (normalizedQuery.length === 0 && cat.typeDef.parentTypeId && !cat.typeDef.showInSidebar)
        return false;
      if (!cat.loading && cat.resources.length === 0 && !cat.typeDef.supportsCreate) return false;
      return true;
    })
    .map((cat) => {
      const filteredResources =
        normalizedQuery.length === 0
          ? cat.resources
          : cat.resources.filter((resource) => {
              const fields = getFields(resource);
              const searchText = [
                cat.typeDef.displayName,
                cat.typeDef.pluralDisplayName,
                resource.displayName,
                String(fields["host"] ?? ""),
                String(fields["region"] ?? ""),
                String(fields["engine"] ?? ""),
              ]
                .join(" ")
                .toLowerCase();
              return searchText.includes(normalizedQuery);
            });
      const sectionMatches = [
        cat.typeDef.displayName,
        cat.typeDef.pluralDisplayName,
        cat.typeDef.id,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);

      if (normalizedQuery.length > 0 && filteredResources.length === 0 && !sectionMatches) {
        return null;
      }

      return {
        ...cat,
        resources: filteredResources,
      };
    })
    .filter((cat): cat is SectionCategoryState<T, R> => cat !== null)
    .sort((a, b) => a.typeDef.pluralDisplayName.localeCompare(b.typeDef.pluralDisplayName));
}

export function pickDefaultAccountSectionId<T extends SectionTypeDef, R extends SectionResource>(
  categories: SectionCategoryState<T, R>[],
): string | null {
  const fallbackSectionId = categories[0]?.typeDef.id ?? null;
  const firstWithItems = categories.find((cat) => cat.resources.length > 0);
  return firstWithItems?.typeDef.id ?? fallbackSectionId;
}
