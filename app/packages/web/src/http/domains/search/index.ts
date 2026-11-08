/**
 * Search: `GET /api/org/:orgId/search`, the handler. The ranking and the
 * per-kind loaders live in `services/palette-search.ts`, shared with the
 * starred listing.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  SEARCH_RESULT_KINDS,
  isSearchResultKind,
  type SearchResultKind,
} from "@infrawrench/client-core";
import { badRequest, SearchApi, SearchHit } from "@infrawrench/api-contract";
import { legacySearch, searchPalette, searchableKinds } from "../../../services/palette-search";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";

/**
 * Parse `kinds=`: a comma list of `SearchResultKind`s, or `all`. Null for an
 * unknown name, which is a 400 rather than silently searching less than asked.
 */
export function parseSearchKinds(raw: string): SearchResultKind[] | null {
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 1 && parts[0] === "all") return [...SEARCH_RESULT_KINDS];
  const out: SearchResultKind[] = [];
  for (const p of parts) {
    if (!isSearchResultKind(p)) return null;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

const Hits = Schema.Array(SearchHit);

const SearchHandlers = HttpApiBuilder.group(SearchApi, "search", (handlers) =>
  handlers.handle("search", ({ query }) =>
    Effect.gen(function* () {
      const { organizationId, permissions } = yield* OrgPrincipal;
      const q = query.q ?? "";
      const rawKinds = query.kinds;

      // Without `kinds`: the original contract, which the editor extensions
      // and mobile still call.
      if (rawKinds === undefined) {
        yield* requirePermission("resources:read");
        const hits = yield* legacy(() => legacySearch(organizationId, q));
        return yield* respond(Hits)(hits);
      }

      // With it: each named kind the caller's role can read, narrowed to the
      // objects they could open. A kind the caller cannot read is skipped
      // rather than refused, so one request serves every role.
      const kinds = parseSearchKinds(rawKinds);
      if (!kinds) {
        return yield* badRequest(
          `Unknown kind in "${rawKinds}". Valid: all, ${SEARCH_RESULT_KINDS.join(", ")}.`,
        );
      }
      const allowed = searchableKinds(permissions, kinds);
      const hits = yield* legacy(() => searchPalette(organizationId, q, allowed));
      return yield* respond(Hits)(hits);
    }),
  ),
);

export const searchDomain = makeDomain("search", SearchApi, SearchHandlers);
