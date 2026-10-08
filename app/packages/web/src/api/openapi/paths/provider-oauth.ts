import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid } from "../common";
import type { BuildContext } from "../context";

const AuthorizeRequest = strict({
  returnTo: z.enum(["web", "desktop"]).openapi({
    description:
      "`web`: the callback page posts the result to the window that opened it (`window.opener.postMessage`, targeted at this server's app origin). `desktop`: the callback redirects to `infrawrench://provider-oauth?payload=<base64url JSON>`.",
  }),
  accountId: Uuid.optional().nullable().openapi({
    description:
      "Reconnecting an existing account: its id. Echoed in the result so the client knows which account to update.",
  }),
}).openapi("ProviderOAuthAuthorizeRequest");

const AuthorizeResponse = strict({
  url: z.string().url().openapi({
    description:
      "The provider's consent URL. Open it in a popup (web) or the system browser (desktop); it is valid for 15 minutes.",
  }),
}).openapi("ProviderOAuthAuthorizeResponse");

export function registerProviderOAuthPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/provider-oauth/{pluginId}/authorize",
    tags: ["Accounts"],
    summary: "Start connecting a provider account with OAuth",
    description:
      "Returns the provider's consent URL for a plugin whose listing carries `oauth`. After consent the provider redirects to `/api/provider-oauth/{pluginId}/callback`, which delivers " +
      '`{ type: "infrawrench:provider-oauth", ok, pluginId, accountId?, credentials, accountName? }` (or `{ type, ok: false, pluginId, error }`) as `returnTo` asks. ' +
      "`credentials` holds the access token in the plugin's token field, prefilled fields the provider identified, and a sealed `__oauth` grant; send them unchanged to `POST /accounts` or `PUT /accounts/{id}/credentials` within 30 minutes. " +
      "Requires `accounts:write`. 400 when the plugin has no OAuth flow or this server has no client configured for it.",
    request: {
      params: OrgIdParam.extend({
        pluginId: enums.PluginId.openapi({ param: { name: "pluginId", in: "path" } }),
      }),
      body: { content: { "application/json": { schema: AuthorizeRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Consent URL",
        content: { "application/json": { schema: AuthorizeResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
