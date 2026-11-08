/**
 * Provider OAuth ("Connect with X"), the handlers. The flows themselves are
 * promise code in `./operations.ts`, one `legacy` call each.
 *
 * The callback runs plugin hooks, so it is a gateway route
 * (`edge/gateway-routes.ts`).
 */
import { Effect, Layer } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { makeDomain } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { readJsonOr } from "../../json-body";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { htmlPage, queryParam, redirect } from "../raw-responses";
import { ProviderOAuthApi, ProviderOAuthAuthorizeResponse } from "./api";
import { authorizeProviderOAuth, completeProviderOAuth } from "./operations";

const ProviderOAuthHandlers = HttpApiBuilder.group(ProviderOAuthApi, "providerOAuth", (handlers) =>
  handlers.handleRaw("authorize", ({ request, params }) =>
    Effect.gen(function* () {
      const principal = yield* OrgPrincipal;
      const body = yield* readJsonOr(request, null);
      const outcome = yield* legacy(() =>
        authorizeProviderOAuth({
          organizationId: principal.organizationId,
          userId: principal.session.userId,
          pluginId: params.pluginId,
          body,
        }),
      );
      if (!outcome.ok) {
        return yield* outcome.status === 404
          ? new NotFound({ error: outcome.error })
          : new BadRequest({ error: outcome.error });
      }
      return yield* respond(ProviderOAuthAuthorizeResponse)({ url: outcome.url });
    }),
  ),
);

const ProviderOAuthCallbackHandlers = HttpApiBuilder.group(
  ProviderOAuthApi,
  "providerOAuthCallback",
  (handlers) =>
    handlers.handleRaw("callback", ({ request, params }) =>
      Effect.gen(function* () {
        const delivery = yield* legacy(() =>
          completeProviderOAuth({
            pluginId: params.pluginId,
            query: (name) => queryParam(request, name),
          }),
        );
        const response =
          delivery.kind === "redirect" ? redirect(delivery.location, 302) : htmlPage(delivery.html);
        return HttpServerResponse.setHeaders(response, {
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
      }),
    ),
);

export const providerOAuthDomain = makeDomain(
  "providerOAuth",
  ProviderOAuthApi,
  Layer.mergeAll(ProviderOAuthHandlers, ProviderOAuthCallbackHandlers),
);
