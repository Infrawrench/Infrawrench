/**
 * OpenAPI 3.1 → `SdkIr`.
 *
 * Two jobs, both target-agnostic:
 *
 * 1. **Normalize the schema graph.** JSON Schema has many ways to say the same
 *    thing (`type: ["string", "null"]` vs `anyOf`, `additionalProperties: true`
 *    vs an open object). `TypeRef` is the one closed union targets switch on.
 *
 * 2. **Derive the dotted call tree.** URL paths already encode the hierarchy the
 *    SDK wants — `POST /accounts/{id}/sync` is `accounts.sync(…)` — so names
 *    come from the path, not from `operationId`. See `deriveNames`.
 *
 * Internal operations never reach here: `buildSdkIr` runs the document through
 * `toPublicDocument` first, which is the same filter `/openapi.json` uses.
 */
import { toPublicDocument } from "../../src/api/openapi/public-spec";
import { camelCase } from "./naming";
import {
  HTTP_METHODS,
  type HttpMethod,
  type NamespaceDef,
  type OperationDef,
  type ParameterDef,
  type PropertyDef,
  type ResponseDef,
  type SchemaDef,
  type SdkIr,
  type TypeRef,
} from "./types";

/** Loose views of the bits of an OpenAPI document we read. */
type JsonMap = Record<string, unknown>;

interface RawOperation extends JsonMap {
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  tags?: string[];
  parameters?: RawParameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { schema?: unknown }> }
  >;
}

interface RawParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: unknown;
}

interface RawDocument {
  info?: { version?: string; title?: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, { type?: string; scheme?: string }>;
  };
}

// ---------------------------------------------------------------------------
// Schema normalization
// ---------------------------------------------------------------------------

const SINGLE_TYPES = new Set(["string", "number", "integer", "boolean", "null", "array", "object"]);

/** Lower one JSON Schema node into a `TypeRef`. */
export function toTypeRef(node: unknown): TypeRef {
  if (node === true || node === undefined || node === null) return { kind: "unknown" };
  if (node === false) return { kind: "unknown" };
  if (typeof node !== "object") return { kind: "unknown" };

  const schema = node as JsonMap;

  const ref = schema["$ref"];
  if (typeof ref === "string") {
    const name = ref.split("/").pop();
    return name ? { kind: "ref", name } : { kind: "unknown" };
  }

  const allOf = schema["allOf"];
  if (Array.isArray(allOf) && allOf.length > 0) {
    const members = allOf.map(toTypeRef);
    return members.length === 1 ? members[0]! : { kind: "intersection", members };
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0) {
      const members = branches.map(toTypeRef);
      return members.length === 1 ? members[0]! : { kind: "union", members };
    }
  }

  const type = schema["type"];

  // `type: ["string", "null"]` — re-run once per branch so keywords that only
  // make sense for one of them (enum, items, properties) still apply.
  if (Array.isArray(type)) {
    const members = type
      .filter((t): t is string => typeof t === "string" && SINGLE_TYPES.has(t))
      .map((t) => toTypeRef({ ...schema, type: t }));
    if (members.length === 0) return { kind: "unknown" };
    return members.length === 1 ? members[0]! : { kind: "union", members };
  }

  if (type === "null") return { kind: "null" };
  if (type === "boolean") return { kind: "boolean" };
  if (type === "integer") return { kind: "number", integer: true };
  if (type === "number") return { kind: "number", integer: false };

  if (type === "string") {
    const format = typeof schema["format"] === "string" ? schema["format"] : undefined;
    if (format === "binary") return { kind: "binary" };
    const rawEnum = schema["enum"];
    const values = Array.isArray(rawEnum)
      ? rawEnum.filter((v): v is string => typeof v === "string")
      : undefined;
    return {
      kind: "string",
      ...(values && values.length > 0 ? { enum: values } : {}),
      ...(format ? { format } : {}),
    };
  }

  if (type === "array") return { kind: "array", items: toTypeRef(schema["items"]) };

  if (type === "object" || schema["properties"] !== undefined) {
    const rawProps = (schema["properties"] as JsonMap | undefined) ?? {};
    const required = new Set(
      Array.isArray(schema["required"])
        ? schema["required"].filter((r): r is string => typeof r === "string")
        : [],
    );
    const properties: PropertyDef[] = Object.entries(rawProps).map(([name, value]) => {
      const child = (value ?? {}) as JsonMap;
      const description =
        typeof child["description"] === "string" ? child["description"] : undefined;
      return {
        name,
        type: toTypeRef(value),
        required: required.has(name),
        ...(description ? { description } : {}),
        ...(child["deprecated"] === true ? { deprecated: true } : {}),
      };
    });

    const additionalRaw = schema["additionalProperties"];
    const additional: TypeRef | null =
      additionalRaw === undefined || additionalRaw === false
        ? null
        : additionalRaw === true
          ? { kind: "unknown" }
          : toTypeRef(additionalRaw);

    return { kind: "object", properties, additional };
  }

  // A bare `enum` with no `type` still pins the value set.
  const rawEnum = schema["enum"];
  if (Array.isArray(rawEnum)) {
    const values = rawEnum.filter((v): v is string => typeof v === "string");
    if (values.length === rawEnum.length && values.length > 0)
      return { kind: "string", enum: values };
  }

  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

