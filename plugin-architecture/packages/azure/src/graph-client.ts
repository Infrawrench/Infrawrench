/**
 * Thin wrapper around `@microsoft/microsoft-graph-client` that plugs the
 * existing token cache (`fetchGraphAccessToken` via the AzureClient's
 * `graphToken()` helper) into the SDK's `AuthenticationProvider` contract.
 *
 * We construct a fresh `Client` per call — the SDK is cheap to instantiate and
 * stateless apart from the auth provider. Callers can either share a single
 * `Client` for a sequence of requests, or call `makeGraphClient(...)` once per
 * call site.
 */
import { Client } from "@microsoft/microsoft-graph-client";

interface GraphTokenProvider {
  graphToken(): Promise<string>;
}

/**
 * Build a Microsoft Graph SDK client whose `AuthenticationProvider` defers to
 * the supplied token provider. The token provider is expected to handle
 * caching and refresh itself (the AzureClient already wraps
 * `fetchGraphAccessToken` in a per-instance cache).
 */
export function makeGraphClient(tokenProvider: GraphTokenProvider): Client {
  return Client.init({
    authProvider: (done) => {
      tokenProvider
        .graphToken()
        .then((token) => done(null, token))
        .catch((err) => done(err as Error, null));
    },
  });
}
