/**
 * WebSocket gateway tokens: `/api/org/:orgId/ws-token`, the endpoint
 * definitions.
 *
 * The token is what the gateway authenticates the socket with
 * (`services/ws-auth.ts`), so minting one takes `resources:execute`, the
 * permission a terminal or a console needs. The path is internal: it is in
 * the public spec's withheld list (`api/openapi/public-spec.ts`), which marks
 * the operation `x-internal`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { OrgAuth } from "../http/middleware-tags";
import { OrgParams } from "../http/schemas/common";

export const WsTokenResponse = Schema.Struct({ token: Schema.String });

export class WsTokenGroup extends HttpApiGroup.make("wsToken")
  .add(
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      success: WsTokenResponse,
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Mint a short-lived token for the WebSocket gateway")
      .annotate(SuccessDescription, "Token"),
  )
  .prefix("/api/org/:orgId/ws-token")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "WebSocket") {}

export class WsTokenApi extends withApiDefaults(HttpApi.make("wsToken").add(WsTokenGroup)) {}
