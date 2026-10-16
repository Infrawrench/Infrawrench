/**
 * The command palette's cloud transport on desktop: one wrapper per
 * allowlisted `cloud_palette_*` IPC channel (`electron/cloud-data/palette.ts`).
 * The search channel asks for saved-object kinds only; resources and
 * workflows come from the local cache, as the spotlight's always did.
 */
import type { SearchResult, StarredItem, StarredListResponse } from "@infrawrench/client-core";
import type { PaletteClient } from "@infrawrench/ui";
import { invoke } from "./invoke";

export function createDesktopPaletteClient(orgId: string): PaletteClient {
  return {
    // IPC calls cannot be aborted; the palette ignores superseded answers.
    search: (query) => invoke<SearchResult[]>("cloud_palette_search", { orgId, query }),
    listStarred: async () =>
      (await invoke<StarredListResponse>("cloud_palette_starred_list", { orgId }))?.items ?? [],
    star: async (ref) =>
      (
        await invoke<{ item: StarredItem } | null>("cloud_palette_star", {
          orgId,
          kind: ref.kind,
          id: ref.id,
        })
      )?.item ?? null,
    unstar: async (ref) => {
      await invoke("cloud_palette_unstar", { orgId, kind: ref.kind, id: ref.id });
    },
  };
}
