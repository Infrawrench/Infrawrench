/**
 * What the OAuth endpoints share: the scopes, the lifetimes, how a refusal
 * is written, and the CORS answer for the endpoints a browser-based client
 * calls itself.
 */
import type { GitTokenScope } from "@infrawrench/server-core/db/schema";

/** What a token may be granted. The same two scopes a personal access token has. */
export const OAUTH_SCOPES: readonly GitTokenScope[] = ["repo:read", "repo:write"];

export const SCOPE_DESCRIPTIONS: Readonly<Record<GitTokenScope, string>> = {
  "repo:read": "Read the repositories you can read, their branches, reviews and traces",
  "repo:write":
    "Push, record traces, answer instructions, report findings, comment and start work as you",
};

/**
 * The scopes a request asks for, among those we grant. Anything else in the
 * list is ignored (clients add `offline_access` and `openid` by habit), and a
 * request that names none of ours gets both: the server's tools are of no use
 * without them, and the consent page says what is granted.
 */
export const parseScopes = (scope: string | null | undefined): GitTokenScope[] => {
  const asked = (scope ?? "").split(/\s+/).filter(Boolean);
  const known = OAUTH_SCOPES.filter((candidate) => asked.includes(candidate));
  // Writing implies reading: a token that pushes can already fetch.
  if (known.includes("repo:write") && !known.includes("repo:read")) return [...OAUTH_SCOPES];
  return known.length > 0 ? known : [...OAUTH_SCOPES];
};

export const OAUTH_LIFETIMES = {
  /** The consent form's request: how long a person may look at the page. */
  consentSeconds: 10 * 60,
  /** An authorization code: one exchange, at once. */
  codeSeconds: 60,
  /** An access token. Short, because the client can always get another. */
  accessTokenSeconds: 60 * 60,
  /**
   * How long after its access token expires a grant can still be refreshed.
   * A client that has not been used for this long signs in again.
   */
  refreshSeconds: 30 * 24 * 60 * 60,
  /**
   * How long after a refresh an older refresh token is taken for a client
   * racing itself (two processes sharing one stored token) rather than for
   * a stolen one. It is refused either way; past this it also ends the grant.
   */
  refreshRaceSeconds: 60,
} as const;

/** When a grant whose access token expires at `expiresAt` can no longer be refreshed. */
export const grantLapsesAt = (expiresAt: Date): Date =>
  new Date(expiresAt.getTime() + OAUTH_LIFETIMES.refreshSeconds * 1000);

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_target"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "access_denied"
  | "unsupported_response_type"
  | "server_error";

/** A refusal, as RFC 6749 section 5.2 writes one. Returned, never thrown. */
export class OAuthFailure {
  constructor(
    readonly error: OAuthErrorCode,
    readonly description: string,
  ) {}
}

export const failure = (error: OAuthErrorCode, description: string): OAuthFailure =>
  new OAuthFailure(error, description);

/**
 * The endpoints a client calls with `fetch` (the metadata documents,
 * registration, the token endpoint, revocation, and `/mcp` itself) answer
 * any origin. None of them reads the session cookie, so a page elsewhere
 * can do nothing with them that it could not do from a terminal, and a
 * browser-based MCP client cannot work without it. `/oauth/authorize` is the
 * one endpoint that acts for the signed-in person, and it is a page, never
 * an answer to `fetch`: it gets none of this.
 */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
  "access-control-max-age": "86400",
};

export const preflight = (): Response => new Response(null, { status: 204, headers: CORS_HEADERS });

export const jsonAnswer = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Tokens and codes are in these answers.
      "cache-control": "no-store",
      pragma: "no-cache",
      ...CORS_HEADERS,
      ...headers,
    },
  });

export const failureAnswer = (failed: OAuthFailure, status?: number): Response =>
  jsonAnswer(
    { error: failed.error, error_description: failed.description },
    status ?? (failed.error === "invalid_client" ? 401 : 400),
  );

/** The most a request body to these endpoints is read. */
const MAX_BODY_BYTES = 64 * 1024;

/** A request's body, held to {@link MAX_BODY_BYTES}. Null when it is longer. */
export const readBounded = async (
  source: { readonly body: ReadableStream<Uint8Array> | null },
  limit = MAX_BODY_BYTES,
): Promise<string | null> => {
  if (source.body === null) return "";
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(all);
};

/**
 * The parameters of a POST to an OAuth endpoint: a form, as the RFCs say, or
 * JSON, which registration uses and some clients send everywhere. Null for a
 * body that is neither, or too long.
 */
export const readParameters = async (request: Request): Promise<Record<string, unknown> | null> => {
  const text = await readBounded(request);
  if (text === null) return null;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (type.startsWith("application/json")) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  const parameters: Record<string, unknown> = {};
  for (const [name, value] of new URLSearchParams(text)) {
    // A parameter given twice is a malformed request (RFC 6749 section 3.2).
    if (name in parameters) return null;
    parameters[name] = value;
  }
  return parameters;
};

export const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
