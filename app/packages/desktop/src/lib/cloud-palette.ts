/**
 * The command palette's cloud transport on desktop: typed calls to the
 * contract's `search` and `starred` domains over the cloud transport
 * (`./cloud-client.ts`). Search asks for saved-object kinds only; resources
 * and workflows come from the local cache, as the spotlight's always did.
 */
import { SEARCH_OBJECT_KINDS, type SearchResult } from "@infrawrench/client-core";
import type { PaletteClient } from "@infrawrench/ui";
import { Effect } from "effect";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const starred = () => cloudClient("starred").starred;

export function createDesktopPaletteClient(orgId: string): PaletteClient {
  return {
    // Transport calls cannot be aborted; the palette ignores superseded answers.
    search: (query): Promise<SearchResult[]> =>
      runRpc(
        cloudClient("search").search.search({
          params: { orgId },
          query: { q: query.trim(), kinds: SEARCH_OBJECT_KINDS.join(",") },
        }),
      ),
    listStarred: () =>
      runRpc(
        starred()
          .list({ params: { orgId } })
          .pipe(Effect.map((res) => res.items)),
      ),
    star: (ref) =>
      runRpc(
        starred()
          .star({ params: { orgId, kind: ref.kind, objectId: ref.id } })
          .pipe(Effect.map((res) => res.item)),
      ),
    unstar: (ref) =>
      runRpc(starred().unstar({ params: { orgId, kind: ref.kind, objectId: ref.id } })).then(
        () => undefined,
      ),
  };
}
