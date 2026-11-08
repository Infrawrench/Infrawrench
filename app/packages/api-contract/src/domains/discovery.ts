/**
 * Discovery documents at the domain root, the endpoint definitions: the OAuth
 * metadata MCP clients read before they authenticate (`/.well-known/*`) and
 * the agent registration skill document (`/auth.md`) its `agent_auth` block
 * points at.
 *
 * Public, read by clients that hold no credential yet, and never in the API
 * document: they describe how to reach the API, not part of it.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { Security } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";

/** RFC 9728 metadata, or the `server_error` 500 while discovery is unconfigured. */
const DiscoveryDocument = Schema.Unknown;

export class WellKnownGroup extends HttpApiGroup.make("wellKnown")
  .add(
    HttpApiEndpoint.get("protectedResource", "/oauth-protected-resource", {
      success: DiscoveryDocument,
    })
      .annotate(OpenApi.Summary, "OAuth protected resource metadata (RFC 9728)")
      .annotate(Security, []),
    // RFC 9728 §3.1: the path-suffixed form clients derive from the resource URL.
    HttpApiEndpoint.get("protectedResourceForMcp", "/oauth-protected-resource/api/mcp", {
      success: DiscoveryDocument,
    })
      .annotate(OpenApi.Summary, "OAuth protected resource metadata for /api/mcp")
      .annotate(Security, []),
    HttpApiEndpoint.get("authorizationServer", "/oauth-authorization-server", {
      success: HttpApiSchema.Empty(302),
    })
      .annotate(OpenApi.Summary, "Redirect to the authorization server's metadata")
      .annotate(Security, []),
  )
  .prefix("/.well-known")
  .annotate(OpenApi.Title, "MCP")
  .annotate(OpenApi.Exclude, true) {}

export class AuthMdGroup extends HttpApiGroup.make("authMd")
  .add(
    HttpApiEndpoint.get("document", "/auth.md", {
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/markdown" })),
    })
      .annotate(OpenApi.Summary, "Agent registration skill document")
      .annotate(Security, []),
  )
  .annotate(OpenApi.Title, "Agent auth")
  .annotate(OpenApi.Exclude, true) {}

export class DiscoveryApi extends withApiDefaults(
  HttpApi.make("discovery").add(WellKnownGroup).add(AuthMdGroup),
) {}
