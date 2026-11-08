/**
 * Provider OAuth ("Connect with X") for account credentials, the endpoint
 * definitions.
 *
 * - `POST /api/org/:orgId/provider-oauth/:pluginId/authorize` (org tree,
 *   `accounts:write`): the provider's consent URL. Everything the callback
 *   needs rides in a sealed `state`, so no cookie is involved and the desktop
 *   can open the system browser, which has no web session.
 * - `GET /api/provider-oauth/:pluginId/callback` (unauthenticated: the sealed
 *   state is the proof): where the provider sends the browser back. A browser
 *   page or a deep link, never called by an API client, and never in the
 *   document.
 *
 * The authorize body is checked by hand, with its own sentences, so it is
 * documented here and read by the handler (`handleRaw`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { OrgId, Uuid } from "../http/schemas/common";
import { PluginId } from "../http/schemas/plugin-registry";
import { undecodedQuery } from "../http/schemas/raw-query";

export const ProviderOAuthAuthorizeRequest = Schema.Struct({
  returnTo: Schema.Literals(["web", "desktop"]).annotate({
    description:
      "`web`: the callback page posts the result to the window that opened it (`window.opener.postMessage`, targeted at this server's app origin). `desktop`: the callback redirects to `infrawrench://provider-oauth?payload=<base64url JSON>`.",
  }),
  accountId: Schema.optionalKey(
    Schema.NullOr(Uuid).annotate({
      description:
        "Reconnecting an existing account: its id. Echoed in the result so the client knows which account to update.",
    }),
  ),
}).annotate({ identifier: "ProviderOAuthAuthorizeRequest" });

export const ProviderOAuthAuthorizeResponse = Schema.Struct({
  url: Schema.String.annotate({
    format: "uri",
    description:
      "The provider's consent URL. Open it in a popup (web) or the system browser (desktop); it is valid for 15 minutes.",
  }),
}).annotate({ identifier: "ProviderOAuthAuthorizeResponse" });

export class ProviderOAuthGroup extends HttpApiGroup.make("providerOAuth")
  .add(
    HttpApiEndpoint.post("authorize", "/:pluginId/authorize", {
      params: { orgId: OrgId, pluginId: PluginId },
      payload: ProviderOAuthAuthorizeRequest,
      success: ProviderOAuthAuthorizeResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "accounts:write")
      .annotate(OpenApi.Summary, "Start connecting a provider account with OAuth")
      .annotate(
        OpenApi.Description,
        "Returns the provider's consent URL for a plugin whose listing carries `oauth`. After consent the provider redirects to `/api/provider-oauth/{pluginId}/callback`, which delivers " +
          '`{ type: "infrawrench:provider-oauth", ok, pluginId, accountId?, credentials, accountName? }` (or `{ type, ok: false, pluginId, error }`) as `returnTo` asks. ' +
          "`credentials` holds the access token in the plugin's token field, prefilled fields the provider identified, and a sealed `__oauth` grant; send them unchanged to `POST /accounts` or `PUT /accounts/{id}/credentials` within 30 minutes. " +
          "Requires `accounts:write`. 400 when the plugin has no OAuth flow or this server has no client configured for it.",
      )
      .annotate(SuccessDescription, "Consent URL"),
  )
  .prefix("/api/org/:orgId/provider-oauth")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Accounts") {}

export class ProviderOAuthCallbackGroup extends HttpApiGroup.make("providerOAuthCallback")
  .add(
    HttpApiEndpoint.get("callback", "/api/provider-oauth/:pluginId/callback", {
      params: { pluginId: Schema.String },
      query: {
        state: undecodedQuery(Schema.String),
        code: undecodedQuery(Schema.String),
        error: undecodedQuery(Schema.String),
        error_description: undecodedQuery(Schema.String),
      },
      success: [
        Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/html" })),
        HttpApiSchema.Empty(302),
      ],
    }).annotate(OpenApi.Exclude, true),
  )
  .annotate(OpenApi.Title, "Accounts") {}

export class ProviderOAuthApi extends withApiDefaults(
  HttpApi.make("providerOAuth").add(ProviderOAuthGroup).add(ProviderOAuthCallbackGroup),
) {}
