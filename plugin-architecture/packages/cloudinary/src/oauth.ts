/**
 * "Connect with Cloudinary": the OAuth declaration and the identity hook.
 *
 * Cloudinary self-service OAuth apps (Beta;
 * cloudinary.com/documentation/using_oauth_to_access_cloudinary_apis,
 * verified 2026-10):
 *   - Created under Console > Settings > Developers > OAuth Apps (at most 10
 *     per account). Token authentication method per app: client secret basic,
 *     client secret post (default), or none (public client relying on PKCE).
 *   - Authorize `https://oauth.cloudinary.com/oauth2/auth`, token
 *     `https://oauth.cloudinary.com/oauth2/token` (an OpenID provider; its
 *     discovery document lists S256 PKCE and the `none` auth method).
 *   - Scopes are selected on the app: Upload, Asset Management, Offline
 *     Access (refresh tokens), OpenID. None is read-only; the signed-in
 *     user's role still limits what is allowed, so access is `full`. Scope
 *     IDs `asset_management` and `upload` are the ones Cloudinary's own
 *     authorization metadata advertises.
 *   - The user picks the product environment (cloud) at consent; the token
 *     is cloud-specific and is sent as `Authorization: Bearer` to
 *     `https://api.cloudinary.com/v1_1/<cloud>/...` (Admin and Upload APIs).
 *   - Access tokens live 5 minutes; refresh tokens 3 months and are single
 *     use (rotated on every refresh).
 *
 * The plugin keeps the access token in the API Secret field (the sensitive
 * field the form replaces with a "Connected" chip) and leaves the API key
 * empty; the client switches to Bearer auth for such accounts and asks the
 * host for a current token per request.
 */
import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";

export const cloudinaryOAuth: OAuthDeclaration = {
  authorizeUrl: "https://oauth.cloudinary.com/oauth2/auth",
  tokenUrl: "https://oauth.cloudinary.com/oauth2/token",
  scopes: ["asset_management", "upload", "offline_access", "openid"],
  tokenField: "apiSecret",
  clients: {
    server: { auth: "client_secret_post", pkce: true },
    desktop: { loopbackHost: "127.0.0.1" },
  },
  access: "full",
  refresh: "rotating",
  docsUrl: "https://cloudinary.com/documentation/using_oauth_to_access_cloudinary_apis",
};

const CLOUD_NAME_KEYS = ["cloud_name", "cloudName", "cloud"];

function cloudNameIn(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 2) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of CLOUD_NAME_KEYS) {
    const v = record[key];
    if (typeof v === "string" && /^[A-Za-z0-9_-]+$/.test(v.trim())) return v.trim();
  }
  for (const nested of Object.values(record)) {
    const found = cloudNameIn(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Claims of a JWT, without verifying it (only used to pre-fill a form field). */
function jwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Find the cloud the user picked at consent, to pre-fill Cloud Name: the
 * token response, then the access and ID token claims, then the token info
 * endpoint. Cloudinary does not document where the cloud name appears, so
 * each source is tried and the user fills the field in if none has it.
 */
export async function completeCloudinaryOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  let cloudName =
    cloudNameIn(tokens.raw) ??
    cloudNameIn(jwtClaims(tokens.accessToken)) ??
    cloudNameIn(jwtClaims(tokens.raw["id_token"]));
  if (!cloudName) {
    try {
      const res = await context.fetch("https://api.cloudinary.com/v1_1/token/info", {
        headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
      });
      if (res.ok) cloudName = cloudNameIn(await res.json());
    } catch {
      // Left for the user to fill in.
    }
  }
  // An OAuth account has no API key: clearing one typed before connecting
  // keeps the client on Bearer auth even where the grant state is stripped.
  return cloudName
    ? { credentials: { cloudName, apiKey: "" }, accountName: cloudName }
    : { credentials: { apiKey: "" } };
}
