import { SEARCH_OBJECT_KINDS, SEARCH_RESULT_KINDS } from "@infrawrench/client-core";
import { z } from "../zod";
import { strict, ErrorResponses, IsoDateTime, Ok, OrgIdParam, ResourceId } from "../common";
import type { BuildContext } from "../context";

const SearchResultKind = z.enum(SEARCH_RESULT_KINDS).openapi("SearchResultKind", {
  description:
    "What a search hit is. `resource` and `workflow` are the original kinds; the rest are " +
    "saved objects (" +
    SEARCH_OBJECT_KINDS.join(", ") +
    "), returned only when asked for with `kinds`.",
});

const SearchHitShape = {
  id: ResourceId,
  kind: SearchResultKind.optional().describe(
    "Present on every hit. Optional only so that clients generated before it existed keep " +
      "validating.",
  ),
  pluginId: z
    .string()
    .describe(
      "The provider plugin; `__workflows__` for workflows, `__objects__` for saved objects.",
    ),
  pluginDisplayName: z.string(),
  pluginLogoSvg: z.string().describe("Inline SVG markup; empty for saved objects."),
  resourceTypeId: z
    .string()
    .describe("The resource type; `__workflow__` for workflows, the kind for saved objects."),
  resourceTypeLabel: z.string(),
  // Empty for non-resource hits (workflows and saved objects).
  accountId: z.string(),
  accountName: z.string(),
  displayName: z.string(),
  subtitle: z.string().optional(),
};

const SearchHit = strict(SearchHitShape).openapi("SearchHit");

const StarredItem = strict({
  ...SearchHitShape,
  kind: SearchResultKind,
  starredAt: IsoDateTime,
}).openapi("StarredItem");

const StarParams = OrgIdParam.extend({
  kind: SearchResultKind.openapi({ param: { name: "kind", in: "path" } }),
  objectId: z
    .string()
    .min(1)
    .max(512)
    .openapi({ param: { name: "objectId", in: "path" } }),
});

export function registerSearchPaths(ctx: BuildContext) {
  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/search",
    tags: ["Search"],
    summary: "Search resources, workflows and (with `kinds`) saved objects across the org",
    description:
      "Without `kinds`: resources (capped at 50, substring match over name, account, provider " +
      "and type) and workflows; requires `resources:read`. With `kinds`: the command palette's " +
      "index. Each named kind the caller's role can read is searched (a kind it cannot read is " +
      "skipped, not refused), narrowed to the objects the caller could open (per-object sharing " +
      "for cost reports, folders, dashboards and canvases; cost visibility for budgets), and " +
      "fuzzy-ranked: every whitespace-separated token must match the name or a supporting label, " +
      "as a substring or an in-order subsequence. At most 8 hits per saved-object kind and 50 " +
      "resources; kinds are ordered by their best hit.",
    request: {
      params: OrgIdParam,
      query: strict({
        q: z
          .string()
          .optional()
          .openapi({ param: { name: "q", in: "query" } }),
        kinds: z
          .string()
          .optional()
          .openapi({
            param: { name: "kinds", in: "query" },
            description:
              "`all`, or a comma-separated list of `SearchResultKind` values. An unknown kind is a 400.",
            example: "cost_report,dashboard,slo",
          }),
      }),
    },
    responses: {
      200: { description: "Hits", content: { "application/json": { schema: z.array(SearchHit) } } },
      400: ErrorResponses[400],
    },
  });

  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/starred",
    tags: ["Search"],
    summary: "List the caller's starred items",
    description:
      "The caller's own stars in this org, most recently starred first, each resolved fresh to " +
      "the same shape as a search hit. Stars on objects the caller can no longer open (deleted, " +
      "unshared, outside their cost visibility, or of a kind their role cannot read) are left " +
      "out rather than deleted, so they come back if access does.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Starred items",
        content: { "application/json": { schema: strict({ items: z.array(StarredItem) }) } },
      },
    },
  });

  ctx.registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/starred/{kind}/{objectId}",
    tags: ["Search"],
    summary: "Star an object",
    description:
      "Idempotent. The object must be one the caller could open; anything else is a 404. A " +
      "member can star up to 200 items per org (409 beyond that).",
    request: { params: StarParams },
    responses: {
      200: {
        description: "The star",
        content: { "application/json": { schema: strict({ item: StarredItem }) } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  ctx.registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/starred/{kind}/{objectId}",
    tags: ["Search"],
    summary: "Unstar an object",
    description: "Idempotent, and allowed on objects the caller can no longer see.",
    request: { params: StarParams },
    responses: {
      200: { description: "Unstarred", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
    },
  });
}
