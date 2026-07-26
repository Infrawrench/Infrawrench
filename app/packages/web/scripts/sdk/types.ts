/**
 * The intermediate representation every SDK target consumes.
 *
 * Nothing in here is TypeScript-specific. `ir.ts` lowers an OpenAPI 3.1
 * document into these shapes — resolving `$ref`s into a named schema list,
 * normalizing JSON Schema into a small closed `TypeRef` union, and deriving the
 * dotted namespace tree (`client.accounts.credentials.get(…)`) from URL paths.
 * A target then only has to answer two questions: how do I print a `TypeRef`,
 * and how do I print a call?
 */

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export const HTTP_METHODS: readonly HttpMethod[] = ["get", "post", "put", "patch", "delete"];

/** A normalized JSON Schema node. Closed union — targets can switch exhaustively. */
export type TypeRef =
  | { kind: "ref"; name: string }
  | { kind: "string"; enum?: string[]; format?: string }
  | { kind: "number"; integer: boolean }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "unknown" }
  /** `format: binary` — a file, not a string. */
  | { kind: "binary" }
  | { kind: "array"; items: TypeRef }
  | { kind: "object"; properties: PropertyDef[]; additional: TypeRef | null }
  /** `anyOf` / `oneOf` / `type: [a, b]`. */
  | { kind: "union"; members: TypeRef[] }
  /** `allOf`. */
  | { kind: "intersection"; members: TypeRef[] };

export interface PropertyDef {
  name: string;
  type: TypeRef;
  required: boolean;
  description?: string;
  deprecated?: boolean;
}

/**
 * A named entry from `components.schemas`. `name` is the spec's name, which a
 * target is free to remap (TypeScript, for one, cannot declare a type called
 * `Error` next to `class ApiError extends Error`) — `TypeRef` refs always carry
 * the spec name, so the remapping lives entirely inside the target.
 */
export interface SchemaDef {
  name: string;
  description?: string;
  type: TypeRef;
}

export interface ParameterDef {
  /** Wire name, e.g. `orgId`. */
  name: string;
  in: "path" | "query";
  required: boolean;
  type: TypeRef;
  description?: string;
  /**
   * True when the client can fill this in from its own configuration (the org
   * id), making it optional at the call site even though the wire requires it.
   */
  defaultable: boolean;
}

export type BodyEncoding = "json" | "multipart";
export type ResponseEncoding = "json" | "binary" | "empty";

export interface RequestBodyDef {
  required: boolean;
  encoding: BodyEncoding;
  type: TypeRef;
}

export interface ResponseDef {
  status: string;
  encoding: ResponseEncoding;
  type: TypeRef | null;
  description?: string;
}

export interface OperationDef {
  /** `operationId` from the spec — unique, and the last-resort method name. */
  id: string;
  method: HttpMethod;
  /** Raw URL template, e.g. `/api/org/{orgId}/accounts/{id}`. */
  path: string;
  /** Dotted namespace the call hangs off, e.g. `["accounts", "credentials"]`. */
  namespace: string[];
  /** Method name within that namespace, e.g. `get`. */
  name: string;
  summary?: string;
  description?: string;
  deprecated: boolean;
  tags: string[];
  /** `x-required-permission`, when the operation declares one. */
  requiredPermission?: string;
  parameters: ParameterDef[];
  body: RequestBodyDef | null;
  /** The 2xx response. */
  response: ResponseDef;
  /** Documented non-2xx responses, for doc comments. */
  errors: ResponseDef[];
}

/** A node in the dotted call tree. */
export interface NamespaceDef {
  /** Path from the root, e.g. `["accounts", "credentials"]`. Empty at the root. */
  path: string[];
  /** Child namespaces, keyed by their own last path segment. Insertion-sorted. */
  children: Map<string, NamespaceDef>;
  operations: OperationDef[];
}

export interface SdkIr {
  /** `info.version` — what "the API version changed" is measured against. */
  apiVersion: string;
  title: string;
  description?: string;
  /** Base URL a client defaults to (first advertised server). */
  baseUrl: string;
  servers: Array<{ url: string; description?: string }>;
  /**
   * Path parameter the client can carry as configuration rather than passing on
   * every call (`orgId` here). `null` when the API has no such parameter.
   */
  defaultablePathParam: string | null;
  /** Name of the bearer security scheme, when the spec advertises one. */
  bearerScheme: string | null;
  schemas: SchemaDef[];
  operations: OperationDef[];
  root: NamespaceDef;
}
