import { Hono } from "hono";
import {
  SEARCH_RESULT_KINDS,
  isSearchResultKind,
  type SearchResultKind,
} from "@infrawrench/client-core";
import { requirePermission } from "../../auth/permissions";
import { legacySearch, searchPalette, searchableKinds } from "../../services/palette-search";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

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

/**
 * GET /api/org/:orgId/search?q=…[&kinds=…]
 *
 * Without `kinds` this is the original contract (resources and workflows,
 * `resources:read`), which the editor extensions and mobile still call. With
 * it, the command palette's index: each named kind the caller's role can read,
 * narrowed to the objects they could open, fuzzy-ranked. A kind the caller
 * cannot read is skipped rather than refused, so one request serves every
 * role.
 */
app.get("/", async (c) => {
  const organizationId = c.get("organizationId");
  const q = c.req.query("q") ?? "";
  const rawKinds = c.req.query("kinds");

  if (rawKinds === undefined) {
    requirePermission(c, "resources:read");
    return c.json(await legacySearch(organizationId, q));
  }

  const kinds = parseSearchKinds(rawKinds);
  if (!kinds) {
    return c.json(
      { error: `Unknown kind in "${rawKinds}". Valid: all, ${SEARCH_RESULT_KINDS.join(", ")}.` },
      400,
    );
  }
  const allowed = searchableKinds(c.get("permissions") ?? [], kinds);
  return c.json(await searchPalette(organizationId, q, allowed));
});

export { app as searchRoutes };
