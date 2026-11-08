/**
 * Typed calls to Infrawrench Cloud from the renderer, derived from the
 * endpoint definitions in `@infrawrench/api-contract`.
 *
 * `cloudClient("probes").probes.list({ params: { orgId } })` is an Effect
 * over {@link DesktopRpcClient}: run it with `runRpc` from `./rpc/client`
 * (or `callDesktopRpc` in a main-process test). Each method takes the
 * endpoint's own request type (`params`, `query`, `payload`), so a renamed
 * route or a wrong payload is a compile error, and encodes it strictly with
 * the endpoint's own codecs, so a value the schema refuses never leaves the
 * renderer. It resolves with the server's JSON body untouched, typed as the
 * endpoint's wire (encoded) success type: the desktop ships behind the
 * server, and a newer server's extra enum value or field must reach the
 * panel rather than fail the call.
 *
 * The request crosses to the main process on the `CloudHttp` RPC, which adds
 * the bearer token, refreshes it on a 401, asks about an SSH host key on a
 * 409, and refuses any method+path outside its allowlist
 * (`electron/cloud-transport.ts`).
 *
 * A non-2xx answer fails with {@link CloudResponseError}, whose message is the
 * sentence the per-channel handlers threw (`Cloud request failed: 404
 * /probes/<id> <body>`); a request the main process could not make fails
 * with `CloudRequestError`; a request the endpoint's schema refuses fails
 * with {@link CloudRequestEncodeError}.
 *
 * Why not `HttpApiClient` over an `HttpClient` whose transport is the RPC:
 * its decoded modes validate the answer against the success schema, which is
 * exactly what forward compatibility forbids, and its `response-only` mode
 * returns an untyped `HttpClientResponse`, so the endpoint's type has to be
 * re-attached here either way. Its per-endpoint constructors also cannot be
 * driven from the `DESKTOP_CLOUD_APIS` registry without casting each API to
 * `HttpApi.Top` (an `HttpApi` is invariant in its groups). What it does with
 * a request is small and public (the endpoint's `params`/`query` codecs, its
 * JSON payload codec and `JSON.stringify`, the path template), so this file
 * does the same over `HttpApi.reflect` and keeps the one cast at
 * {@link cloudClient}.
 */
import { Context, Effect, Schema, type Types } from "effect";
import { UrlParams } from "effect/http";
import { HttpApi, type HttpApiEndpoint, type HttpApiGroup } from "effect/http-api";
import type { RpcClientError } from "effect/rpc";
import {
  DESKTOP_CLOUD_APIS,
  type DesktopCloudApis,
  type DesktopCloudEndpoint,
} from "../../shared/cloud-apis";
import { CloudRequestError } from "../../shared/rpc/errors";
import { CloudHttpMethod, type CloudHttpRequest } from "../../shared/rpc/groups/cloud-http";
import { DesktopRpcClient } from "./rpc/desktop-client";

/** The server answered with a status outside 2xx. `body` is its text, untouched. */
export class CloudResponseError extends Schema.TaggedError<CloudResponseError>()(
  "CloudResponseError",
  { message: Schema.String, status: Schema.Int, body: Schema.String },
) {}

/** The endpoint's schema refused the request; nothing was sent. */
export class CloudRequestEncodeError extends Schema.TaggedError<CloudRequestEncodeError>()(
  "CloudRequestEncodeError",
  { message: Schema.String },
) {}

export type CloudCallError =
  CloudRequestError | CloudResponseError | CloudRequestEncodeError | RpcClientError.RpcClientError;

// ----------------------------------------------------------------------------
// Types: the endpoint's request in, its wire success out
// ----------------------------------------------------------------------------

/**
 * An endpoint's success on the wire: the encoded type of the success schema
 * it declares. The endpoint holds that schema wrapped in its JSON codec
 * (`Schema.toCodecJson`, whose own encoded type is just `Json`), so it is
 * unwrapped first. Mutable, because the body is a freshly parsed JSON value
 * the caller owns, and the shared contract types it is handed on as are
 * mutable. A streaming, upgrading or header-carrying success is `never`: the
 * transport carries a buffered JSON body only.
 */
export type CloudWire<Endpoint extends HttpApiEndpoint.Constraint> =
  Endpoint["~Success"] extends Schema.toCodecJson<infer Declared>
    ? Types.DeepMutable<Declared["Encoded"]>
    : never;

/**
 * An endpoint's request: `params`, `query` and `payload` as it declares them,
 * in their decoded types (what `HttpApiClient` takes). Request headers are
 * not carried by the transport, so an endpoint that declares them has none
 * here and its calls fail.
 */
export type CloudRequest<Endpoint extends HttpApiEndpoint.ConstraintRequest> =
  HttpApiEndpoint.ClientRequest<
    Endpoint["~Params"],
    Endpoint["~Query"],
    Endpoint["~Payload"],
    typeof Schema.Never,
    never
  >;

