import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const SavedCostFilterTerm = strict({
  dimension: z.enum([
    "provider",
    "account",
    "service",
    "region",
    "resource",
    "tag",
    "charge_type",
    "commitment",
  ]),
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string()).min(1),
  tagKey: z.string().optional(),
}).openapi("SavedCostFilterTerm");

const SavedCostFilterInput = strict({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  filters: z
    .array(SavedCostFilterTerm)
    .max(50)
    .optional()
    .describe("The structured filter. May be omitted only when `query` is sent instead."),
  query: z
    .string()
    .max(4000)
    .optional()
    .describe(
      "The same filter written in the cost query language — an alternative spelling of " +
        "`filters`, compiled server-side into exactly that structure. Sending both a query " +
        "and a non-empty `filters` is a 400, not a precedence rule. Whichever spelling is " +
        "used, the result must be non-empty (an empty saved filter matches everything, which " +
        "is the same as no filter wearing a name) and every tag term must carry its key.",
    )
    .openapi({ example: "tag['env'] = 'prod'" }),
}).openapi("SavedCostFilterInput");

const SavedCostFilter = strict({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  filters: z.array(SavedCostFilterTerm),
  query: z
    .string()
    .describe("The canonical cost-query-language rendering of `filters`, derived server-side."),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("SavedCostFilter");

const SavedCostFilterReferent = strict({
  kind: z.enum(["budget", "cost_report", "cost_graph_widget"]),
  id: Uuid.describe("Budget id, report id, or dashboard-widget id."),
  name: z.string().describe("Budget name, report name, or the widget's title."),
  dashboardId: Uuid.optional().describe("Set for `cost_graph_widget` referents."),
  dashboardName: z.string().optional(),
}).openapi("SavedCostFilterReferent");

export function registerSavedFilterPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const params = (extra: Record<string, z.ZodType>) => OrgIdParam.extend(extra);
  const idParam = () => params({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/saved-cost-filters",
    tags: ["Saved cost filters"],
    summary: "List saved cost filters",
    description:
      "Named, reusable cost filter sets. Graphs, reports and budgets reference one **by id** " +
      "(`savedFilterId` in their configs and in `POST /costs/query`), and the server resolves " +
      "the reference at query time — so editing a saved filter changes every referent at once, " +
      "and nothing ever holds a copy.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Saved filters, alphabetically",
        content: { "application/json": { schema: z.array(SavedCostFilter) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/saved-cost-filters",
    tags: ["Saved cost filters"],
    summary: "Create a saved cost filter",
    description:
      "Names must be unique per organization (case-insensitively) — they are how the CLI's " +
      "`--filter <name>` and humans address the filter. A name collision is a 409.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SavedCostFilterInput } }, required: true },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: SavedCostFilter } },
      },
      400: ErrorResponses[400],
      409: {
        description: "A live saved filter already uses this name.",
        content: {
          "application/json": { schema: strict({ error: z.string() }) },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/saved-cost-filters/{id}",
    tags: ["Saved cost filters"],
    summary: "Get a saved cost filter",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Saved filter",
        content: { "application/json": { schema: SavedCostFilter } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/saved-cost-filters/{id}",
    tags: ["Saved cost filters"],
    summary: "Update a saved cost filter",
    description:
      "Replaces the filter's name, description and terms. This is the high-leverage write: " +
      "every graph, report and budget referencing the filter runs the new terms on its next " +
      "query — re-scoping a referenced budget can change which alerts fire. " +
      "`GET /{id}/referents` names what a change will touch.",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: SavedCostFilterInput } }, required: true },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: SavedCostFilter } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: {
        description: "A live saved filter already uses this name.",
        content: {
          "application/json": { schema: strict({ error: z.string() }) },
        },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/saved-cost-filters/{id}",
    tags: ["Saved cost filters"],
    summary: "Delete a saved cost filter",
    description:
      "Soft delete — **refused with a 409 while anything references the filter**, with the " +
      "referents in the body. Deleting a referenced filter would silently widen every " +
      "referent's scope to all spend; for a budget that can fire or suppress alerts, so " +
      "detaching the referents is a deliberate step, never a side effect of deletion.",
    request: { params: idParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
      409: {
        description: "Still referenced — the body lists every referent.",
        content: {
          "application/json": {
            schema: strict({
              error: z.string(),
              referents: z.array(SavedCostFilterReferent),
            }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/saved-cost-filters/{id}/referents",
    tags: ["Saved cost filters"],
    summary: "List a saved filter's referents",
    description:
      "Every budget, cost report and dashboard cost graph referencing this filter — what an " +
      "edit will re-scope, and what a delete would be refused over.",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Referents (empty when nothing references the filter)",
        content: {
          "application/json": {
            schema: strict({ referents: z.array(SavedCostFilterReferent) }),
          },
        },
      },
      404: ErrorResponses[404],
    },
  });
}
