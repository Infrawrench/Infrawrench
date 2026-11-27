/**
 * WorkOS AuthKit over its REST API: the four calls sign-in needs.
 *
 * The app uses `@workos-inc/node`, which does run on Workers (it ships an
 * `index.worker` build, and the web edge Worker loads it). This worker calls
 * the endpoints directly instead: the same four requests the SDK would make,
 * with no SDK in the bundle, no `jose`, and no iron-sealed session whose
 * format is the SDK's to change. The request shapes below are the SDK's own
 * (`@workos-inc/node` 8.13, `user_management/authenticate` and friends).
 *
 * `fetch` is a parameter everywhere so tests answer for WorkOS.
 */
import type { Env } from "../env";
import { siteOrigin } from "../env";

export interface WorkosConfig {
  /** `https://api.workos.com`, or the custom Authentication API domain. No trailing slash. */
  readonly baseUrl: string;
  readonly clientId: string;
  /** The API key, sent as `client_secret` on token exchanges and as the bearer elsewhere. */
  readonly apiKey: string;
  /** `https://git.infrawrench.com/auth/callback`: must be registered in the WorkOS dashboard. */
  readonly redirectUri: string;
}

export const DEFAULT_WORKOS_HOSTNAME = "api.workos.com";
export const CALLBACK_PATH = "/auth/callback";

export const workosConfig = (
  env: Pick<Env, "WORKOS_API_KEY" | "WORKOS_CLIENT_ID" | "WORKOS_API_HOSTNAME" | "SITE_ORIGIN">,
): WorkosConfig => {
  if (!env.WORKOS_API_KEY) throw new Error("WORKOS_API_KEY is required");
  if (!env.WORKOS_CLIENT_ID) throw new Error("WORKOS_CLIENT_ID is required");
  const hostname = env.WORKOS_API_HOSTNAME?.trim() || DEFAULT_WORKOS_HOSTNAME;
  return {
    // A hostname with a port (the WorkOS emulator in local development) is
    // plain HTTP; everything else is HTTPS.
    baseUrl: /:\d+$/.test(hostname) ? `http://${hostname}` : `https://${hostname}`,
    clientId: env.WORKOS_CLIENT_ID,
    apiKey: env.WORKOS_API_KEY,
    redirectUri: `${siteOrigin(env)}${CALLBACK_PATH}`,
  };
};

/** Where to send a browser to sign in: `GET /user_management/authorize`. */
export const authorizationUrl = (config: WorkosConfig, state: string): string => {
  const url = new URL("/user_management/authorize", config.baseUrl);
  url.searchParams.set("provider", "authkit");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
};

/** The JWKS that verifies this client's access tokens. */
export const jwksUrl = (config: WorkosConfig): string =>
  new URL(`/sso/jwks/${encodeURIComponent(config.clientId)}`, config.baseUrl).toString();

/** Where to send a browser to end its WorkOS session. `returnTo` must be registered as a sign-out redirect. */
export const logoutUrl = (config: WorkosConfig, sessionId: string, returnTo?: string): string => {
  const url = new URL("/user_management/sessions/logout", config.baseUrl);
  url.searchParams.set("session_id", sessionId);
  if (returnTo !== undefined) url.searchParams.set("return_to", returnTo);
  return url.toString();
};

/** A WorkOS user, as much of one as provisioning reads. */
export interface WorkosUser {
  readonly id: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly profilePictureUrl: string | null;
}

export interface WorkosAuthentication {
  readonly user: WorkosUser;
  readonly accessToken: string;
  readonly refreshToken: string;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const parseUser = (value: unknown): WorkosUser | null => {
  if (typeof value !== "object" || value === null) return null;
  const user = value as Record<string, unknown>;
  const id = text(user["id"]);
  const email = text(user["email"]);
  if (id === null || email === null) return null;
  return {
    id,
    email,
    firstName: text(user["first_name"]),
    lastName: text(user["last_name"]),
    profilePictureUrl: text(user["profile_picture_url"]),
  };
};

const parseAuthentication = (value: unknown): WorkosAuthentication | null => {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const user = parseUser(body["user"]);
  const accessToken = text(body["access_token"]);
  const refreshToken = text(body["refresh_token"]);
  if (!user || accessToken === null || refreshToken === null) return null;
  return { user, accessToken, refreshToken };
};

/** Why a WorkOS call did not answer with what was asked for. Never carries a token or the API key. */
export class WorkosError extends Error {
  readonly status: number;
  /** WorkOS's own error code (`invalid_grant`), when it sent one. */
  readonly code: string | null;
  constructor(operation: string, status: number, code: string | null) {
    super(`WorkOS ${operation} failed (${status}${code ? `, ${code}` : ""})`);
    this.name = "WorkosError";
    this.status = status;
    this.code = code;
  }
}

const authenticate = async (
  config: WorkosConfig,
  operation: string,
  grant: Record<string, string>,
  context: RequestContext,
  fetcher: typeof fetch,
): Promise<WorkosAuthentication> => {
  const response = await fetcher(new URL("/user_management/authenticate", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      ...grant,
      client_id: config.clientId,
      client_secret: config.apiKey,
      ...(context.ipAddress ? { ip_address: context.ipAddress } : {}),
      ...(context.userAgent ? { user_agent: context.userAgent } : {}),
    }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      typeof body === "object" && body !== null
        ? (text((body as Record<string, unknown>)["error"]) ??
          text((body as Record<string, unknown>)["code"]))
        : null;
    throw new WorkosError(operation, response.status, code);
  }
  const authentication = parseAuthentication(body);
  if (!authentication) throw new WorkosError(operation, response.status, "unexpected_response");
  return authentication;
};

/** What WorkOS records beside a session, for the person's own session list. */
export interface RequestContext {
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

/** Exchange the callback's `code` for tokens: `grant_type=authorization_code`. */
export const exchangeCode = (
  config: WorkosConfig,
  code: string,
  context: RequestContext = {},
  fetcher: typeof fetch = fetch,
): Promise<WorkosAuthentication> =>
  authenticate(
    config,
    "code exchange",
    { grant_type: "authorization_code", code },
    context,
    fetcher,
  );

/**
 * Exchange a refresh token for new tokens: `grant_type=refresh_token`. The
 * refresh token is single use: the answer carries its replacement, and the
 * old one stops working, so the new session must reach the browser.
 */
export const refreshTokens = (
  config: WorkosConfig,
  refreshToken: string,
  context: RequestContext = {},
  fetcher: typeof fetch = fetch,
): Promise<WorkosAuthentication> =>
  authenticate(
    config,
    "refresh",
    { grant_type: "refresh_token", refresh_token: refreshToken },
    context,
    fetcher,
  );

/** `GET /user_management/users/:id`, for a token whose claims carry no email. */
export const getUser = async (
  config: WorkosConfig,
  userId: string,
  fetcher: typeof fetch = fetch,
): Promise<WorkosUser | null> => {
  const response = await fetcher(
    new URL(`/user_management/users/${encodeURIComponent(userId)}`, config.baseUrl),
    { headers: { authorization: `Bearer ${config.apiKey}`, accept: "application/json" } },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new WorkosError("get user", response.status, null);
  return parseUser(await response.json().catch(() => null));
};
