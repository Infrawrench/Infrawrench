/**
 * The OAuth endpoints a client calls itself, and the two documents that
 * tell it where they are: `/oauth/register`, `/oauth/token`,
 * `/oauth/revoke`, `/.well-known/oauth-protected-resource` and
 * `/.well-known/oauth-authorization-server`.
 *
 * None of them reads the session cookie or any other ambient credential, so
 * they answer any origin (`protocol.ts` `CORS_HEADERS`). What each takes is
 * in its body, and what proves an exchange is the code with its PKCE
 * verifier, or the refresh token.
 */
import { MCP_PATH, WELL_KNOWN_PATHS } from "@infrawrench/git-contract";
import { type RegistrationOptions, registerClient } from "./clients";
import { type GrantDeps, exchangeCode, refreshGrant, revokeGrant } from "./grants";
import { authorizationServerMetadata, isOurResource, protectedResourceMetadata } from "./metadata";
import {
  CORS_HEADERS,
  OAuthFailure,
  failure,
  failureAnswer,
  jsonAnswer,
  preflight,
  readParameters,
  text,
} from "./protocol";

const methodNotAllowed = (allow: string): Response =>
  new Response("Method Not Allowed\n", { status: 405, headers: { allow, ...CORS_HEADERS } });

const UNREADABLE = failure("invalid_request", "The request body was not understood");

/** `POST /oauth/register` (RFC 7591). */
export const handleRegister = async (
  request: Request,
  options: RegistrationOptions,
): Promise<Response> => {
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "POST") return methodNotAllowed("POST, OPTIONS");
  const metadata = await readParameters(request);
  if (metadata === null) return failureAnswer(failure("invalid_client_metadata", "Send JSON"));
  const registered = await registerClient(metadata, options);
  return registered instanceof OAuthFailure
    ? failureAnswer(registered)
    : jsonAnswer(registered, 201);
};

export interface TokenDeps extends GrantDeps {
  /** The site's origin, to check `resource` against. */
  readonly origin: string;
}

/** `POST /oauth/token`: a code for tokens, or a refresh token for the next ones. */
export const handleToken = async (request: Request, deps: TokenDeps): Promise<Response> => {
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "POST") return methodNotAllowed("POST, OPTIONS");
  const form = await readParameters(request);
  if (form === null) return failureAnswer(UNREADABLE);

  const clientId = text(form["client_id"]);
  if (clientId === null || clientId === "") {
    return failureAnswer(failure("invalid_request", "client_id is required"), 400);
  }
  const resource = text(form["resource"]);
  if (resource !== null && !isOurResource(resource, deps.origin)) {
    return failureAnswer(failure("invalid_target", "resource is not this server"));
  }

  const grantType = text(form["grant_type"]);
  if (grantType === "authorization_code") {
    const code = text(form["code"]);
    const codeVerifier = text(form["code_verifier"]);
    if (code === null || codeVerifier === null) {
      return failureAnswer(failure("invalid_request", "code and code_verifier are required"));
    }
    const answer = await exchangeCode(
      { code, codeVerifier, clientId, redirectUri: text(form["redirect_uri"]) },
      deps,
    );
    return answer instanceof OAuthFailure ? failureAnswer(answer) : jsonAnswer(answer);
  }
  if (grantType === "refresh_token") {
    const refreshToken = text(form["refresh_token"]);
    if (refreshToken === null) {
      return failureAnswer(failure("invalid_request", "refresh_token is required"));
    }
    const answer = await refreshGrant({ refreshToken, clientId }, deps);
    return answer instanceof OAuthFailure ? failureAnswer(answer) : jsonAnswer(answer);
  }
  return failureAnswer(
    failure("unsupported_grant_type", "grant_type is authorization_code or refresh_token"),
  );
};

/** `POST /oauth/revoke` (RFC 7009): 200 whether or not the token was one of ours. */
export const handleRevoke = async (request: Request, deps: GrantDeps): Promise<Response> => {
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "POST") return methodNotAllowed("POST, OPTIONS");
  const form = await readParameters(request);
  if (form === null) return failureAnswer(UNREADABLE);
  const token = text(form["token"]);
  if (token === null || token === "") {
    return failureAnswer(failure("invalid_request", "token is required"));
  }
  await revokeGrant(token, deps);
  return jsonAnswer({});
};

const document = (request: Request, body: unknown): Response => {
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET, HEAD, OPTIONS");
  }
  const answer = jsonAnswer(body, 200, { "cache-control": "public, max-age=3600" });
  return request.method === "HEAD"
    ? new Response(null, { status: answer.status, headers: answer.headers })
    : answer;
};

/**
 * `/.well-known/...`. The two documents, at the paths the specifications
 * name: the resource's at its well-known path and at that path with `/mcp`
 * after it (RFC 9728 section 3.1), the authorization server's at its own
 * (and with `/mcp` after it, where a client that takes the resource for the
 * issuer looks). Anything else under `/.well-known` is a JSON 404, never the
 * UI's page, which a client would try to parse.
 */
export const handleWellKnown = (request: Request, origin: string): Response => {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (
    path === WELL_KNOWN_PATHS.protectedResource ||
    path === `${WELL_KNOWN_PATHS.protectedResource}${MCP_PATH}`
  ) {
    return document(request, protectedResourceMetadata(origin));
  }
  if (
    path === WELL_KNOWN_PATHS.authorizationServer ||
    path === `${WELL_KNOWN_PATHS.authorizationServer}${MCP_PATH}`
  ) {
    return document(request, authorizationServerMetadata(origin));
  }
  return jsonAnswer({ error: "not_found" }, 404);
};
