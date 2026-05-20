import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** Minimal resource-type shape needed by the section tabs. */
export interface SectionTypeDef {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  parentTypeId?: string | undefined;
  supportsCreate?: boolean | undefined;
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
      // When not searching, hide child resource types — they appear under their parent detail page
      if (normalizedQuery.length === 0 && cat.typeDef.parentTypeId) return false;
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

export interface AccountResourceSectionsProps<T extends SectionTypeDef, R extends SectionResource> {
  categories: SectionCategoryState<T, R>[];
  /** Render a single resource pill/item. */
  renderResource: (resource: R, category: SectionCategoryState<T, R>) => ReactNode;
  /** Render an optional "Create" button inside a category. Return null to skip. */
  renderCreateButton?: (typeDef: T) => ReactNode;
  /** Controlled search query — if provided, the component uses this instead of internal state. */
  searchQuery?: string | undefined;
  /** Called when the search query changes (only when searchQuery prop is provided). */
  onSearchQueryChange?: ((query: string) => void) | undefined;
  /** Controlled active section id — if provided, the component uses this instead of internal state. */
  activeSectionId?: string | null | undefined;
  /** Called when the active section changes (only when activeSectionId prop is provided). */
  onActiveSectionIdChange?: ((id: string | null) => void) | undefined;
}

export function AccountResourceSections<T extends SectionTypeDef, R extends SectionResource>({
  categories,
  renderResource,
  renderCreateButton,
  searchQuery: controlledSearchQuery,
  onSearchQueryChange,
  activeSectionId: controlledActiveSectionId,
  onActiveSectionIdChange,
}: AccountResourceSectionsProps<T, R>) {
  const [internalSearchQuery, setInternalSearchQuery] = useState("");
  const [internalActiveSectionId, setInternalActiveSectionId] = useState<string | null>(null);
  const initializedSectionRef = useRef(false);

  const isSearchControlled = controlledSearchQuery !== undefined;
  const isSectionControlled = controlledActiveSectionId !== undefined;

  const searchQuery = isSearchControlled ? controlledSearchQuery : internalSearchQuery;
  const setSearchQuery = isSearchControlled
    ? (v: string) => onSearchQueryChange?.(v)
    : setInternalSearchQuery;

  const activeSectionId = isSectionControlled ? controlledActiveSectionId : internalActiveSectionId;
  const setActiveSectionId = isSectionControlled
    ? (v: string | null) => onActiveSectionIdChange?.(v)
    : setInternalActiveSectionId;

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const visibleCategories = useMemo(
    () => getVisibleAccountCategories(categories, normalizedQuery),
    [categories, normalizedQuery],
  );

  useEffect(() => {
    if (visibleCategories.length === 0) {
      if (activeSectionId !== null) setActiveSectionId(null);
      initializedSectionRef.current = false;
      return;
    }

    // If the current section is valid, just mark as initialized and bail
    if (activeSectionId && visibleCategories.some((cat) => cat.typeDef.id === activeSectionId)) {
      initializedSectionRef.current = true;
      return;
    }

    if (!initializedSectionRef.current) {
      const defaultId = pickDefaultAccountSectionId(visibleCategories);
      setActiveSectionId(defaultId);
      initializedSectionRef.current = true;
      return;
    }

    // Active section no longer visible — fall back to default
    setActiveSectionId(pickDefaultAccountSectionId(visibleCategories));
  }, [activeSectionId, visibleCategories]);

  const activeCategory =
    visibleCategories.find((cat) => cat.typeDef.id === activeSectionId) ?? null;

  return (
    <>
      {/* Search + tab bar */}
      <div className="mb-6 space-y-3">
        <input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search sections or resources..."
          className="w-full md:max-w-sm bg-surface-raised border border-border rounded-md px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-muted focus:outline-none focus:border-blue-500"
        />
        {visibleCategories.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {visibleCategories.map((cat) => (
              <button
                key={cat.typeDef.id}
                onClick={() => setActiveSectionId(cat.typeDef.id)}
                className={`px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors ${
                  activeSectionId === cat.typeDef.id
                    ? "border-blue-500 bg-accent-muted text-accent-on-muted"
                    : "border-border text-on-surface-tertiary hover:border-border-strong hover:text-on-surface-secondary"
                }`}
              >
                {cat.typeDef.pluralDisplayName}
                {cat.resources.length > 0 && (
                  <span className="ml-1 text-[11px] text-on-surface-muted">
                    ({cat.resources.length})
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Active section content */}
      {activeCategory && (
        <div key={activeCategory.typeDef.id} className="mb-8">
          <h2 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide mb-3">
            {activeCategory.typeDef.pluralDisplayName}
          </h2>

          {activeCategory.loading ? (
            <div className="flex flex-wrap gap-2">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-8 rounded-full bg-surface-overlay animate-pulse"
                  style={{ width: `${5 + i * 1.5}rem` }}
                />
              ))}
            </div>
          ) : activeCategory.error ? (
            <div className="text-xs text-red-400">{activeCategory.error}</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {activeCategory.resources.map((resource) => renderResource(resource, activeCategory))}
              {activeCategory.typeDef.supportsCreate &&
                renderCreateButton?.(activeCategory.typeDef)}
            </div>
          )}
        </div>
      )}

      {/* Empty states */}
      {visibleCategories.length === 0 &&
        categories.length > 0 &&
        categories.every(
          (c) => !c.loading && c.resources.length === 0 && !c.typeDef.supportsCreate,
        ) && (
          <div className="text-center py-12">
            <p className="text-on-surface-muted text-sm">No resources synced yet.</p>
            <p className="text-on-surface-faint text-xs mt-1">
              Resources will appear after the first sync.
            </p>
          </div>
        )}

      {visibleCategories.length === 0 && normalizedQuery.length > 0 && (
        <div className="py-8">
          <p className="text-sm text-on-surface-muted">
            No sections or resources match &ldquo;{searchQuery.trim()}&rdquo;.
          </p>
        </div>
      )}
    </>
  );
}
