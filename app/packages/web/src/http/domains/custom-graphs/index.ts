/**
 * Custom graphs: `/api/org/:orgId/custom-graphs`, the handlers.
 *
 * CRUD plus: GET /typings (the static graph.d.ts for the Monaco editor),
 * POST /check (headless type check of arbitrary source), and
 * POST /:id/render (run the script in the isolate and return the render spec).
 *
 * The logic lives in `services/custom-graphs.ts` so the MCP/chat tool
 * registry drives exactly the same code path; this file is transport only.
 * Writes and renders are paid-plan-gated in the service (402 via
 * `PlanRequiredError`).
 */
import { Effect, Predicate, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  badRequest,
  CustomGraphCheckResult,
  CustomGraphFull,
  CustomGraphRenderRequest,
  CustomGraphRenderResult,
  CustomGraphsApi,
  CustomGraphSummary,
  notFound,
  ok,
} from "@infrawrench/api-contract";
import {
  CustomGraphError,
  checkCustomGraphSource,
  createCustomGraph,
  generateCustomGraphTypings,
  getCustomGraph,
  listCustomGraphs,
  renderOrgCustomGraph,
  softDeleteCustomGraph,
  updateCustomGraph,
  type CustomGraphBody,
} from "../../../services/custom-graphs";
import { PlanRequiredError } from "../../../services/entitlements";
import { makeDomain } from "../../domain";
import { decodeAsPayload, fieldsOf, readJson, readJsonOr } from "../../request-body";
import { refuse, refusalCall, type ReadRefusal } from "../../refusals";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/** `fail(c, e)`: the service's refusal with its status, a plan gate as 402. */
const customGraphRefusal: ReadRefusal = (error) => {
  if (error instanceof CustomGraphError) return error;
  if (error instanceof PlanRequiredError) return { status: 402, message: error.message };
  return undefined;
};

/**
 * The create/update body as the service takes it. The service checks every
 * bound with its own sentences; what it cannot survive is a field of the
 * wrong type, which used to reach it unchecked and crash it into a 500.
 */
const graphBody = Effect.fnUntraced(function* (fields: { readonly [key: string]: unknown }) {
  const { name, description, source } = fields;
  if (name !== undefined && !Predicate.isString(name)) {
    return yield* badRequest("name must be a string.");
  }
  if (description !== undefined && description !== null && !Predicate.isString(description)) {
    return yield* badRequest("description must be a string or null.");
  }
  if (source !== undefined && !Predicate.isString(source)) {
    return yield* badRequest("source must be a string.");
  }
  const body: CustomGraphBody = {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(source !== undefined ? { source } : {}),
  };
  return body;
});

const CustomGraphsHandlers = HttpApiBuilder.group(CustomGraphsApi, "customGraphs", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rows = yield* legacy(() => listCustomGraphs(organizationId));
        // The list is for pickers and sidebars: no need to ship every source blob.
        const summaries = rows.map(({ id, name, description, createdAt, updatedAt }) => ({
          id,
          name,
          description,
          createdAt,
          updatedAt,
        }));
        return yield* respond(Schema.Array(CustomGraphSummary))(summaries);
      }),
    )
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* graphBody(yield* fieldsOf(yield* readJson(request)));
        const created = yield* refusalCall(
          customGraphRefusal,
          { 400: refuse[400], 402: refuse[402] },
          () => createCustomGraph(organizationId, body, session.userId),
        );
        return yield* respond(CustomGraphFull, { status: 201 })(created);
      }),
    )
    .handle("typings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const typings = yield* legacy(() => generateCustomGraphTypings(organizationId));
        return HttpServerResponse.text(typings, { contentType: "text/plain; charset=UTF-8" });
      }),
    )
    .handleRaw("check", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { source } = yield* fieldsOf(yield* readJson(request));
        if (!Predicate.isString(source)) return yield* badRequest("source is required");
        const result = yield* legacy(() => checkCustomGraphSource(organizationId, source));
        return yield* respond(CustomGraphCheckResult)(result);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const row = yield* legacy(() => getCustomGraph(organizationId, params.id));
        if (!row) return yield* notFound();
        return yield* respond(CustomGraphFull)(row);
      }),
    )
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* graphBody(yield* fieldsOf(yield* readJson(request)));
        const updated = yield* refusalCall(
          customGraphRefusal,
          { 400: refuse[400], 402: refuse[402], 404: refuse[404] },
          () => updateCustomGraph(organizationId, params.id, body, session.userId),
        );
        return yield* respond(CustomGraphFull)(updated);
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        yield* refusalCall(customGraphRefusal, { 404: refuse[404] }, () =>
          softDeleteCustomGraph(organizationId, params.id),
        );
        return ok;
      }),
    )
    .handleRaw("render", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        // An absent or unreadable body runs the graph with no input.
        const input = yield* decodeAsPayload(
          CustomGraphRenderRequest,
          yield* readJsonOr(request, {}),
        );
        const result = yield* refusalCall(
          customGraphRefusal,
          { 400: refuse[400], 402: refuse[402], 404: refuse[404] },
          () =>
            renderOrgCustomGraph(organizationId, params.id, {
              ...(input.controls ? { controls: input.controls } : {}),
              ...(input.button ? { button: input.button } : {}),
              ...(input.trigger ? { trigger: input.trigger } : {}),
            }),
        );
        return yield* respond(CustomGraphRenderResult)(result);
      }),
    ),
);

export const customGraphsDomain = makeDomain(
  "custom-graphs",
  CustomGraphsApi,
  CustomGraphsHandlers,
);
