import { z } from "../zod";
import { strict, OrgIdParam, Uuid, ResourceId } from "../common";
import type { BuildContext } from "../context";

const SearchHit = strict({
  id: ResourceId,
  pluginId: z.string(),
  pluginDisplayName: z.string(),
  pluginLogoSvg: z.string(),
  resourceTypeId: z.string(),
  resourceTypeLabel: z.string(),
  accountId: Uuid,
  accountName: z.string(),
  displayName: z.string(),
}).openapi("SearchHit");

export function registerSearchPaths(ctx: BuildContext) {
  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/search",
    tags: ["Search"],
    summary: "Search resources across all accounts (capped at 50 hits)",
    request: {
      params: OrgIdParam,
      query: strict({
        q: z
          .string()
          .optional()
          .openapi({ param: { name: "q", in: "query" } }),
      }),
    },
    responses: {
      200: { description: "Hits", content: { "application/json": { schema: z.array(SearchHit) } } },
    },
  });
}
