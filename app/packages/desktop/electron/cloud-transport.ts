/**
 * The desktop's one authenticated transport to Infrawrench Cloud, behind the
 * `CloudHttp` and `CloudHttpBytes` RPCs (`shared/rpc/groups/cloud-http.ts`).
 *
 * The renderer sends a request it built from the endpoint's contract
 * definition; this module owns the parts a renderer must never hold:
 *
 * - **The allowlist** (`cloud-allowlist.ts`): a method+path outside the
 *   registered contract domains' authenticated endpoints and the Settings
 *   surface is refused here, and so is any request header the matched
 *   endpoint does not declare.
 * - **The session**: the bearer token from `cloud-tokens.ts`, and one forced
 *   refresh and retry on a 401.
 * - **`CLOUD_URL`**: requests carry a path, never an origin.
 * - **SSH host keys**: a 409 `ssh_host_key_trust_required` (the contract's
 *   `SshHostKeyTrustRequired`) asks the user through the host-key prompt; on
 *   accept the key is trusted with `POST /ssh-host-keys/trust` and the request
 *   is sent once more. A refused prompt, or a trust that fails, answers with
 *   that response instead of looping.
 *
 * Whatever the server finally answers is returned as status and body (text,
 * or bytes for `requestBytes`), so the caller decides what a status means. It imports `cloud-tokens.ts` directly
 * (not `cloud-auth.ts`, which registers the protocol and takes the
 * single-instance lock), so it has no import-time side effects.
 */
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";
import { SshHostKeyTrustRequired, type TrustHostKeyInput } from "@infrawrench/api-contract";
import { CLOUD_URL } from "../env";
import { CloudRequestError } from "../shared/rpc/errors";
import type {
  CloudHttpBytesResponse,
  CloudHttpRequest,
  CloudHttpResponse,
} from "../shared/rpc/groups/cloud-http";
import { allowedCloudRequestHeaders } from "./cloud-allowlist";
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
          // The endpoint's declared headers first, so nothing they carry can
          // stand in for the two the transport owns.
          ...request.headers,
          Authorization: `Bearer ${token}`,
          ...(request.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal,
      }),
    catch: CloudRequestError.fromCause,
  });

/**
 * `request` with the session's token, refreshed and sent again once on a 401.
 * The response comes back unread. Exported for a main-process caller that
 * builds its own path and reads the body as it arrives (the chat turn stream,
 * `cloud-chat.ts`); it is not held to the allowlist and does not prompt.
 */
export const sendAuthenticated = Effect.fnUntraced(function* (request: CloudHttpRequest) {
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

/** What the host-key prompt shows: the fields of the contract's 409 body. */
export type HostKeyTrustPrompt = Pick<
  SshHostKeyTrustRequired,
  "kind" | "host" | "port" | "presentedFingerprint" | "storedFingerprint"
>;

/**
 * Ask the user about `prompt`'s host key and, on accept, trust it in the
 * org's store (`POST /ssh-host-keys/trust`, with the session's token and its
 * refresh). `None` when the user declined, otherwise the trust route's answer,
 * unread. `orgId` is a path segment as it appears in a URL.
 */
export const promptAndTrustHostKey = Effect.fnUntraced(function* (
  orgId: string,
  prompt: HostKeyTrustPrompt,
) {
  const accepted = yield* Effect.promise(() =>
    promptHostKeyDecision({
      host: prompt.host,
      port: prompt.port,
      kind: prompt.kind === "unknown" ? "first-connect" : "mismatch",
      presentedFingerprint: prompt.presentedFingerprint,
      ...(prompt.storedFingerprint ? { storedFingerprint: prompt.storedFingerprint } : {}),
    }),
  );
  if (!accepted) return Option.none<Response>();

  const trust: typeof TrustHostKeyInput.Encoded = {
    host: prompt.host,
    port: prompt.port,
    fingerprint: prompt.presentedFingerprint,
    ...(prompt.storedFingerprint ? { previousFingerprint: prompt.storedFingerprint } : {}),
  };
  return Option.some(
    yield* sendAuthenticated({
      method: "POST",
      url: `/api/org/${orgId}/ssh-host-keys/trust`,
      body: JSON.stringify(trust),
    }),
  );
});

/**
 * The final answer to `request`, unread: the first answer, or the retry's
 * once the user trusted the SSH host key a 409 asked about. A declined
 * prompt answers with that 409; a trust that failed (raced and 409'd again,
 * or was refused) answers with the trust route's response.
 */
const sendPrompted = Effect.fnUntraced(function* (request: CloudHttpRequest) {
  const response = yield* sendAuthenticated(request);
  const orgId = orgOf(request.url);
  if (response.status !== 409 || orgId === undefined) return response;
  const trustRequired = decodeTrustRequired(yield* readText(response.clone()));
  if (Option.isNone(trustRequired)) return response;

  const trusted = yield* promptAndTrustHostKey(orgId, trustRequired.value);
  if (Option.isNone(trusted)) return response;
  if (!trusted.value.ok) return trusted.value;
  return yield* sendAuthenticated(request);
});

/** Headers the transport sets itself, which no endpoint declaration can hand a renderer. */
const TRANSPORT_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "host",
  "content-type",
  "content-length",
]);

