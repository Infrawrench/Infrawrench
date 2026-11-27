/**
 * `/mcp`: the MCP server over Streamable HTTP.
 *
 * - **Stateless.** Every POST is one JSON-RPC message answered by a fresh
 *   server instance; there are no sessions, no GET stream and nothing kept
 *   between requests. Both protocol eras are served: the current one
 *   (2026-07-28: the per-request `_meta` envelope, `server/discover`, the
 *   `Mcp-Method` and `Mcp-Name` header checks) by the SDK's handler, and the
 *   earlier `initialize` handshake by its stateless transport. Each answer is
 *   one JSON body, complete when it is returned, which is what lets the whole
 *   exchange run inside one database invocation (`mount.ts`).
 * - **A bearer token and nothing else.** The credential is the
 *   `Authorization` header: a token an OAuth client was granted, a personal
 *   access token, an organisation's API key or a CI job's token. The session
 *   cookie is never read here, whatever the browser sent, so a page on
 *   another site that makes a browser call this endpoint acts as nobody.
 * - **Any origin may call it**, for that reason (`oauth/protocol.ts`
 *   `CORS_HEADERS`): a browser-based MCP client needs to, and there is no
 *   ambient authority for a foreign page to borrow. The specification's
 *   `Origin` check exists for servers on a local network, which a page could
 *   reach by rebinding a name; this one is on the public internet behind TLS.
 *   An `Origin` that is not an origin at all is still a 403.
 * - **No credential is a 401 that says where to get one** (RFC 9728): the
 *   `WWW-Authenticate` header names the resource metadata, and a client
 *   follows it to `/oauth/authorize`.
 */
import {
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import type { Authenticated } from "../auth/authenticate";
import type { Principal } from "../auth/principal";
import { describeError } from "../http/log";
import { type ApiHandle, inProcessApi } from "./api";
import { bearerChallenge } from "./oauth/metadata";
import { CORS_HEADERS, preflight, readBounded } from "./oauth/protocol";
import { type ServerContext, buildMcpServer } from "./server";

/** The most of a JSON-RPC message that is read: a hundred trace entries with their output fit several times. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export interface McpDeps {
  /** The site's origin: what links and the 401's challenge are built from. */
  readonly origin: string;
  /** Resolves a request that carries only an `Authorization` header. */
  readonly authenticate: (request: Request) => Promise<Authenticated>;
  /** Counts the call against whoever it authenticated as. The 429, or null. */
  readonly admit: (principal: Principal) => Promise<Response | null>;
  /** The forge's JSON API, in this process. */
  readonly api: ApiHandle;
}

const withCors = (response: Response): Response => {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  // Every answer depends on the credential.
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const rpcError = (
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response =>
  withCors(
    new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  );

/** An `Origin` header that is one: absent, `null` (a sandboxed page), or `scheme://host[:port]`. */
const originIsOne = (origin: string | null): boolean => {
  if (origin === null || origin === "null") return true;
  try {
    return new URL(origin).origin === origin;
  } catch {
    return false;
  }
};

/** A client's name from its `User-Agent`'s first product (`claude-code/2.1.0` is `claude-code`). */
export const clientNameOf = (userAgent: string | null): string | null => {
  const product = /^([A-Za-z0-9][A-Za-z0-9 ._-]{0,63}?)(?:\/|$)/.exec(userAgent ?? "")?.[1];
  // What every HTTP library sends says nothing about the agent.
  return product && !/^(mozilla|node|undici|python|curl|go-http-client|axios)$/i.test(product)
    ? product
    : null;
};

export const handleMcp = async (request: Request, deps: McpDeps): Promise<Response> => {
  if (request.method === "OPTIONS") return preflight();
  if (!originIsOne(request.headers.get("origin"))) {
    return rpcError(403, -32000, "That Origin is not valid");
  }

  const authorization = request.headers.get("authorization");
  if (authorization === null || authorization.trim() === "") {
    return rpcError(401, -32001, "Sign in to use this server", {
      "www-authenticate": bearerChallenge(deps.origin),
    });
  }
  // Only the header: no cookie, and none of the browser's own headers, so
  // what authenticates here is exactly what the client chose to send.
  const auth = await deps.authenticate(
    new Request(request.url, { method: "GET", headers: { authorization } }),
  );
  if (auth.refused || auth.principal.kind === "anonymous") {
    return rpcError(401, -32001, "That credential was not accepted", {
      "www-authenticate": bearerChallenge(deps.origin, {
        error: "invalid_token",
        description: "The access token is expired, revoked or malformed",
      }),
    });
  }
  const limited = await deps.admit(auth.principal);
  if (limited !== null) return withCors(limited);

  if (request.method !== "POST") {
    // No sessions and no standalone stream: there is nothing to GET or DELETE.
    return rpcError(405, -32000, "Method not allowed.", { allow: "POST, OPTIONS" });
  }
  const text = await readBounded(request, MAX_MESSAGE_BYTES);
  if (text === null) return rpcError(413, -32600, "The message is too large");
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    return rpcError(400, -32700, "Parse error");
  }

  const cx: ServerContext = {
    api: inProcessApi(deps.api, deps.origin, authorization),
    principal: auth.principal,
    origin: deps.origin,
    fallbackClientName: clientNameOf(request.headers.get("user-agent")),
  };
  // The SDK is handed the message already parsed, and a request without the
  // credential: nothing below this needs it.
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  const forwarded = new Request(request.url, { method: "POST", headers, body: text });

  try {
    if (await isLegacyRequest(forwarded.clone(), parsedBody)) {
      // 2025-era clients (the `initialize` handshake), served without a
      // session: each message gets its own instance and one JSON answer.
      const server = buildMcpServer(cx);
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      try {
        return withCors(await transport.handleRequest(forwarded, { parsedBody }));
      } finally {
        void transport.close();
        void server.close();
      }
    }
    const modern = createMcpHandler(() => buildMcpServer(cx), {
      legacy: "reject",
      // One JSON body, complete when returned: no tool here sends progress.
      responseMode: "json",
      onerror: (error) => console.error(`[git] mcp: ${describeError(error)}`),
    });
    return withCors(await modern.fetch(forwarded, { parsedBody }));
  } catch (error) {
    console.error(`[git] mcp request failed: ${describeError(error)}`);
    return rpcError(500, -32603, "Internal error");
  }
};
