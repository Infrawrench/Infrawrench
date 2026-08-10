/**
 * Account-page section grouping, shared by web, desktop, and mobile.
 *
 * An account page is the full inventory of one account: every resource type
 * the plugin exposes gets its own section, child types included. Parentage
 * deliberately plays no part here — `showInSidebar` scopes the *sidebar*
 * (`getListableResourceTypes`, `?topLevelOnly=true`), and keying section
 * visibility off it once made the account page show a different set of
 * sections empty-query versus searching.
 */

/** Minimal resource-type shape needed to render a section. */
export interface SectionTypeDef {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  supportsCreate?: boolean | undefined;
}

/** Minimal resource-type shape needed to resolve the account root. */
export interface RootTypeDef {
  id: string;
  parentTypeId?: string | undefined;
  accountRoot?: boolean | undefined;
}

/**
 * The plugin's account-root type, if it declares one — the singleton that *is*
 * the account. See `ResourceTypeDefinition.accountRoot`.
 *
 * Shared by web, desktop, and mobile so all three agree on what an account
 * opens to. Only a top-level type qualifies: a root nested under a parent
 * would make the account open to something that is itself inside something
 * else, and `plugin-loader.test.ts` rejects that at build time — but hosts
 * check here too rather than trusting a serialized flag from the wire.
 *
 * Returns the *first* match. A plugin declaring two is a bug the loader test
 * catches; picking one deterministically beats throwing inside a render path.
 */
export function getAccountRootType<T extends RootTypeDef>(resourceTypes: T[]): T | null {
  return resourceTypes.find((typeDef) => typeDef.accountRoot && !typeDef.parentTypeId) ?? null;
}

/** Minimal resource shape needed for search filtering. */
export interface SectionResource {
  id: string;
  displayName: string;
  fieldsJson?: Record<string, unknown> | null;
  fields?: Record<string, unknown>;
}

export interface SectionCategoryState<T extends SectionTypeDef, R extends SectionResource> {
  typeDef: T;
  loading: boolean;
  error: string | null;
  resources: R[];
}

/** Returns the search-relevant fields object from a resource (web and desktop shapes differ). */
function getFields(resource: SectionResource): Record<string, unknown> {
  if (resource.fields && typeof resource.fields === "object") return resource.fields;
  if (resource.fieldsJson && typeof resource.fieldsJson === "object") return resource.fieldsJson;
  return {};
}

/**
 * Filters and orders the sections shown on an account page.
 *
 * A section survives when it still has resources after filtering, or when the
 * query matches its own name/id, or when it offers a create button. The same
 * rule runs whether or not there is a query, so searching only ever removes
 * sections — it never reveals ones that were hidden.
 */
export function getVisibleAccountCategories<T extends SectionTypeDef, R extends SectionResource>(
  categories: SectionCategoryState<T, R>[],
  normalizedQuery: string,
): SectionCategoryState<T, R>[] {
  return categories
    .map((cat) => {
      if (!cat.loading && cat.resources.length === 0 && !cat.typeDef.supportsCreate) return null;
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

/** Picks the section to open by default — the first with resources, else the first at all. */
export function pickDefaultAccountSectionId<T extends SectionTypeDef, R extends SectionResource>(
  categories: SectionCategoryState<T, R>[],
): string | null {
  const fallbackSectionId = categories[0]?.typeDef.id ?? null;
  const firstWithItems = categories.find((cat) => cat.resources.length > 0);
  return firstWithItems?.typeDef.id ?? fallbackSectionId;
}
