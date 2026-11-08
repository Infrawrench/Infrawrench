/**
 * Discovery documents at the domain root, the handlers: `/.well-known/*` for
 * MCP's OAuth discovery and `/auth.md` for agent registration.
 *
 * Every URL in them is on the public origin (`PUBLIC_BASE_URL`, then
 * `APP_URL`, then the request's host under its `x-forwarded-proto`): behind
 * the ingress the request itself is plain http, and an advertised `resource`
 * that differs from the URL the client connected to is one it rejects.
 */
import { Effect, Layer } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { keepAlive } from "@infrawrench/server-core/runtime/request-scope";
import { DiscoveryApi } from "@infrawrench/api-contract";
import { authMarkdown } from "../../../mcp/auth-md";
import { probeClientRegistrationSupport } from "../../../mcp/registration-probe";
import {
  DISCOVERY_UNCONFIGURED,
  getAuthorizationServerUrl,
  getPublicBaseUrl,
  protectedResourceMetadata,
} from "../../../mcp/well-known";
import { makeDomain } from "../../domain";
import { fireAndForget } from "../../legacy";
import { rawRequest } from "../../caller-auth";

/** The public origin of this request, as {@link getPublicBaseUrl} reads it. */
const publicBaseUrl = Effect.gen(function* () {
  const request = yield* rawRequest;
  return getPublicBaseUrl(request.url, request.headers.get("x-forwarded-proto"));
});

const unconfigured = () => HttpServerResponse.jsonUnsafe(DISCOVERY_UNCONFIGURED, { status: 500 });

/**
 * A client reading discovery is about to register with the authorization
 * server: check, in the background, that it offers a way to (CIMD or the
 * deprecated-but-supported DCR), and say so in the logs if it does not.
 */
const probeRegistration = (authServer: string) =>
  fireAndForget(() => keepAlive(probeClientRegistrationSupport(authServer)));

const protectedResource = Effect.gen(function* () {
  const baseUrl = yield* publicBaseUrl;
  const authServer = getAuthorizationServerUrl();
  if (!authServer) return unconfigured();
  yield* probeRegistration(authServer);
  return HttpServerResponse.jsonUnsafe(protectedResourceMetadata(baseUrl, authServer));
});

const WellKnownHandlers = HttpApiBuilder.group(DiscoveryApi, "wellKnown", (handlers) =>
  handlers
    .handleRaw("protectedResource", () => protectedResource)
    .handleRaw("protectedResourceForMcp", () => protectedResource)
    // For clients that look for authorization-server metadata on the resource
    // host: a redirect to the AuthKit-hosted document, so it never has to be
    // kept in step here.
    .handleRaw("authorizationServer", () =>
      Effect.gen(function* () {
        const authServer = getAuthorizationServerUrl();
        if (!authServer) return unconfigured();
        yield* probeRegistration(authServer);
        return HttpServerResponse.redirect(`${authServer}/.well-known/oauth-authorization-server`, {
          status: 302,
        });
      }),
    ),
);

const AuthMdHandlers = HttpApiBuilder.group(DiscoveryApi, "authMd", (handlers) =>
  handlers.handleRaw("document", () =>
    Effect.map(publicBaseUrl, (baseUrl) =>
      HttpServerResponse.text(authMarkdown(baseUrl), {
        contentType: "text/markdown; charset=utf-8",
        // Short, because the document embeds live limits and the trial duration.
        headers: { "cache-control": "public, max-age=300" },
      }),
    ),
  ),
);

export const discoveryDomain = makeDomain(
  "discovery",
  DiscoveryApi,
  Layer.mergeAll(WellKnownHandlers, AuthMdHandlers),
);
