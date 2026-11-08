/**
 * The defaults every domain's `HttpApi` carries.
 */
import { HttpApi, type HttpApiGroup } from "effect/http-api";
import { RequestErrors } from "./middleware-tags";

/**
 * Decode reporting every issue rather than the first, and {@link RequestErrors}
 * outermost on every endpoint. Call it after the groups are added, since
 * middleware only reaches the endpoints present when it is applied.
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
