/**
 * The desktop's one authenticated transport to Infrawrench Cloud, behind the
 * `CloudHttp` RPC (`shared/rpc/groups/cloud-http.ts`).
 *
 * The renderer sends a request it built from the endpoint's contract
 * definition; this module owns the parts a renderer must never hold:
 *
 * - **The allowlist** (`cloud-allowlist.ts`): a method+path outside the
 *   registered contract domains and the Settings surface is refused here.
 * - **The session**: the bearer token from `cloud-tokens.ts`, and one forced
 *   refresh and retry on a 401.
 * - **`CLOUD_URL`**: requests carry a path, never an origin.
 * - **SSH host keys**: a 409 `ssh_host_key_trust_required` (the contract's
 *   `SshHostKeyTrustRequired`) asks the user through the host-key prompt; on
 *   accept the key is trusted with `POST /ssh-host-keys/trust` and the request
 *   is sent once more. A refused prompt, or a trust that fails, answers with
 *   that response instead of looping.
 *
 * Whatever the server finally answers is returned as status and text, so the
 * caller decides what a status means. It imports `cloud-tokens.ts` directly
 * (not `cloud-auth.ts`, which registers the protocol and takes the
 * single-instance lock), so it has no import-time side effects.
 */
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";
import { SshHostKeyTrustRequired, type TrustHostKeyInput } from "@infrawrench/api-contract";
import { CLOUD_URL } from "../env";
import { CloudRequestError } from "../shared/rpc/errors";
import type { CloudHttpRequest, CloudHttpResponse } from "../shared/rpc/groups/cloud-http";
import { isAllowedCloudRequest } from "./cloud-allowlist";
import { forceRefreshAccessToken, getAccessToken } from "./cloud-tokens";
import { promptHostKeyDecision } from "./ssh-host-key-prompt";

const refused = (message: string) => () => new CloudRequestError({ message });

const accessToken = Effect.tryPromise({
  try: () => getAccessToken(),
  catch: CloudRequestError.fromCause,
}).pipe(Effect.filterOrFail(Predicate.isString, refused("Not authenticated to Infrawrench Cloud")));

const refreshedToken = Effect.tryPromise({
  try: () => forceRefreshAccessToken(),
  catch: CloudRequestError.fromCause,
}).pipe(
  Effect.filterOrFail(Predicate.isString, refused("Authentication expired; please sign in again")),
);

/** One `fetch` of `request` under the cloud origin, cancelled if the caller is interrupted. */
const send = (request: CloudHttpRequest, token: string) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(`${CLOUD_URL}${request.url}`, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(request.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal,
      }),
    catch: CloudRequestError.fromCause,
  });

/** `request` with the session's token, refreshed and sent again once on a 401. */
const sendAuthenticated = Effect.fnUntraced(function* (request: CloudHttpRequest) {
  const response = yield* send(request, yield* accessToken);
  if (response.status !== 401) return response;
  return yield* send(request, yield* refreshedToken);
});

const readText = (response: Response) =>
  Effect.tryPromise({ try: () => response.text(), catch: CloudRequestError.fromCause });

const decodeTrustRequired = Schema.decodeUnknownOption(
  Schema.fromJsonString(SshHostKeyTrustRequired),
);

/** The org a path is under, for the trust route; none for `/api/profile` and the like. */
const orgOf = (url: string) => /^\/api\/org\/([^/?]+)\//.exec(url)?.[1];

/**
 * The answer to `request` after any SSH host-key prompt it asked for: the
 * first answer, or the retry's once the user trusted the key.
 */
const answerHostKeyPrompt = Effect.fnUntraced(function* (
  request: CloudHttpRequest,
  response: Response,
  body: string,
) {
  const orgId = orgOf(request.url);
  if (response.status !== 409 || orgId === undefined) return { status: response.status, body };
  const trustRequired = decodeTrustRequired(body);
  if (Option.isNone(trustRequired)) return { status: response.status, body };
  const prompt = trustRequired.value;

  const accepted = yield* Effect.promise(() =>
    promptHostKeyDecision({
      host: prompt.host,
      port: prompt.port,
      kind: prompt.kind === "unknown" ? "first-connect" : "mismatch",
      presentedFingerprint: prompt.presentedFingerprint,
      ...(prompt.storedFingerprint ? { storedFingerprint: prompt.storedFingerprint } : {}),
    }),
  );
  if (!accepted) return { status: response.status, body };

  const trust: typeof TrustHostKeyInput.Encoded = {
    host: prompt.host,
    port: prompt.port,
    fingerprint: prompt.presentedFingerprint,
    ...(prompt.storedFingerprint ? { previousFingerprint: prompt.storedFingerprint } : {}),
  };
  const trusted = yield* sendAuthenticated({
    method: "POST",
    url: `/api/org/${orgId}/ssh-host-keys/trust`,
    body: JSON.stringify(trust),
  });
  // A trust that failed (raced and 409'd again, or was refused) is the answer.
  if (!trusted.ok) return { status: trusted.status, body: yield* readText(trusted) };

  const retried = yield* sendAuthenticated(request);
  return { status: retried.status, body: yield* readText(retried) };
});

export class CloudTransport extends Context.Service<
  CloudTransport,
  {
    readonly request: (
      request: CloudHttpRequest,
    ) => Effect.Effect<CloudHttpResponse, CloudRequestError>;
  }
>()("infrawrench/desktop/CloudTransport") {
  static readonly layer = Layer.succeed(CloudTransport)(
    CloudTransport.of({
      request: Effect.fn("CloudTransport.request")(function* (request) {
        if (!isAllowedCloudRequest(request.method, request.url)) {
          return yield* new CloudRequestError({
            message: `Cloud request refused: ${request.method} ${request.url} is not on the desktop's cloud API surface`,
          });
        }
        const response = yield* sendAuthenticated(request);
        return yield* answerHostKeyPrompt(request, response, yield* readText(response));
      }),
    }),
  );
}
