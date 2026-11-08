/**
 * Provider OAuth's GUI wiring, imported by `main.ts` for its side effects:
 * the `infrawrench://provider-oauth` links that finish a cloud flow, and the
 * local accounts' status changes the sidebar and account page follow. The
 * flows themselves are `./connect.ts`.
 */
import { registerProtocolRoute } from "../cloud-auth";
import { deliverProviderOAuthResult, publishOAuthStatus } from "./connect";
import { PROVIDER_OAUTH_DEEP_LINK_HOST, parseProviderOAuthDeepLink } from "./deep-link";
import { setOAuthStatusListener } from "./local-accounts";

registerProtocolRoute(PROVIDER_OAUTH_DEEP_LINK_HOST, (url) => {
  const payload = parseProviderOAuthDeepLink(url);
  if (!payload) {
    console.warn("[provider-oauth] ignored a malformed provider-oauth link");
    return;
  }
  if (!deliverProviderOAuthResult(payload)) {
    console.warn("[provider-oauth] ignored a provider-oauth result nothing was waiting for");
  }
});

// A refresh that the provider rejected (or a successful reconnect) changes
// what the sidebar and account page should show.
setOAuthStatusListener((accountId, status) => publishOAuthStatus({ accountId, status }));
