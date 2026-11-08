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
 * renderer, with one deliberate exception: a string literal union (an enum)
 * accepts any string, so a value echoed from a newer server's answer goes
 * back to it ({@link widenLiteralEnums}). It resolves with the server's body
 * untouched, typed as the endpoint's wire (encoded) success type: the parsed
 * JSON, the text of a text answer (CSV, typings), the bytes of a binary one
 * (a PDF, a ZIP). The desktop ships behind the server, and a newer server's
 * extra enum value or field must reach the panel rather than fail the call.
 *
 * The request crosses to the main process on the `CloudHttp` RPC (or
 * `CloudHttpBytes` for a binary answer), which adds the bearer token,
 * refreshes it on a 401, asks about an SSH host key on a 409, and refuses
 * any method+path outside its allowlist and any header the endpoint does not
 * declare (`electron/cloud-transport.ts`).
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
import {
  Array as Arr,
  Context,
  Effect,
  Option,
  Predicate,
  Schema,
  SchemaAST,
  type Types,
} from "effect";
import { UrlParams } from "effect/http";
import { HttpApi, type HttpApiEndpoint, type HttpApiGroup } from "effect/http-api";
import type { RpcClientError } from "effect/rpc";
import {
  DESKTOP_CLOUD_APIS,
  type DesktopCloudAnswer,
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

const decodeJsonBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * The server's own sentence for a failed answer: the `error` string of a JSON
 * body, the shape every contract error carries (`{ error: "Probe not found" }`).
 */
export function serverErrorSentence(body: string): Option.Option<string> {
  return decodeJsonBody(body).pipe(
    Option.flatMap((parsed) =>
      Predicate.hasProperty(parsed, "error") && Predicate.isString(parsed.error)
        ? Option.some(parsed.error)
        : Option.none(),
    ),
  );
}

/**
 * `error` with the server's `{ error }` sentence as its message in place of
 * the transport's `Cloud request failed: ...`, keeping `status` and `body`;
 * any other error, or a body without one, is returned as it was.
 */
export function withServerSentence<E>(error: E): E | CloudResponseError {
  if (!(error instanceof CloudResponseError)) return error;
  const sentence = serverErrorSentence(error.body);
  return Option.isSome(sentence)
    ? new CloudResponseError({ message: sentence.value, status: error.status, body: error.body })
    : error;
}

/**
 * A call whose failure shows the server's sentence (see
 * {@link withServerSentence}), for a panel that shows a refusal verbatim:
 * `call.pipe(withServerMessage)`.
 */
export const withServerMessage = <A, E, R>(call: Effect.Effect<A, E, R>) =>
  call.pipe(Effect.mapError(withServerSentence));

// ----------------------------------------------------------------------------
// Types: the endpoint's request in, its wire success out
// ----------------------------------------------------------------------------

/**
 * An endpoint's success on the wire, as the client resolves with it: the
 * encoded type of each success schema it declares. The endpoint's type holds
 * every success wrapped in its JSON codec (`Schema.toCodecJson`, whose own
 * encoded type is just `Json`), so it is unwrapped first; the type cannot
 * see a success's `HttpApiSchema` encoding, but it does not need to, since a
 * text success (`asText`: CSV, typings) is a `Schema.String`, encoded as the
 * `string` the client hands on, and a binary one (`asUint8Array`: a PDF, a
 * ZIP) a `Schema.Uint8Array`, the bytes. An endpoint with a text success and
 * a JSON alternative (the access-review export) answers the text the server
 * sent either way, inside the union this names. `void` for a 204. Mutable,
 * because the body is a freshly parsed value the caller owns, and the shared
 * contract types it is handed on as are mutable. A streaming success is the
 * stream's type here, but the client refuses those endpoints before sending.
 */
export type CloudWire<Endpoint extends HttpApiEndpoint.Constraint> =
  Endpoint["~Success"] extends Schema.toCodecJson<infer Declared>
    ? Types.DeepMutable<Declared["Encoded"]>
    : never;

/** `{ key: T }`, optional when every key of `T` is (a query of filters), absent for none. */
type OptionalWhenEmpty<Key extends string, S extends Schema.Constraint> = [S["Type"]] extends [
  never,
]
  ? {}
  : {} extends S["Type"]
    ? { readonly [K in Key]?: S["Type"] }
    : { readonly [K in Key]: S["Type"] };

type Required<Key extends string, S extends Schema.Constraint> = [S["Type"]] extends [never]
  ? {}
  : { readonly [K in Key]: S["Type"] };

/**
 * An endpoint's request: `params`, `query`, `headers` and `payload` as it
 * declares them, in their decoded types (what `HttpApiClient` takes). A
 * `query` or `headers` whose every key is optional may be left out, and an
 * endpoint that takes nothing is called with no argument.
 */
export type CloudRequest<Endpoint extends HttpApiEndpoint.ConstraintRequest> = Required<
  "params",
  Endpoint["~Params"]
> &
  OptionalWhenEmpty<"query", Endpoint["~Query"]> &
  OptionalWhenEmpty<"headers", Endpoint["~Headers"]> &
  Required<"payload", Endpoint["~Payload"]> extends infer Request
  ? keyof Request extends never
    ? void
    : Request
  : never;

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
// Lenient enums
// ----------------------------------------------------------------------------

/** A string literal with nothing attached, as `Schema.Literals` builds its members. */
const isPlainStringLiteral = (ast: SchemaAST.AST): ast is SchemaAST.Literal =>
  SchemaAST.isLiteral(ast) &&
  Predicate.isString(ast.literal) &&
  ast.encoding === undefined &&
  ast.checks === undefined;

const widened = new WeakMap<SchemaAST.AST, SchemaAST.AST>();

/**
 * `ast` with every union of two or more string literals (an enum:
 * `Schema.Literals(["csv", "json"])`) and every string-valued `Schema.Enum`
 * widened to any string, at every depth, keeping everything else (optional
 * keys, checks, encodings, the other members of a mixed union).
 *
 * The request schemas are the server's, and a request often echoes a value a
 * newer server sent (an access-review rule id to dismiss, a finding kind, the
 * enum fields of an object loaded, edited and saved back). Encoding those
 * strictly would refuse the newer value before sending, which is the
 * opposite of the forward compatibility the answers get. The server still
 * validates what it receives, so a value it does not know is its 400, as it
 * was over `invoke`. Done here, once, rather than per endpoint, because the
 * echo is everywhere an update round-trips an object; the types are not
 * widened, so a caller still cannot write a value the contract does not
 * declare.
 *
 * A single literal stays strict: it is a discriminator (`kind: "relative"`)
 * or a version (`version: 1`), which picks a union member or a format, and
 * widening it would let one member swallow another's input. Numeric and
 * boolean literals stay strict too. `cloud-client.test.ts` walks every
 * registered request schema and fails if an enum is left strict.
 */
export function widenLiteralEnums(ast: SchemaAST.AST): SchemaAST.AST {
  const known = widened.get(ast);
  if (known !== undefined) return known;
  const result = widenNode(ast);
  widened.set(ast, result);
  return result;
}

function widenEncoding(encoding: SchemaAST.Encoding | undefined): SchemaAST.Encoding | undefined {
  if (encoding === undefined) return undefined;
  const links = Arr.map(encoding, (link) => {
    const to = widenLiteralEnums(link.to);
    return to === link.to ? link : new SchemaAST.Link(to, link.transformation);
  });
  return links.every((link, index) => link === encoding[index]) ? encoding : links;
}

function same<A>(next: ReadonlyArray<A>, previous: ReadonlyArray<A>): boolean {
  return next.every((item, index) => item === previous[index]);
}

function widenNode(ast: SchemaAST.AST): SchemaAST.AST {
  const encoding = widenEncoding(ast.encoding);
  switch (ast._tag) {
    case "Union": {
      const members = ast.types.map(widenLiteralEnums);
      const literals = members.filter(isPlainStringLiteral).length;
      let types = members;
      if (literals >= 2) {
        const first = members.findIndex(isPlainStringLiteral);
        types = members.flatMap((member, index) =>
          index === first ? [new SchemaAST.String()] : isPlainStringLiteral(member) ? [] : [member],
        );
      }
      if (same(types, ast.types) && types.length === ast.types.length && encoding === ast.encoding)
        return ast;
      return new SchemaAST.Union(
        types,
        ast.options,
        ast.annotations,
        ast.checks,
        encoding,
        ast.context,
        ast.encodingChecks,
      );
    }
    case "Enum": {
      if (!ast.enums.every(([, value]) => Predicate.isString(value))) return ast;
      return new SchemaAST.String(ast.annotations, ast.checks, encoding, ast.context);
    }
    case "Objects": {
      const properties = ast.propertySignatures.map((property) => {
        const type = widenLiteralEnums(property.type);
        return type === property.type
          ? property
          : new SchemaAST.PropertySignature(property.name, type);
      });
      const indexes = ast.indexSignatures.map((index) => {
        const type = widenLiteralEnums(index.type);
        return type === index.type ? index : new SchemaAST.IndexSignature(index.parameter, type);
      });
      if (
        same(properties, ast.propertySignatures) &&
        same(indexes, ast.indexSignatures) &&
        encoding === ast.encoding
      )
        return ast;
      return new SchemaAST.Objects(
        properties,
        indexes,
        ast.annotations,
        ast.checks,
        encoding,
        ast.context,
        ast.encodingChecks,
      );
    }
    case "Arrays": {
      const elements = ast.elements.map(widenLiteralEnums);
      const rest = ast.rest.map(widenLiteralEnums);
      if (same(elements, ast.elements) && same(rest, ast.rest) && encoding === ast.encoding)
        return ast;
      return new SchemaAST.Arrays(
        ast.isMutable,
        elements,
        rest,
        ast.annotations,
        ast.checks,
        encoding,
        ast.context,
        ast.encodingChecks,
      );
    }
    case "Suspend": {
      const thunk = ast.thunk;
      return new SchemaAST.Suspend(
        () => widenLiteralEnums(thunk()),
        ast.annotations,
        ast.checks,
        encoding,
        ast.context,
      );
    }
    case "Declaration": {
      const typeParameters = ast.typeParameters.map(widenLiteralEnums);
      if (same(typeParameters, ast.typeParameters) && encoding === ast.encoding) return ast;
      return new SchemaAST.Declaration(
        typeParameters,
        ast.run,
        ast.annotations,
        ast.checks,
        encoding,
        ast.context,
        ast.encodingChecks,
        ast.encodingRun,
      );
    }
    default:
      // A leaf: nothing inside to widen. A literal enum reachable only
      // through a leaf's encoding is left strict, which the registry test
      // reports.
      return ast;
  }
}

/** `schema` with its enums widened (see {@link widenLiteralEnums}). */
const lenient = (schema: Schema.Top): Schema.Top => {
  const ast = widenLiteralEnums(schema.ast);
  return ast === schema.ast ? schema : Schema.make<Schema.Top>(ast);
};

// ----------------------------------------------------------------------------
// Encoding a request from the endpoint's definition
// ----------------------------------------------------------------------------

/** What an endpoint's `params` or `headers` codec encodes to. */
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
 * normalization would resolve it to another route. An encoded `/` inside a
 * value (an ARN, `namespace/name`) is fine: the server routes on the raw
 * path and decodes the value after.
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
  | {
      readonly params?: unknown;
      readonly query?: unknown;
      readonly headers?: unknown;
      readonly payload?: unknown;
    }
  | undefined
  | void;

const encodeFailure = (label: string) => (issue: Schema.SchemaError) =>
  new CloudRequestEncodeError({ message: `Invalid ${label} request: ${issue.message}` });

/** The `CloudHttp` request for one call of `endpoint`, encoded by its own schemas. */
function requestEncoder(
  entry: DesktopCloudEndpoint,
  label: string,
): (request: WideRequest) => Effect.Effect<CloudHttpRequest, CloudRequestEncodeError, unknown> {
  const { endpoint, annotations } = entry;
  const fallback = Context.getOrUndefined(annotations, HttpApi.ParseOptions);
  const method = endpoint.method;
  const refuse = (message: string) => () => Effect.fail(new CloudRequestEncodeError({ message }));

  if (!isCloudHttpMethod(method))
    return refuse(`${label}: ${method} is not carried by the cloud transport`);
  if (entry.answer === "stream") {
    return refuse(`${label} answers with a stream, which the cloud transport does not carry`);
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
  const encoder = (schema: Schema.Top, options: typeof fallback) =>
    Schema.encodeUnknownEffect(lenient(schema), options ?? fallback);
  const encodeParams = endpoint.params
    ? encoder(endpoint.params, Context.getOrUndefined(annotations, HttpApi.ParamsParseOptions))
    : undefined;
  const encodeQuery = endpoint.query
    ? encoder(endpoint.query, Context.getOrUndefined(annotations, HttpApi.QueryParseOptions))
    : undefined;
  const encodeHeaders = endpoint.headers
    ? encoder(endpoint.headers, Context.getOrUndefined(annotations, HttpApi.HeadersParseOptions))
    : undefined;
  const payloadEntry = BODY_METHODS.has(method) ? jsonPayload : queryPayload;
  const encodePayload = payloadEntry
    ? encoder(
        Schema.Union(payloadEntry.schemas),
        Context.getOrUndefined(annotations, HttpApi.PayloadParseOptions),
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
        ? yield* encodeQuery(request?.query ?? {}).pipe(
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
    const headers: Record<string, string> = {};
    if (encodeHeaders) {
      const encoded = yield* encodeHeaders(request?.headers ?? {}).pipe(
        Effect.flatMap(decodeEncodedParams),
        Effect.mapError(failed),
      );
      for (const [name, value] of Object.entries(encoded)) {
        if (value !== undefined) headers[name.toLowerCase()] = value;
      }
    }
    const search = UrlParams.toString(urlParams);
    const url = search === "" ? path : `${path}?${search}`;
    return {
      method,
      url,
      ...(body === undefined ? {} : { body }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    };
  });
}

// ----------------------------------------------------------------------------
// Reading the answer
// ----------------------------------------------------------------------------

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const utf8 = new TextDecoder();

/**
 * The path as the per-channel handlers named it in their errors: under the
 * org (`/probes/<id>`), or whole for a route outside the org tree.
 */
function errorPath(url: string): string {
  const match = /^\/api\/org\/[^/?]+(.*)$/.exec(url);
  return match?.[1] || url;
}

/** A status outside 2xx as the failure the per-channel handlers threw. */
const failedAnswer = (url: string, status: number, body: string) =>
  new CloudResponseError({
    message: `Cloud request failed: ${status} ${errorPath(url)} ${body}`,
    status,
    body,
  });

const isSuccess = (status: number) => status >= 200 && status < 300;

/**
 * A 2xx answer's body as `answer` says the endpoint answers: text as sent,
 * or parsed JSON. An empty JSON body is `undefined` where the endpoint
 * declares one (a 204), and a failure where it does not, since the type
 * promised a value; any other status fails.
 */
const readTextAnswer = Effect.fnUntraced(function* (
  url: string,
  answer: DesktopCloudAnswer,
  empty: boolean,
  response: { readonly status: number; readonly body: string },
) {
  if (!isSuccess(response.status)) {
    return yield* failedAnswer(url, response.status, response.body);
  }
  if (answer === "text") return response.body;
  const notJson = (what: string) =>
    new CloudResponseError({
      message: `Infrawrench Cloud answered ${errorPath(url)} with ${what}`,
      status: response.status,
      body: response.body,
    });
  if (response.body === "") {
    if (empty) return undefined;
    return yield* notJson("an empty body");
  }
  return yield* decodeJson(response.body).pipe(
    Effect.mapError(() => notJson("a body that is not JSON")),
  );
});

/** A 2xx binary answer's bytes; any other status fails with its body read as text. */
const readBytesAnswer = Effect.fnUntraced(function* (
  url: string,
  response: { readonly status: number; readonly body: Uint8Array },
) {
  if (!isSuccess(response.status)) {
    return yield* failedAnswer(url, response.status, utf8.decode(response.body));
  }
  return response.body;
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
  for (const entry of endpoints) {
    const { group, endpoint, answer, empty } = entry;
    const encode = requestEncoder(entry, `${name}.${group}.${endpoint.identifier}`);
    const method: WideMethod = (request) =>
      encode(request).pipe(
        Effect.flatMap((outgoing) =>
          answer === "bytes"
            ? DesktopRpcClient.use((rpc) => rpc.CloudHttpBytes(outgoing)).pipe(
                Effect.flatMap((response) => readBytesAnswer(outgoing.url, response)),
              )
            : DesktopRpcClient.use((rpc) => rpc.CloudHttp(outgoing)).pipe(
                Effect.flatMap((response) => readTextAnswer(outgoing.url, answer, empty, response)),
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
  // for every endpoint of the domain, each resolving with the server's body
  // (parsed JSON, text or bytes, as the endpoint declares); this names that
  // body the endpoint's wire type rather than decoding it, so a newer
  // server's additions pass through untouched. Drift is still a compile
  // error at every caller that hands the wire type on as a client-core or ui
  // type.
  return client as CloudClient<DesktopCloudApis[Name]["api"]>;
}
