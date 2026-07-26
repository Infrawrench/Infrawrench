import type { ReactNode } from "react";

/**
 * The section shapes live in `@infrawrench/client-core` alongside the filter
 * rule that consumes them, so mobile shares both. Re-exported here to keep the
 * historical `@infrawrench/ui` import paths working.
 *
 * Note none of them carry `parentTypeId`/`showInSidebar`: the account page
 * lists every type, so parentage does not affect section visibility. Those
 * fields scope the sidebar (`getListableResourceTypes`, `?topLevelOnly=true`).
 */
export type {
  SectionTypeDef,
  SectionResource,
  SectionCategoryState,
} from "@infrawrench/client-core";

import type {
  SectionCategoryState,
  SectionResource,
  SectionTypeDef,
} from "@infrawrench/client-core";

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
