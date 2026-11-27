/**
 * The API client's types, derived from `@infrawrench/git-contract`. Nothing
 * here exists at runtime: the contract is imported as a type only, so the
 * bundle carries no Effect.
 */
import type { Schema } from "effect";
import type { HttpApi, HttpApiGroup } from "effect/http-api";
import type { GitApi } from "@infrawrench/git-contract";

type Groups = typeof GitApi extends HttpApi.HttpApi<infer _Id, infer G> ? G : never;

type EndpointsOf<Group> = Group extends { readonly endpoints: infer Endpoints } ? Endpoints : never;

/**
 * An endpoint's success as it arrives: the encoded (JSON) type of the schema
 * it declares. The endpoint's type holds it wrapped in its JSON codec.
 */
export type Wire<Endpoint> = Endpoint extends { readonly "~Success": infer Success }
  ? Success extends Schema.toCodecJson<infer Declared>
    ? Declared["Encoded"]
    : never
  : never;

// An endpoint without a part declares it as never, which a bare conditional
// type would distribute over (and answer never for the whole request), so it
// is tested wrapped in a tuple.
type Part<Key extends string, S, Optional extends boolean> = [S] extends [never]
  ? {}
  : S extends { readonly Type: infer T }
    ? Optional extends true
      ? {} extends T
        ? { readonly [K in Key]?: T }
        : { readonly [K in Key]: T }
      : { readonly [K in Key]: T }
    : {};

/**
 * An endpoint's request: `params`, `query` and `payload` in the types the
 * contract declares (a page size is a number, not its string). A `query`
 * whose keys are all optional may be left out; a `payload` is always given.
 */
export type ApiRequest<Endpoint> = Endpoint extends {
  readonly "~Params": infer Params;
  readonly "~Query": infer Query;
  readonly "~Payload": infer Payload;
}
  ? Part<"params", Params, false> & Part<"query", Query, true> & Part<"payload", Payload, false>
  : never;

type Method<Endpoint> =
  {} extends ApiRequest<Endpoint>
    ? (request?: ApiRequest<Endpoint>) => Promise<Wire<Endpoint>>
    : (request: ApiRequest<Endpoint>) => Promise<Wire<Endpoint>>;

/** `api.<group>.<endpoint>(request)`, one method per endpoint of the contract. */
export type ApiClient = {
  readonly [Group in Groups as HttpApiGroup.Identifier<Group>]: {
    readonly [Name in keyof EndpointsOf<Group>]: Method<EndpointsOf<Group>[Name]>;
  };
};

export type GroupName = keyof ApiClient;
export type EndpointName<G extends GroupName> = keyof ApiClient[G] & string;

/** The request of `api.<G>.<E>`. */
export type RequestOf<G extends GroupName, E extends EndpointName<G>> = ApiClient[G][E] extends (
  request: infer R,
) => unknown
  ? NonNullable<R>
  : never;

/** What `api.<G>.<E>` resolves with. */
export type ResponseOf<G extends GroupName, E extends EndpointName<G>> = ApiClient[G][E] extends (
  ...args: never[]
) => Promise<infer A>
  ? A
  : never;

/** A request with every part present, as the transport and the mock see it. */
export interface WireRequest {
  readonly params?: Readonly<Record<string, unknown>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly payload?: unknown;
}
