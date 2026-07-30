import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime, JsonObject } from "../common";
import type { BuildContext } from "../context";

const CustomGraphSummary = strict({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("CustomGraphSummary");

const CustomGraphFull = strict({
  id: Uuid,
  organizationId: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  /** The graph's TypeScript source, run server-side in a sandbox. */
  source: z.string(),
  createdByUserId: z.string().nullable(),
  /**
   * Who last wrote the source; the script's read-only infra.* access runs
   * with this user's role permissions at render time.
   */
  sourceAuthorUserId: z.string().nullable(),
  deletedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("CustomGraphFull");

const CustomGraphInput = strict({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  source: z.string().max(131072).optional(),
}).openapi("CustomGraphInput");

const CustomGraphUpdate = strict({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  source: z.string().max(131072).optional(),
}).openapi("CustomGraphUpdate");

const ControlValue = z.union([z.string().max(500), z.number(), z.boolean()]);

const RenderRequest = strict({
  /** Current control values, keyed by control id. */
  controls: z.record(z.string().max(64), ControlValue).optional(),
  /** Id of a declared button that was pressed to start this run. */
  button: z.string().max(64).optional(),
  /** What started this run, surfaced to the script as graph.event.kind. */
  trigger: z.enum(["manual", "refresh", "interaction"]).optional(),
}).openapi("CustomGraphRenderRequest");

const RenderResult = strict({
  ok: z.boolean(),
  /**
   * The validated render spec (`CustomGraphRenderSpec` in
   * `@infrawrench/client-core`): chart, controls, refreshSeconds, notice.
   * Null when the run failed.
   */
  spec: JsonObject.nullable(),
  error: z.string().nullable(),
  logs: z.array(strict({ level: z.enum(["info", "warn", "error"]), message: z.string() })),
  renderedAt: IsoDateTime,
  durationMs: z.number().int(),
}).openapi("CustomGraphRenderResult");

const CheckRequest = strict({
  source: z.string().max(131072),
}).openapi("CustomGraphCheckRequest");

const CheckResult = strict({
  diagnostics: z.array(
    strict({
      line: z.number().int(),
      column: z.number().int(),
      code: z.number().int(),
      category: z.string(),
      message: z.string(),
    }),
  ),
  hasErrors: z.boolean(),
  /** True when TypeScript's lib files were unavailable — syntax-only check. */
  degraded: z.boolean(),
}).openapi("CustomGraphCheckResult");

export function registerCustomGraphPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const idParam = () =>
    OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/custom-graphs",
    tags: ["Custom graphs"],
    summary: "List custom graphs",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Custom graphs",
        content: { "application/json": { schema: z.array(CustomGraphSummary) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/custom-graphs",
    tags: ["Custom graphs"],
    summary: "Create a custom graph (paid plan required)",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CustomGraphInput } }, required: true },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: CustomGraphFull } } },
      400: ErrorResponses[400],
      402: ErrorResponses[402],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/custom-graphs/typings",
    tags: ["Custom graphs"],
    summary: "The ambient graph.d.ts for custom-graph source",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "TypeScript declarations",
        content: { "text/plain": { schema: z.string() } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/custom-graphs/check",
    tags: ["Custom graphs"],
    summary: "Type-check custom-graph source without saving it",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CheckRequest } }, required: true },
    },
    responses: {
      200: { description: "Diagnostics", content: { "application/json": { schema: CheckResult } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/custom-graphs/{id}",
    tags: ["Custom graphs"],
    summary: "Get a custom graph (including source)",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Custom graph",
        content: { "application/json": { schema: CustomGraphFull } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/custom-graphs/{id}",
    tags: ["Custom graphs"],
    summary: "Update a custom graph (paid plan required)",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: CustomGraphUpdate } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: CustomGraphFull } } },
      400: ErrorResponses[400],
      402: ErrorResponses[402],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/custom-graphs/{id}",
    tags: ["Custom graphs"],
    summary: "Delete a custom graph (and its dashboard cards)",
    request: { params: idParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/custom-graphs/{id}/render",
    tags: ["Custom graphs"],
    summary: "Run the graph's script and return its render spec (paid plan required)",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: RenderRequest } }, required: false },
    },
    responses: {
      200: {
        description: "Render result",
        content: { "application/json": { schema: RenderResult } },
      },
      400: ErrorResponses[400],
      402: ErrorResponses[402],
      404: ErrorResponses[404],
    },
  });
}