/**
 * Refuse `request` unless its method and path are on the allowlist
 * (`cloud-allowlist.ts`) and every header it carries is one the matched
 * endpoint declares.
 */
const admit = Effect.fnUntraced(function* (request: CloudHttpRequest) {
  const allowed = allowedCloudRequestHeaders(request.method, request.url);
  if (allowed === undefined) {
    return yield* new CloudRequestError({
      message: `Cloud request refused: ${request.method} ${request.url} is not on the desktop's cloud API surface`,
    });
  }
  for (const name of Object.keys(request.headers ?? {})) {
    const header = name.toLowerCase();
    if (header !== name || TRANSPORT_HEADERS.has(header) || !allowed.has(header)) {
      return yield* new CloudRequestError({
        message: `Cloud request refused: ${request.method} ${request.url} does not declare the ${name} header`,
      });
    }
  }
});

const readBytes = (response: Response) =>
  Effect.tryPromise({
    try: async () => new Uint8Array(await response.arrayBuffer()),
    catch: CloudRequestError.fromCause,
  });

/** What a {@link sendCloudRaw} attempt sends; built afresh per attempt. */
export interface CloudRawInit {
  readonly method: CloudHttpRequest["method"];
  readonly body?: FormData;
}

/**
 * A request the JSON transport cannot carry (a multipart upload, a download
 * written to disk), sent by the main process to a path it built itself, so
 * it is not held to the allowlist. Same session and prompt as
 * {@link CloudTransport}: the token with one forced refresh and retry on a
 * 401, and a host-key 409 prompted for, trusted and retried once. `init` is
 * called per attempt because a multipart body is one-shot. The final
 * response comes back unread (a declined prompt's 409, or a failed trust's
 * answer, as with `CloudHttp`); waiting for it is aborted if the caller is
 * interrupted, and reading its body is the caller's to cancel.
 */
export const sendCloudRaw = Effect.fnUntraced(function* (url: string, init: () => CloudRawInit) {
  const once = (token: string) =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(`${CLOUD_URL}${url}`, {
          ...init(),
          headers: { Authorization: `Bearer ${token}` },
          signal,
        }),
      catch: CloudRequestError.fromCause,
    });
  const authenticated = Effect.gen(function* () {
    const response = yield* once(yield* accessToken);
    if (response.status !== 401) return response;
    return yield* once(yield* refreshedToken);
  });

  const response = yield* authenticated;
  const orgId = orgOf(url);
  if (response.status !== 409 || orgId === undefined) return response;
  const trustRequired = decodeTrustRequired(yield* readText(response.clone()));
  if (Option.isNone(trustRequired)) return response;
  const trusted = yield* promptAndTrustHostKey(orgId, trustRequired.value);
  if (Option.isNone(trusted)) return response;
  if (!trusted.value.ok) return trusted.value;
  return yield* authenticated;
});

export class CloudTransport extends Context.Service<
  CloudTransport,
  {
    readonly request: (
      request: CloudHttpRequest,
    ) => Effect.Effect<CloudHttpResponse, CloudRequestError>;
    /** {@link request}, answering the body as bytes (a PDF, a ZIP). */
    readonly requestBytes: (
      request: CloudHttpRequest,
    ) => Effect.Effect<CloudHttpBytesResponse, CloudRequestError>;
  }
>()("infrawrench/desktop/CloudTransport") {
  static readonly layer = Layer.succeed(CloudTransport)(
    CloudTransport.of({
      request: Effect.fn("CloudTransport.request")(function* (request) {
        yield* admit(request);
        const response = yield* sendPrompted(request);
        return { status: response.status, body: yield* readText(response) };
      }),
      requestBytes: Effect.fn("CloudTransport.requestBytes")(function* (request) {
        yield* admit(request);
        const response = yield* sendPrompted(request);
        return { status: response.status, body: yield* readBytes(response) };
      }),
    }),
  );
}
