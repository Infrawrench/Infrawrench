import {
  searchQueryString,
  starPath,
  type SearchResult,
  type StarredItem,
  type StarredListResponse,
} from "@infrawrench/client-core";
import type { PaletteClient } from "@infrawrench/ui";
import { apiDelete, apiFetch, apiGet, apiPut } from "@/lib/api";

/**
 * The command palette's transport on web: the org's `/search` index (every
 * kind; the server skips the ones the caller cannot read) and their stars.
 */
export function createWebPaletteClient(orgId: string): PaletteClient {
  const base = `/api/org/${encodeURIComponent(orgId)}`;
  return {
    search: (query, signal) =>
      apiFetch<SearchResult[]>(`${base}/search?${searchQueryString(query, { kinds: "all" })}`, {
        signal,
      }),
    listStarred: async () => (await apiGet<StarredListResponse>(`${base}/starred`)).items,
    star: async (ref) => (await apiPut<{ item: StarredItem }>(`${base}${starPath(ref)}`)).item,
    unstar: async (ref) => {
      await apiDelete(`${base}${starPath(ref)}`);
    },
  };
}