export type CloudMethod<Endpoint extends HttpApiEndpoint.ConstraintRequest> = (
  request: CloudRequest<Endpoint>,
) => Effect.Effect<CloudWire<Endpoint>, CloudCallError, DesktopRpcClient>;

type CloudGroupClient<Group extends HttpApiGroup.Constraint> =
  Group["endpoints"] extends infer Endpoints extends Readonly<
    Record<string, HttpApiEndpoint.ConstraintRequest>
  >
    ? { readonly [Identifier in keyof Endpoints]: CloudMethod<Endpoints[Identifier]> }
    : never;

/** One domain's client: a method per endpoint under its group, as `HttpApiClient` lays it out. */
export type CloudClient<Api> =
  Api extends HttpApi.HttpApi<infer _Id, infer Groups>
    ? { readonly [Group in Groups as HttpApiGroup.Identifier<Group>]: CloudGroupClient<Group> }
    : never;

// ----------------------------------------------------------------------------
// Encoding a request from the endpoint's definition
// ----------------------------------------------------------------------------

/** What an endpoint's `params` codec encodes to. */
const EncodedParams = Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String));
/** What an endpoint's `query` codec (or a body-less method's payload) encodes to. */
const EncodedQuery = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String), Schema.Undefined]),
);
const decodeEncodedParams = Schema.decodeUnknownEffect(EncodedParams);
const decodeEncodedQuery = Schema.decodeUnknownEffect(EncodedQuery);
const isCloudHttpMethod = Schema.is(CloudHttpMethod);
const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * `endpoint.path` with each `:name` (or optional `:name?`) replaced by its
 * encoded, URI-escaped value; an absent optional one takes its leading `/`
 * with it. A dot segment is refused, as `HttpApiClient` refuses it: URL
 * normalization would resolve it to another route.
 */
function fillPath(
  path: string,
  params: Readonly<Record<string, string | undefined>>,
): string | CloudRequestEncodeError {
  let problem: CloudRequestEncodeError | undefined;
  const filled = path.replace(/\/?:(\w+)(\?)?/g, (segment, name: string, optional?: string) => {
    const value = params[name];
    const slash = segment.startsWith("/") ? "/" : "";
    if (value === undefined) {
      if (!optional)
        problem ??= new CloudRequestEncodeError({ message: `Missing path parameter: ${name}` });
      return "";
    }
    if (value === "." || value === "..") {
      problem ??= new CloudRequestEncodeError({ message: `Invalid path parameter: ${name}` });
      return "";
    }
    return `${slash}${encodeURIComponent(value)}`;
  });
  return problem ?? filled;
}

type WideRequest =
  | { readonly params?: unknown; readonly query?: unknown; readonly payload?: unknown }
  | undefined
  | void;

const encodeFailure = (label: string) => (issue: Schema.SchemaError) =>
  new CloudRequestEncodeError({ message: `Invalid ${label} request: ${issue.message}` });

/** The `CloudHttp` request for one call of `endpoint`, encoded by its own schemas. */
function requestEncoder(
  endpoint: HttpApiEndpoint.Top,
  annotations: Context.Context<never>,
  label: string,
): (request: WideRequest) => Effect.Effect<CloudHttpRequest, CloudRequestEncodeError, unknown> {
  const fallback = Context.getOrUndefined(annotations, HttpApi.ParseOptions);
  const method = endpoint.method;
  const refuse = (message: string) => () => Effect.fail(new CloudRequestEncodeError({ message }));

  if (!isCloudHttpMethod(method))
    return refuse(`${label}: ${method} is not carried by the cloud transport`);
  if (endpoint.headers !== undefined) {
    return refuse(`${label} declares request headers, which the cloud transport does not carry`);
  }
  const payloads = [...endpoint.payload.values()];
  const jsonPayload = payloads.find((entry) => entry.encoding._tag === "Json");
  const queryPayload = payloads.find((entry) => entry.encoding._tag === "FormUrlEncoded");
  if (
    payloads.length > 0 &&
    jsonPayload === undefined &&
    (BODY_METHODS.has(method) || !queryPayload)
  ) {
    return refuse(
      `${label} takes a body that is not JSON, which the cloud transport does not carry`,
    );
  }

  const failed = encodeFailure(label);
  const encodeParams = endpoint.params
    ? Schema.encodeUnknownEffect(
        endpoint.params,
        Context.getOrUndefined(annotations, HttpApi.ParamsParseOptions) ?? fallback,
      )
    : undefined;
  const encodeQuery = endpoint.query
    ? Schema.encodeUnknownEffect(
        endpoint.query,
        Context.getOrUndefined(annotations, HttpApi.QueryParseOptions) ?? fallback,
      )
    : undefined;
  const payloadEntry = BODY_METHODS.has(method) ? jsonPayload : queryPayload;
  const encodePayload = payloadEntry
    ? Schema.encodeUnknownEffect(
        Schema.Union(payloadEntry.schemas),
        Context.getOrUndefined(annotations, HttpApi.PayloadParseOptions) ?? fallback,
      )
    : undefined;

  return Effect.fnUntraced(function* (request) {
    const params = encodeParams
      ? yield* encodeParams(request?.params).pipe(
          Effect.flatMap(decodeEncodedParams),
          Effect.mapError(failed),
        )
      : {};
    const path = fillPath(endpoint.path, params);
    if (path instanceof CloudRequestEncodeError) return yield* path;

    const query = UrlParams.fromInput(
      encodeQuery
        ? yield* encodeQuery(request?.query).pipe(
            Effect.flatMap(decodeEncodedQuery),
            Effect.mapError(failed),
          )
        : {},
    );
    let body: string | undefined;
    let urlParams = query;
    if (encodePayload) {
      const encoded = yield* encodePayload(request?.payload).pipe(Effect.mapError(failed));
      if (BODY_METHODS.has(method)) {
        body = JSON.stringify(encoded);
      } else {
        const asQuery = yield* decodeEncodedQuery(encoded).pipe(Effect.mapError(failed));
        urlParams = UrlParams.appendAll(query, asQuery);
      }
    }
    const search = UrlParams.toString(urlParams);
    const url = search === "" ? path : `${path}?${search}`;
    return body === undefined ? { method, url } : { method, url, body };
  });
}

