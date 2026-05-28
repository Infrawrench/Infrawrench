import type { ReactNode } from "react";

/** Minimal resource-type shape needed by the section tabs. */
export interface SectionTypeDef {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  parentTypeId?: string | undefined;
  supportsCreate?: boolean | undefined;
  /** Child types opt in here to surface in the sidebar/account view alongside top-level types. */
  showInSidebar?: boolean | undefined;
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
