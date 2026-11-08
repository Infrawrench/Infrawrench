/**
 * Starred items: `/api/org/:orgId/starred`, the endpoint definitions.
 *
 * The caller's own stars, keyed by their user: membership is the only gate
 * (no `RequiredPermission`). Path params are read as sent: an unknown kind or
 * an over-long id is the handler's own `Unknown kind` 400.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "@infrawrench/ui/schemas";
import { SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Conflict, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { Ok, OrgId, OrgParams } from "../../schemas/common";
import { documentedAs } from "../../schemas/documented";
import { SearchResultKind, StarredItem } from "../../schemas/search";

const StarParams = {
  orgId: OrgId,
  kind: documentedAs(SearchResultKind),
  objectId: documentedAs(Schema.String.check(minLength(1), maxLength(512))),
};

export class StarredGroup extends HttpApiGroup.make("starred")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Struct({ items: Schema.Array(StarredItem) }),
    })
      .annotate(OpenApi.Summary, "List the caller's starred items")
      .annotate(
        OpenApi.Description,
        "The caller's own stars in this org, most recently starred first, each resolved fresh to " +
          "the same shape as a search hit. Stars on objects the caller can no longer open (deleted, " +
          "unshared, outside their cost visibility, or of a kind their role cannot read) are left " +
          "out rather than deleted, so they come back if access does.",
      )
      .annotate(SuccessDescription, "Starred items"),
    HttpApiEndpoint.put("star", "/:kind/:objectId", {
      params: StarParams,
      success: Schema.Struct({ item: StarredItem }),
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(OpenApi.Summary, "Star an object")
      .annotate(
        OpenApi.Description,
        "Idempotent. The object must be one the caller could open; anything else is a 404. A " +
          "member can star up to 200 items per org (409 beyond that).",
      )
      .annotate(SuccessDescription, "The star"),
    HttpApiEndpoint.delete("unstar", "/:kind/:objectId", {
      params: StarParams,
      success: Ok,
      error: BadRequest,
    })
      .annotate(OpenApi.Summary, "Unstar an object")
      .annotate(
        OpenApi.Description,
        "Idempotent, and allowed on objects the caller can no longer see.",
      )
      .annotate(SuccessDescription, "Unstarred"),
  )
  .prefix("/api/org/:orgId/starred")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Search") {}

export class StarredApi extends withApiDefaults(HttpApi.make("starred").add(StarredGroup)) {}
