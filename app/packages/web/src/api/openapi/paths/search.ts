import { z } from "../zod";
import { strict, OrgIdParam, ResourceId } from "../common";
import type { BuildContext } from "../context";

const SearchHit = strict({
  id: ResourceId,
  pluginId: z.string(),
  pluginDisplayName: z.string(),
  pluginLogoSvg: z.string(),
  resourceTypeId: z.string(),
  resourceTypeLabel: z.string(),
  // Empty for non-resource hits (e.g. workflows, which use resourceTypeId "__workflow__").
  accountId: z.string(),
  accountName: z.string(),
  displayName: z.string(),
  subtitle: z.string().optional(),
}).openapi("SearchHit");

export function registerSearchPaths(ctx: BuildContext) {
  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/search",
    tags: ["Search"],
    summary: "Search resources (capped at 50 hits) and workflows across the org",
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
