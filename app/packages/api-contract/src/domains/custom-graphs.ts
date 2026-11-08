/**
 * Custom graphs: `/api/org/:orgId/custom-graphs`, the endpoint definitions.
 *
 * Custom graphs reuse `dashboards:read` / `dashboards:write`: they are
 * dashboard content. Create and update bodies are checked by the service
 * (`services/custom-graphs.ts`, shared with the MCP and chat tools), which
 * answers its own sentences, so those payloads are documented here and read
 * by the handler. The Terraform provider manages these graphs
 * (`infrawrench_custom_graph`), so component and property names stay as the
 * Zod spec published them.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound, PaymentRequired } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, JsonObject, Ok, OrgIdParams, OrgParams, Uuid } from "../http/schemas/common";
import { optionalRequestBody } from "../http/schemas/documented";

export const CustomGraphSummary = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "CustomGraphSummary" });

export const CustomGraphFull = Schema.Struct({
  id: Uuid,
  organizationId: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** The graph's TypeScript source, run server-side in a sandbox. */
  source: Schema.String,
  createdByUserId: Schema.NullOr(Schema.String),
  /**
   * Who last wrote the source; the script's read-only infra.* access runs
   * with this user's role permissions at render time.
   */
  sourceAuthorUserId: Schema.NullOr(Schema.String),
  deletedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "CustomGraphFull" });

const GraphName = Schema.String.check(minLength(1), maxLength(120));
const GraphDescription = Schema.NullOr(Schema.String.check(maxLength(500)));
const GraphSource = Schema.String.check(maxLength(131072));

export const CustomGraphInput = Schema.Struct({
  name: GraphName,
  description: Schema.optionalKey(GraphDescription),
  source: Schema.optionalKey(GraphSource),
}).annotate({ identifier: "CustomGraphInput" });

export const CustomGraphUpdate = Schema.Struct({
  name: Schema.optionalKey(GraphName),
  description: Schema.optionalKey(GraphDescription),
  source: Schema.optionalKey(GraphSource),
}).annotate({ identifier: "CustomGraphUpdate" });

const ControlValue = Schema.Union([
  Schema.String.check(maxLength(500)),
  Schema.Finite,
  Schema.Boolean,
]);

/** What starts a run; decoded by the handler, which reads an absent body as `{}`. */
export const CustomGraphRenderRequest = Schema.Struct({
  /** Current control values, keyed by control id. */
  controls: Schema.optionalKey(Schema.Record(Schema.String.check(maxLength(64)), ControlValue)),
  /** Id of a declared button that was pressed to start this run. */
  button: Schema.optionalKey(Schema.String.check(maxLength(64))),
  /** What started this run, surfaced to the script as graph.event.kind. */
  trigger: Schema.optionalKey(Schema.Literals(["manual", "refresh", "interaction"])),
}).annotate({ identifier: "CustomGraphRenderRequest" });

export const CustomGraphRenderResult = Schema.Struct({
  ok: Schema.Boolean,
  /**
   * The validated render spec (`CustomGraphRenderSpec` in
   * `@infrawrench/client-core`): chart, controls, refreshSeconds, notice.
   * Null when the run failed.
   */
  spec: Schema.NullOr(JsonObject),
  error: Schema.NullOr(Schema.String),
  logs: Schema.Array(
    Schema.Struct({
      level: Schema.Literals(["info", "warn", "error"]),
      message: Schema.String,
    }),
  ),
  renderedAt: IsoDateTime,
  durationMs: Schema.Int,
}).annotate({ identifier: "CustomGraphRenderResult" });

export const CustomGraphCheckRequest = Schema.Struct({
  source: GraphSource,
}).annotate({ identifier: "CustomGraphCheckRequest" });

export const CustomGraphCheckResult = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({
      line: Schema.Int,
      column: Schema.Int,
      code: Schema.Int,
      category: Schema.String,
      message: Schema.String,
    }),
  ),
  hasErrors: Schema.Boolean,
  /** True when TypeScript's lib files were unavailable: syntax-only check. */
  degraded: Schema.Boolean,
}).annotate({ identifier: "CustomGraphCheckResult" });

export class CustomGraphsGroup extends HttpApiGroup.make("customGraphs")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(CustomGraphSummary),
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "List custom graphs")
      .annotate(SuccessDescription, "Custom graphs"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: CustomGraphInput,
      success: CustomGraphFull.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, PaymentRequired],
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(OpenApi.Summary, "Create a custom graph (paid plan required)")
      .annotate(SuccessDescription, "Created"),
    // Org-specific: the graph half is static, the appended read-only infra
    // half reflects this org's connected accounts.
    HttpApiEndpoint.get("typings", "/typings", {
      params: OrgParams,
      success: Schema.String.pipe(HttpApiSchema.asText()),
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "The ambient graph.d.ts for custom-graph source")
      .annotate(SuccessDescription, "TypeScript declarations"),
    HttpApiEndpoint.post("check", "/check", {
      params: OrgParams,
      payload: CustomGraphCheckRequest,
      success: CustomGraphCheckResult,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Type-check custom-graph source without saving it")
      .annotate(SuccessDescription, "Diagnostics"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: CustomGraphFull,
      error: NotFound,
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Get a custom graph (including source)")
      .annotate(SuccessDescription, "Custom graph"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: CustomGraphUpdate,
      success: CustomGraphFull,
      error: [BadRequest, PaymentRequired, NotFound],
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(OpenApi.Summary, "Update a custom graph (paid plan required)")
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(OpenApi.Summary, "Delete a custom graph (and its dashboard cards)")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("render", "/:id/render", {
      params: OrgIdParams,
      payload: CustomGraphRenderRequest,
      success: CustomGraphRenderResult,
      error: [BadRequest, PaymentRequired, NotFound],
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(
        OpenApi.Summary,
        "Run the graph's script and return its render spec (paid plan required)",
      )
      .annotate(SuccessDescription, "Render result")
      .annotate(InvalidRequestMessage, "Invalid render request")
      .annotate(OpenApi.Transform, optionalRequestBody),
  )
  .prefix("/api/org/:orgId/custom-graphs")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Custom graphs") {}

export class CustomGraphsApi extends withApiDefaults(
  HttpApi.make("customGraphs").add(CustomGraphsGroup),
) {}
