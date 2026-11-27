/**
 * Discovery documents at the domain root, the handlers: `/.well-known/*` for
 * MCP's OAuth discovery and the AI Catalog, `/api/mcp/server-card` for the MCP
 * Server Card, and `/auth.md` for agent registration.
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
  AI_CATALOG_MEDIA_TYPE,
  aiCatalog,
  SERVER_CARD_MEDIA_TYPE,
  serverCard,
} from "../../../mcp/server-card";
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

/** FNV-1a, as an opaque validator: the documents are small and change only on deploy. */
function etagOf(body: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `"${(hash >>> 0).toString(16)}-${body.length.toString(16)}"`;
}

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === "*" || tag === etag);
}

/**
 * A public, read-only discovery document as SEP-2127 asks one to be served:
 * open CORS so browser clients can read it, an hour's caching, and an `ETag`
 * that a matching `If-None-Match` turns into a 304.
 */
const publicDocument = (contentType: string, build: (baseUrl: string) => unknown) =>
  Effect.gen(function* () {
    const request = yield* rawRequest;
    const baseUrl = getPublicBaseUrl(request.url, request.headers.get("x-forwarded-proto"));
    const body = JSON.stringify(build(baseUrl));
    const etag = etagOf(body);
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET",
      "access-control-allow-headers": "Content-Type, If-None-Match",
      "access-control-expose-headers": "ETag",
      "cache-control": "public, max-age=3600",
      etag,
    };
    if (etagMatches(request.headers.get("if-none-match"), etag)) {
      return HttpServerResponse.empty({ status: 304, headers });
    }
    return HttpServerResponse.text(body, { contentType, headers });
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
    )
    .handleRaw("aiCatalog", () => publicDocument(AI_CATALOG_MEDIA_TYPE, aiCatalog)),
);

const ServerCardHandlers = HttpApiBuilder.group(DiscoveryApi, "serverCard", (handlers) =>
  handlers.handleRaw("card", () => publicDocument(SERVER_CARD_MEDIA_TYPE, serverCard)),
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
  Layer.mergeAll(WellKnownHandlers, ServerCardHandlers, AuthMdHandlers),
);
