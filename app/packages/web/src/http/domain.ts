/**
 * How a slice of the API is declared on HttpApi.
 *
 * Each domain (budgets, cost reports, ...) is its own small `HttpApi` with its
 * own handler layer, listed once in `./domains.ts`. They all register on the
 * one router, and the spec builder documents each, so no file has to name
 * every group in a single typed chain, and two domains converted at the same
 * time never edit the same definition.
 */
import { Context, Layer, type FileSystem, type Path } from "effect";
import type { Etag, HttpPlatform, HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder, OpenApi, type HttpApiGroup } from "effect/http-api";
import { RequestErrors, type OrgAuth, type SessionAuth } from "./middleware";

/**
 * What a domain layer may still need once its handlers are provided: the
 * router and platform services `HttpApiBuilder.layer` always asks for, and the
 * middleware implementations, all provided once by the server.
 */
export type DomainRequirements =
  | Etag.Generator
  | HttpRouter.HttpRouter
  | FileSystem.FileSystem
  | HttpPlatform.HttpPlatform
  | Path.Path
  | OrgAuth
  | SessionAuth
  | RequestErrors;

/**
 * One API domain, as the server, the spec builder and the route-shadowing test
 * see it. Built by {@link makeDomain}, which keeps the domain's typed `HttpApi`
 * to itself.
 */
export interface Domain {
  readonly name: string;
  /**
   * `HttpApiBuilder.layer(api)` with the domain's handlers provided. The
   * middleware implementations and platform services are the only things
   * left for the server to provide.
   */
  readonly layer: Layer.Layer<never, never, DomainRequirements>;
  /** The domain's generated OpenAPI document. */
  readonly openapi: () => OpenApi.OpenAPISpec;
  /** Visit each endpoint with its merged annotations, for the spec builder and tests. */
  readonly endpoints: () => ReadonlyArray<DomainEndpoint>;
}

export interface DomainEndpoint {
  readonly method: string;
  /** Router path, `/api/org/:orgId/budgets/:id`. */
  readonly path: string;
  /** The id Effect gives the operation by default, `budgets.get`. */
  readonly defaultOperationId: string;
  readonly annotations: Context.Context<never>;
}

/** Declare a domain from its `HttpApi` and the layer providing its group handlers. */
export const makeDomain = <
  Id extends string,
  Groups extends HttpApiGroup.Constraint,
  R extends DomainRequirements,
>(
  name: string,
  api: HttpApi.HttpApi<Id, Groups>,
  handlers: Layer.Layer<HttpApiGroup.ToService<Id, Groups>, never, R>,
): Domain => ({
  name,
  layer: Layer.provide(HttpApiBuilder.layer(api), handlers),
  openapi: () => OpenApi.fromApi(api),
  endpoints: () => {
    const out: DomainEndpoint[] = [];
    HttpApi.reflect(api, {
      onGroup() {},
      onEndpoint({ endpoint, group, mergedAnnotations }) {
        out.push({
          method: endpoint.method,
          path: endpoint.path,
          defaultOperationId: `${group.identifier}.${endpoint.identifier}`,
          annotations: Context.merge(mergedAnnotations, endpoint.annotations),
        });
      },
    });
    return out;
  },
});

/**
 * The defaults every domain's `HttpApi` carries: decode reporting every issue
 * rather than the first, and {@link RequestErrors} outermost on every
 * endpoint. Call it after the groups are added, since middleware only reaches
 * the endpoints present when it is applied.
 *
 * ```ts
 * export class BudgetsApi extends withApiDefaults(HttpApi.make("budgets").add(BudgetsGroup)) {}
 * ```
 */
export const withApiDefaults = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
) =>
  api
    .annotate(HttpApi.PayloadParseOptions, { errors: "all" })
    .annotate(HttpApi.QueryParseOptions, { errors: "all" })
    .middleware(RequestErrors);