// ----------------------------------------------------------------------------
// Reading the answer
// ----------------------------------------------------------------------------

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * The path as the per-channel handlers named it in their errors: under the
 * org (`/probes/<id>`), or whole for a route outside the org tree.
 */
function errorPath(url: string): string {
  const match = /^\/api\/org\/[^/?]+(.*)$/.exec(url);
  return match?.[1] || url;
}

/** A 2xx answer's body as parsed JSON (`undefined` when empty); any other status fails. */
const readAnswer = Effect.fnUntraced(function* (
  url: string,
  answer: { readonly status: number; readonly body: string },
) {
  if (answer.status < 200 || answer.status >= 300) {
    return yield* new CloudResponseError({
      message: `Cloud request failed: ${answer.status} ${errorPath(url)} ${answer.body}`,
      status: answer.status,
      body: answer.body,
    });
  }
  if (answer.body === "") return undefined;
  return yield* decodeJson(answer.body).pipe(
    Effect.mapError(
      () =>
        new CloudResponseError({
          message: `Infrawrench Cloud answered ${errorPath(url)} with a body that is not JSON`,
          status: answer.status,
          body: answer.body,
        }),
    ),
  );
});

// ----------------------------------------------------------------------------
// A domain's client
// ----------------------------------------------------------------------------

/**
 * A method as built, before {@link cloudClient} types it. Its services are
 * `unknown` because `HttpApi.reflect` hands the endpoint's codecs over as
 * `Schema.Top`, which may need any service; the contract's codecs need none,
 * so the only one a call needs is `DesktopRpcClient`.
 */
type WideMethod = (request: WideRequest) => Effect.Effect<unknown, CloudCallError, unknown>;

function buildClient(
  name: string,
  endpoints: ReadonlyArray<DesktopCloudEndpoint>,
): Record<string, Record<string, WideMethod>> {
  const client: Record<string, Record<string, WideMethod>> = {};
  for (const { group, endpoint, annotations } of endpoints) {
    const encode = requestEncoder(endpoint, annotations, `${name}.${group}.${endpoint.identifier}`);
    const method: WideMethod = (request) =>
      encode(request).pipe(
        Effect.flatMap((outgoing) =>
          DesktopRpcClient.use((rpc) => rpc.CloudHttp(outgoing)).pipe(
            Effect.flatMap((answer) => readAnswer(outgoing.url, answer)),
          ),
        ),
      );
    const groupClient = (client[group] ??= {});
    groupClient[endpoint.identifier] = method;
  }
  return client;
}

const clients = new Map<keyof DesktopCloudApis, unknown>();

/**
 * The typed client for one contract domain the desktop calls (an entry of
 * `DESKTOP_CLOUD_APIS`), built on first use and kept.
 */
export function cloudClient<Name extends keyof DesktopCloudApis>(
  name: Name,
): CloudClient<DesktopCloudApis[Name]["api"]> {
  let client = clients.get(name);
  if (client === undefined) {
    client = buildClient(name, DESKTOP_CLOUD_APIS[name].endpoints);
    clients.set(name, client);
  }
  // The one place a cloud answer is given a type. `buildClient` made a method
  // for every endpoint of the domain, each resolving with the server's parsed
  // JSON body; this names that body the endpoint's wire type rather than
  // decoding it, so a newer server's additions pass through untouched.
  // Drift is still a compile error at every caller that hands the wire type
  // on as a client-core or ui type.
  return client as CloudClient<DesktopCloudApis[Name]["api"]>;
}
