/**
 * Signing in to Infrawrench Cloud from the GUI: the PKCE flow's state, the
 * protocol callback that finishes it, and the `CloudAuth` service the RPC
 * handlers serve (`shared/rpc/groups/cloud-auth.ts`).
 *
 * No import-time side effects: the protocol registration and single-instance
 * lock that route the callback here live in `cloud-auth.ts`, which only
 * `main.ts` imports. Token storage and refresh are `cloud-tokens.ts`, shared
 * with the CLI.
 */
import crypto from "node:crypto";
import { shell } from "electron";
import { Context, Effect, Layer, Predicate, Queue, Stream } from "effect";
import { CloudRequestError } from "../shared/rpc/errors";
import type { CloudAuthFailure, CloudAuthStatus } from "../shared/rpc/groups/cloud-auth";
import { CLOUD_URL, PROTOCOL } from "../env";
import {
  buildAuthorizeUrl,
  createPkceChallenge,
  exchangeAuthorizationCode,
  fetchCloudOrgs,
  forceRefreshAccessToken,
  getAccessToken,
  getAuthStatus,
} from "./cloud-tokens";

const subscribers = new Set<(failure: CloudAuthFailure) => void>();

/** Tell every subscribed window a sign-in failed (`setAuthErrorNotifier` and the callback). */
export function notifyAuthError(code: string, message: string): void {
  for (const subscriber of subscribers) subscriber({ code, message });
}

let codeVerifier: string | null = null;
let oauthState: string | null = null;

function startOAuthFlow(): void {
  const challenge = createPkceChallenge();
  codeVerifier = challenge.codeVerifier;
  // Without `state`, any infrawrench:// URL with a valid code would be
  // accepted: CSRF against the custom protocol handler.
  oauthState = challenge.state;
  void shell.openExternal(buildAuthorizeUrl(challenge, `${PROTOCOL}://callback`));
}

/** `infrawrench://callback?code=…&state=…`: finish the flow `CloudAuthStart` began. */
export async function handleOAuthCallback(callbackUrl: string): Promise<void> {
  const url = new URL(callbackUrl);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || !codeVerifier || !oauthState) {
    console.error("[cloud-auth] Missing code, verifier, or state");
    notifyAuthError("missing-code", "Sign-in callback missing code or verifier");
    return;
  }
  if (
    !returnedState ||
    returnedState.length !== oauthState.length ||
    !crypto.timingSafeEqual(Buffer.from(returnedState), Buffer.from(oauthState))
  ) {
    console.error("[cloud-auth] OAuth state mismatch, refusing callback");
    notifyAuthError("state-mismatch", "Sign-in callback rejected (state mismatch)");
    codeVerifier = null;
    oauthState = null;
    return;
  }

  try {
    await exchangeAuthorizationCode(code, codeVerifier);
  } catch (e) {
    console.error("[cloud-auth] Token exchange error:", e);
    notifyAuthError("token-exchange", e instanceof Error ? e.message : String(e));
  } finally {
    codeVerifier = null;
    oauthState = null;
  }
}

/** A short-lived single-use token for `?token=` on the WebSocket upgrade URL. */
async function mintWsToken(orgId: string): Promise<string | null> {
  let accessToken = await getAccessToken();
  if (!accessToken) return null;
  const url = `${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}/ws-token`;
  const headers = (t: string) => ({
    Authorization: `Bearer ${t}`,
    "Content-Type": "application/json",
  });
  let res = await fetch(url, { method: "POST", headers: headers(accessToken) });
  if (res.status === 401) {
    const refreshed = await forceRefreshAccessToken();
    if (!refreshed) return null;
    accessToken = refreshed;
    res = await fetch(url, { method: "POST", headers: headers(accessToken) });
  }
  if (!res.ok) return null;
  const body: unknown = await res.json();
  return Predicate.hasProperty(body, "token") && Predicate.isString(body.token) ? body.token : null;
}

export class CloudAuth extends Context.Service<
  CloudAuth,
  {
    readonly start: Effect.Effect<void>;
    readonly status: Effect.Effect<CloudAuthStatus>;
    readonly orgs: Effect.Effect<
      Array<{ id: string; displayName: string; role: string }>,
      CloudRequestError
    >;
    readonly url: Effect.Effect<string>;
    readonly wsToken: (orgId: string) => Effect.Effect<string | null, CloudRequestError>;
    readonly failures: Stream.Stream<CloudAuthFailure>;
  }
>()("infrawrench/desktop/CloudAuth") {
  static readonly layer = Layer.succeed(CloudAuth)(
    CloudAuth.of({
      start: Effect.sync(startOAuthFlow),
      status: Effect.promise(() => getAuthStatus()).pipe(
        Effect.map(({ authenticated, email, organizationId }): CloudAuthStatus => ({
          authenticated,
          ...(email !== undefined ? { email } : {}),
          ...(organizationId !== undefined ? { organizationId } : {}),
        })),
      ),
      orgs: Effect.tryPromise({ try: () => fetchCloudOrgs(), catch: CloudRequestError.fromCause }),
      url: Effect.succeed(CLOUD_URL),
      wsToken: (orgId) =>
        Effect.tryPromise({ try: () => mintWsToken(orgId), catch: CloudRequestError.fromCause }),
      failures: Stream.callback<CloudAuthFailure>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const subscriber = (failure: CloudAuthFailure) => {
              Queue.offerUnsafe(queue, failure);
            };
            subscribers.add(subscriber);
            return subscriber;
          }),
          (subscriber) => Effect.sync(() => subscribers.delete(subscriber)),
        ),
      ),
    }),
  );
}