const PARAM_SEGMENT = /^\{(.+)\}$/;

function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * Which path parameter the client should carry as configuration instead of
 * demanding on every call. We look for the `<scope>/{param}` prefix convention
 * (`/api/org/{orgId}/…`) and take the parameter that scopes at least half the
 * documented paths.
 */
function detectDefaultablePathParam(paths: string[]): string | null {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const segs = pathSegments(path);
    const start = segs[0] === "api" ? 1 : 0;
    const scope = segs[start];
    const param = segs[start + 1]?.match(PARAM_SEGMENT)?.[1];
    if (!scope || PARAM_SEGMENT.test(scope) || !param) continue;
    counts.set(param, (counts.get(param) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [param, count] of counts) {
    if (count > bestCount) {
      best = param;
      bestCount = count;
    }
  }
  return bestCount >= paths.length / 2 ? best : null;
}

/**
 * Strip the parts of a path that carry no naming information: the `/api` mount,
 * the org-scoping prefix, and a leading version segment. What's left is what the
 * dotted namespace is built from.
 */
function namingSegments(path: string, scopeParam: string | null): string[] {
  const segs = pathSegments(path);
  let i = 0;
  if (segs[i] === "api") i++;
  if (scopeParam && segs[i] && !PARAM_SEGMENT.test(segs[i]!) && segs[i + 1] === `{${scopeParam}}`) {
    i += 2;
  }
  if (segs[i] && /^v\d+$/.test(segs[i]!)) i++;
  return segs.slice(i);
}

// ---------------------------------------------------------------------------
// Name derivation
// ---------------------------------------------------------------------------

interface Draft {
  op: OperationDef;
  namespace: string[];
  name: string;
  endsWithParam: boolean;
  responseIsArray: boolean;
}

/**
 * The verb a call gets when its own path segment can't name it — either because
 * the path ends in a parameter (`DELETE /accounts/{id}`) or because the segment
 * had to become a namespace (`GET /team/roles` alongside `/team/roles/{id}`).
 *
 * `GET` splits on the response shape rather than on pluralization guesswork: an
 * array response is a `list`, anything else is a `get`.
 */
function verbFor(method: HttpMethod, endsWithParam: boolean, responseIsArray: boolean): string {
  switch (method) {
    case "get":
      return !endsWithParam && responseIsArray ? "list" : "get";
    case "post":
      return "create";
    case "put":
    case "patch":
      return "update";
    case "delete":
      return "delete";
  }
}

function nodeKey(namespace: string[]): string {
  return namespace.join(".");
}

/**
 * Assign every operation a `(namespace, name)` pair.
 *
 * The base rule reads the path: static segments are namespaces, and the last
 * one names the call — `POST /accounts/{id}/sync` → `accounts.sync()`. When the
 * path ends in a parameter there is no trailing segment to use, so the whole
 * static run becomes the namespace and an HTTP verb names the call —
 * `DELETE /accounts/{id}` → `accounts.delete()`.
 *
 * Then one repair pass. A name is unusable if two operations want it (`GET` and
 * `PUT /accounts/{id}/credentials`) or if it is already a child namespace
 * (`GET /team/roles` next to `PATCH /team/roles/{id}`). Both are fixed the same
 * way — push the operation down into a namespace of that name and let a verb
 * name it — which is why `team.roles` ends up with the full `list`/`create`/
 * `update`/`delete` set instead of a lopsided mix.
 */
function deriveNames(drafts: Draft[], warn: (message: string) => void): void {
  const childNames = (): Map<string, Set<string>> => {
    const map = new Map<string, Set<string>>();
    for (const draft of drafts) {
      for (let i = 1; i <= draft.namespace.length; i++) {
        const parent = nodeKey(draft.namespace.slice(0, i - 1));
        let set = map.get(parent);
        if (!set) map.set(parent, (set = new Set()));
        set.add(draft.namespace[i - 1]!);
      }
    }
    return map;
  };

  const children = childNames();
  const nameCounts = new Map<string, Map<string, number>>();
  for (const draft of drafts) {
    const key = nodeKey(draft.namespace);
    let counts = nameCounts.get(key);
    if (!counts) nameCounts.set(key, (counts = new Map()));
    counts.set(draft.name, (counts.get(draft.name) ?? 0) + 1);
  }

  for (const draft of drafts) {
    const key = nodeKey(draft.namespace);
    const duplicated = (nameCounts.get(key)?.get(draft.name) ?? 0) > 1;
    const shadowsNamespace = children.get(key)?.has(draft.name) === true;
    if (!duplicated && !shadowsNamespace) continue;
    draft.namespace = [...draft.namespace, draft.name];
    draft.name = verbFor(draft.op.method, draft.endsWithParam, draft.responseIsArray);
  }

  // Anything the repair pass couldn't separate falls back to the operationId,
  // which the spec guarantees is unique. Loud, because it means the SDK grew a
  // name nobody would guess.
  const afterChildren = childNames();
  const claimed = new Map<string, Set<string>>();
  for (const draft of drafts) {
    const key = nodeKey(draft.namespace);
    let taken = claimed.get(key);
    if (!taken) claimed.set(key, (taken = new Set()));
    const conflicts = taken.has(draft.name) || afterChildren.get(key)?.has(draft.name) === true;
    if (conflicts) {
      const fallback = camelCase(draft.op.id);
      warn(
        `${draft.op.method.toUpperCase()} ${draft.op.path}: "${nodeKey([...draft.namespace, draft.name])}" ` +
          `is taken, falling back to operationId "${nodeKey([...draft.namespace, fallback])}"`,
      );
      draft.name = fallback;
    }
    taken.add(draft.name);
  }
}

// ---------------------------------------------------------------------------
// Operation lowering
// ---------------------------------------------------------------------------

function pickContent(
  content: Record<string, { schema?: unknown }> | undefined,
): { mediaType: string; schema: unknown } | null {
  if (!content) return null;
  const entries = Object.entries(content);
  if (entries.length === 0) return null;
  const json = entries.find(([type]) => type.includes("json"));
  const [mediaType, value] = json ?? entries[0]!;
  return { mediaType, schema: value?.schema };
}

function lowerResponse(
  status: string,
  raw: { description?: string; content?: Record<string, { schema?: unknown }> } | undefined,
): ResponseDef {
  const picked = pickContent(raw?.content);
  if (!picked) {
    return {
      status,
      encoding: "empty",
      type: null,
      ...(raw?.description ? { description: raw.description } : {}),
    };
  }
  const isJson = picked.mediaType.includes("json");
  return {
    status,
    encoding: isJson ? "json" : "binary",
    type: isJson ? toTypeRef(picked.schema) : null,
    ...(raw?.description ? { description: raw.description } : {}),
  };
}

function lowerOperation(
  path: string,
  method: HttpMethod,
  raw: RawOperation,
  scopeParam: string | null,
): OperationDef {
  const parameters: ParameterDef[] = (raw.parameters ?? [])
    .filter((p) => p.in === "path" || p.in === "query")
    .map((p) => {
      // zod-to-openapi puts `.describe()` text on the parameter's schema rather
      // than on the parameter itself, so fall through to it.
      const schemaDescription = (p.schema as JsonMap | null | undefined)?.["description"];
      const description =
        p.description ?? (typeof schemaDescription === "string" ? schemaDescription : undefined);
      return {
        name: p.name,
        in: p.in as "path" | "query",
        required: p.required === true,
        type: toTypeRef(p.schema),
        ...(description ? { description } : {}),
        defaultable: p.in === "path" && p.name === scopeParam,
      };
    });

  const bodyContent = pickContent(raw.requestBody?.content);
  const body = bodyContent
    ? {
        required: raw.requestBody?.required === true,
        encoding: (bodyContent.mediaType.includes("multipart") ? "multipart" : "json") as
          | "json"
          | "multipart",
        type: toTypeRef(bodyContent.schema),
      }
    : null;

  const responses = raw.responses ?? {};
  const successStatus =
    Object.keys(responses)
      .filter((code) => /^2\d\d$/.test(code))
      .sort()[0] ?? "200";
  const response = lowerResponse(successStatus, responses[successStatus]);
  const errors = Object.keys(responses)
    .filter((code) => !/^2\d\d$/.test(code))
    .sort()
    .map((code) => lowerResponse(code, responses[code]));

  const permission = raw["x-required-permission"];

  return {
    id: raw.operationId ?? `${method}${path}`,
    method,
    path,
    namespace: [],
    name: "",
    ...(raw.summary ? { summary: raw.summary } : {}),
    ...(raw.description ? { description: raw.description } : {}),
    deprecated: raw.deprecated === true,
    tags: raw.tags ?? [],
    ...(typeof permission === "string" ? { requiredPermission: permission } : {}),
    parameters,
    body,
    response,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface BuildIrOptions {
  /** Called for anything a reader should know about but that isn't fatal. */
  warn?: (message: string) => void;
}

/** Lower a full OpenAPI document (internal routes included) into the SDK IR. */
export function buildSdkIr(document: object, opts: BuildIrOptions = {}): SdkIr {
  const warn = opts.warn ?? (() => {});
  const doc = toPublicDocument(document) as RawDocument;

  const paths = doc.paths ?? {};
  const pathNames = Object.keys(paths).sort();
  const scopeParam = detectDefaultablePathParam(pathNames);

  const drafts: Draft[] = [];
  for (const path of pathNames) {
    const item = paths[path];
    if (!item) continue;
    for (const method of HTTP_METHODS) {
      const raw = item[method] as RawOperation | undefined;
      if (!raw || typeof raw !== "object") continue;
      const op = lowerOperation(path, method, raw, scopeParam);

      const segs = namingSegments(path, scopeParam);
      const last = segs[segs.length - 1];
      const endsWithParam = last !== undefined && PARAM_SEGMENT.test(last);
      const staticSegs = segs
        .filter((s) => !PARAM_SEGMENT.test(s))
        .map(camelCase)
        .filter(Boolean);
      const responseIsArray = op.response.type?.kind === "array";

      let namespace: string[];
      let name: string;
      if (staticSegs.length === 0) {
        namespace = [];
        name = camelCase(op.id);
      } else if (endsWithParam || staticSegs.length === 1) {
        namespace = staticSegs;
        name = verbFor(method, endsWithParam, responseIsArray);
      } else {
        namespace = staticSegs.slice(0, -1);
        name = staticSegs[staticSegs.length - 1]!;
      }

      drafts.push({ op, namespace, name, endsWithParam, responseIsArray });
    }
  }

  deriveNames(drafts, warn);

  const operations = drafts.map((draft) => {
    draft.op.namespace = draft.namespace;
    draft.op.name = draft.name;
    return draft.op;
  });

  const root: NamespaceDef = { path: [], children: new Map(), operations: [] };
  for (const op of operations) {
    let node = root;
    for (let i = 0; i < op.namespace.length; i++) {
      const segment = op.namespace[i]!;
      let child = node.children.get(segment);
      if (!child) {
        child = { path: op.namespace.slice(0, i + 1), children: new Map(), operations: [] };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.operations.push(op);
  }
  sortNamespace(root);

  const schemas: SchemaDef[] = Object.entries(doc.components?.schemas ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, schema]) => {
      const description = (schema as JsonMap | null)?.["description"];
      return {
        name,
        ...(typeof description === "string" ? { description } : {}),
        type: toTypeRef(schema),
      };
    });

  const bearerScheme =
    Object.entries(doc.components?.securitySchemes ?? {}).find(
      ([, scheme]) => scheme?.type === "http" && scheme?.scheme === "bearer",
    )?.[0] ?? null;

  const servers = doc.servers ?? [];

  return {
    apiVersion: doc.info?.version ?? "0.0.0",
    title: doc.info?.title ?? "API",
    ...(doc.info?.description ? { description: doc.info.description } : {}),
    baseUrl: servers[0]?.url ?? "http://localhost:3000",
    servers,
    defaultablePathParam: scopeParam,
    bearerScheme,
    schemas,
    operations,
    root,
  };
}

function sortNamespace(node: NamespaceDef): void {
  node.operations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const sorted = [...node.children.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  node.children.clear();
  for (const [key, child] of sorted) {
    node.children.set(key, child);
    sortNamespace(child);
  }
}
