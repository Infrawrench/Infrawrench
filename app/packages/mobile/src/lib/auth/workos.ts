import * as AuthSession from "expo-auth-session";
import { CLIENT_ID, WORKOS_API_URL } from "../../../env";

/**
 * WorkOS AuthKit OAuth+PKCE via expo-auth-session. WorkOS has no discovery
 * document at the client level, so endpoints are specified manually — same
 * URLs the desktop's `buildAuthorizeUrl`/`exchangeAuthorizationCode` hit.
 * expo-auth-session generates and stores the PKCE verifier; the code exchange
 * itself goes through client-core's TokenManager so token persistence and
 * refresh single-flighting stay in one place.
 */

export const workosDiscovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: `${WORKOS_API_URL}/user_management/authorize`,
  tokenEndpoint: `${WORKOS_API_URL}/user_management/authenticate`,
};

/** Must be registered as a redirect URI on the WorkOS client. */
export const redirectUri = AuthSession.makeRedirectUri({
  scheme: "infrawrench",
  path: "auth/callback",
});

export function createAuthRequest(): AuthSession.AuthRequest {
  return new AuthSession.AuthRequest({
    clientId: CLIENT_ID,
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
    scopes: [],
    extraParams: { provider: "authkit" },
  });
}
