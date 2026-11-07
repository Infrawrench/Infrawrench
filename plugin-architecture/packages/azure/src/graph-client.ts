/**
 * Thin wrapper around `@microsoft/microsoft-graph-client` that plugs the
 * existing token cache (`fetchGraphAccessToken` via the AzureClient's
 * `graphToken()` helper) into the SDK's `AuthenticationProvider` contract.
 *
 * We construct a fresh `Client` per call: the SDK is cheap to instantiate and
 * stateless apart from the auth provider. Callers can either share a single
 * `Client` for a sequence of requests, or call `makeGraphClient(...)` once per
 * call site.
 */
import { hostFetch, type HttpHostServices } from "@infrawrench/plugin-base";
import {
  AuthenticationHandler,
  Client,
  CustomAuthenticationProvider,
  RetryHandler,
  type AuthProvider,
  type Context,
  type Middleware,
} from "@microsoft/microsoft-graph-client";

interface GraphTokenProvider {
  graphToken(): Promise<string>;
}

/**
 * Build a Microsoft Graph SDK client whose `AuthenticationProvider` defers to
 * the supplied token provider. The token provider is expected to handle
 * caching and refresh itself (the AzureClient already wraps
 * `fetchGraphAccessToken` in a per-instance cache).
 */
export function makeGraphClient(
  tokenProvider: GraphTokenProvider,
  http?: HttpHostServices,
): Client {
  const authProvider: AuthProvider = (done) => {
    tokenProvider
      .graphToken()
      .then((token) => done(null, token))
      .catch((err) => done(err as Error, null));
  };
  if (!http) return Client.init({ authProvider });

  const auth = new AuthenticationHandler(new CustomAuthenticationProvider(authProvider));
  const retry = new RetryHandler();
  auth.setNext(retry);
  retry.setNext(hostHandler(http));
  return Client.initWithMiddleware({ middleware: auth });
}

/** The end of the SDK's middleware chain: its requests, through the host's HTTP service. */
function hostHandler(http: HttpHostServices): Middleware {
  return {
    execute: async (context: Context) => {
      const { request, options } = context;
      const url = typeof request === "string" ? request : request.url;
      context.response = await hostFetch({ http }, url, options);
    },
  };
}
