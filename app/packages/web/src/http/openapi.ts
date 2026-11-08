/**
 * Every operation of the OpenAPI document, and the components they use.
 *
 * Each domain in `./domains.ts` is generated from its endpoint definitions,
 * normalised here, and merged by `buildOpenApiDocument`
 * (`api/openapi/index.ts`) onto a base of plain data (info, servers, security
 * schemes, tags, the plugin registry's enums and the event webhooks) before
 * the shared post-processing (operation ids, permission notes, internal
 * markers, the public-spec strip). A route documents itself: its schemas are
 * the ones its requests are decoded with.
 */
import { Context, Predicate } from "effect";
import {
  DocumentedPermission,
  Internal,
  RequiredPermission,
  Security,
  SuccessDescription,
} from "@infrawrench/api-contract";
import type { Domain } from "./domain";

type JsonObject = Record<string, unknown>;

const METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;

export interface OpenApiFragment {
  readonly paths: Record<string, Record<string, JsonObject>>;
  readonly schemas: Record<string, unknown>;
  readonly tags: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
  /** Component names two domains defined differently; the spec test fails on any. */
  readonly conflicts: readonly string[];
}

interface GeneratedDocument {
  paths: Record<string, Record<string, JsonObject>>;
  components?: { schemas?: Record<string, unknown> };
  tags?: Array<{ name: string; description?: string }>;
}

function isOpenApiDocument(value: unknown): value is GeneratedDocument {
  return (
    Predicate.isObject(value) &&
    Predicate.hasProperty(value, "paths") &&
    Predicate.isObject(value.paths)
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

/** The response descriptions the hand-written spec used for each error status. */
const ERROR_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "400": "Bad request",
  "401": "Unauthenticated",
  "402": "Payment required: the organization's plan does not include this",
  "403": "Forbidden",
  "404": "Not found",
  "409": "Conflict",
  "410": "Gone: the file expired or was deleted",
  "422": "Unprocessable: the request is well formed but cannot be acted on",
  "500": "Server error",
  "502": "Bad gateway: an upstream service failed",
  "503": "A backing service this endpoint depends on is not available",
  "504": "Gateway timeout: an upstream service did not answer in time",
};

const REF_PREFIX = "#/components/schemas/";

/** Visit every `$ref` in `node`, replacing the referencing object with what `fn` returns. */
function rewriteRefs(node: unknown, fn: (name: string, holder: JsonObject) => JsonObject): unknown {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, fn));
  if (!Predicate.isObject(node)) return node;
  const obj = node as JsonObject;
  const ref = obj["$ref"];
  if (typeof ref === "string" && ref.startsWith(REF_PREFIX)) {
    return fn(ref.slice(REF_PREFIX.length), obj);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, rewriteRefs(v, fn)]));
}

const withoutDescription = (schema: unknown) => {
  if (!Predicate.isObject(schema)) return schema;
  const { description: _description, ...rest } = schema as JsonObject;
  return rest;
};

/**
 * Effect names a re-annotated schema `Name_1` and a class's wire form
 * `NameEncoded`, where the hand-written spec had one `Name` component. Fold
 * every variant that differs from `Name` only in its description back into
 * `Name`, keeping the variant's description at the reference. Variants that
 * really differ keep their names, and are reported.
 */
function canonicalizeOnce(spec: GeneratedDocument, conflicts: string[]): boolean {
  const schemas = spec.components?.schemas;
  if (!schemas) return false;
  const baseOf = (name: string) => name.replace(/_\d+$/, "").replace(/Encoded$/, "");
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(schemas)) {
    const base = baseOf(name);
    groups.set(base, [...(groups.get(base) ?? []), name]);
  }
  const renames = new Map<string, { to: string; description: unknown }>();
  for (const [base, names] of groups) {
    if (names.length === 1 && names[0] === base) continue;
    const canonicalName = names.includes(base) ? base : names[0]!;
    const canonical = stableStringify(withoutDescription(schemas[canonicalName]));
    const canonicalDescription = Predicate.isObject(schemas[canonicalName])
      ? (schemas[canonicalName] as JsonObject)["description"]
      : undefined;
    for (const name of names) {
      if (stableStringify(withoutDescription(schemas[name])) !== canonical) {
        conflicts.push(`schema ${name} differs from ${canonicalName}`);
        continue;
      }
      const description = Predicate.isObject(schemas[name])
        ? (schemas[name] as JsonObject)["description"]
        : undefined;
      renames.set(name, {
        to: base,
        description: description === canonicalDescription ? undefined : description,
      });
    }
    if (renames.has(canonicalName) && canonicalName !== base) {
      schemas[base] = schemas[canonicalName];
    }
  }
  // Only a variant folded into another name changes anything worth another pass.
  if (![...renames].some(([name, rename]) => name !== rename.to)) return false;
  const rewritten = rewriteRefs(spec, (name, holder) => {
    const rename = renames.get(name);
    if (!rename) return holder;
    return {
      ...holder,
      $ref: `${REF_PREFIX}${rename.to}`,
      ...(rename.description !== undefined && holder["description"] === undefined
        ? { description: rename.description }
        : {}),
    };
  });
  if (Predicate.isObject(rewritten)) Object.assign(spec, rewritten);
  // The rewrite copied every object, so delete from the document's own map now.
  const folded = spec.components?.schemas ?? schemas;
  for (const [name, rename] of renames) {
    if (name !== rename.to) delete folded[name];
  }
  // The canonical keeps no description of its own when its variants disagreed.
  for (const name of new Set([...renames.values()].map((r) => r.to))) {
    const schema = spec.components?.schemas?.[name];
    if (Predicate.isObject(schema) && name === "Error")
      delete (schema as JsonObject)["description"];
  }
  return true;
}

/**
 * {@link canonicalizeOnce} until nothing more folds. A component embedding a
 * variant (`Parent_1` pointing at `Child_1`) only matches its canonical once
 * the child has been folded, so a pass that renamed something is repeated,
 * and only the last pass's conflicts are real.
 */
function canonicalizeComponents(spec: GeneratedDocument, conflicts: string[]): void {
  for (;;) {
    const pass: string[] = [];
    if (!canonicalizeOnce(spec, pass)) {
      conflicts.push(...pass);
      return;
    }
  }
}

/** OpenAPI path for an endpoint path: `/a/:id` to `/a/{id}`. */
const toOpenApiPath = (path: string) => path.replace(/:(\w+)\??/g, "{$1}");

/** Generate and normalise every domain's operations and components. */
export function buildOpenApiFragment(domains: readonly Domain[]): OpenApiFragment {
  const paths: Record<string, Record<string, JsonObject>> = {};
  const schemas: Record<string, unknown> = {};
  const tags = new Map<string, { name: string; description?: string }>();
  const conflicts: string[] = [];

  for (const domain of domains) {
    const spec: unknown = JSON.parse(JSON.stringify(domain.openapi()));
    if (!isOpenApiDocument(spec)) throw new Error(`${domain.name}: not an OpenAPI document`);

    canonicalizeComponents(spec, conflicts);

    const annotationsByOperation = new Map<string, Context.Context<never>>();
    const defaultIds = new Map<string, string>();
    for (const endpoint of domain.endpoints()) {
      const key = `${endpoint.method.toLowerCase()} ${toOpenApiPath(endpoint.path)}`;
      annotationsByOperation.set(key, endpoint.annotations);
      defaultIds.set(key, endpoint.defaultOperationId);
    }

    for (const [path, item] of Object.entries(spec.paths)) {
      const target = (paths[path] ??= {});
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        const key = `${method} ${path}`;
        const annotations = annotationsByOperation.get(key) ?? Context.empty();
        // Ids are derived from method and path by the shared post-processing,
        // exactly as for the Zod routes; keep only one chosen deliberately.
        if (op["operationId"] === defaultIds.get(key)) delete op["operationId"];
        const security = Context.get(annotations, Security);
        if (security === undefined) delete op["security"];
        else op["security"] = security;
        const permission =
          Context.get(annotations, RequiredPermission) ??
          Context.get(annotations, DocumentedPermission);
        if (permission !== undefined) op["x-required-permission"] = permission;
        if (Context.get(annotations, Internal)) op["x-internal"] = true;
        const successDescription = Context.get(annotations, SuccessDescription);
        const responses = op["responses"];
        if (Predicate.isObject(responses)) {
          for (const [status, response] of Object.entries(responses)) {
            if (!Predicate.isObject(response)) continue;
            const entry = response as JsonObject;
            if (status.startsWith("2") && successDescription !== undefined) {
              entry["description"] = successDescription;
            } else if (entry["description"] === "Error" && ERROR_DESCRIPTIONS[status]) {
              entry["description"] = ERROR_DESCRIPTIONS[status];
            }
          }
        }
        if (Array.isArray(op["parameters"]) && op["parameters"].length === 0) {
          delete op["parameters"];
        }
        if (target[method]) conflicts.push(`operation ${key}`);
        target[method] = op;
      }
    }

    for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
      const existing = schemas[name];
      if (existing !== undefined && stableStringify(existing) !== stableStringify(schema)) {
        conflicts.push(`schema ${name}`);
        continue;
      }
      schemas[name] = schema;
    }
    // A group whose endpoints are all excluded still emits its tag; publish
    // only the tags an operation in this domain carries, or the reference
    // shows empty sections.
    const used = new Set<string>();
    for (const item of Object.values(spec.paths)) {
      for (const method of METHODS) {
        const opTags = item[method]?.["tags"];
        if (Array.isArray(opTags))
          for (const tag of opTags) if (typeof tag === "string") used.add(tag);
      }
    }
    for (const tag of spec.tags ?? []) {
      if (used.has(tag.name) && !tags.has(tag.name)) tags.set(tag.name, tag);
    }
  }

  return { paths, schemas, tags: [...tags.values()], conflicts };
}

/**
 * Merge a fragment into the base document. A component the base also defines
 * (`EventSeverity`, which the event webhooks share with the event
 * subscription routes) must be defined identically, and an operation the
 * base already has is a second definition of one route; both fail loudly
 * rather than documenting one of the two.
 */
export function mergeOpenApiFragment(
  doc: {
    paths: Record<string, Record<string, JsonObject>>;
    components: { schemas: Record<string, unknown> };
    tags: Array<{ name: string; description?: string }>;
  },
  fragment: OpenApiFragment,
): void {
  const conflicts = [...fragment.conflicts];
  for (const [path, item] of Object.entries(fragment.paths)) {
    const target = (doc.paths[path] ??= {});
    for (const [method, op] of Object.entries(item)) {
      if (target[method]) conflicts.push(`operation ${method} ${path}`);
      target[method] = op;
    }
  }
  const schemas = doc.components.schemas;
  for (const [name, schema] of Object.entries(fragment.schemas)) {
    const existing = schemas[name];
    if (existing !== undefined && stableStringify(existing) !== stableStringify(schema)) {
      conflicts.push(`schema ${name} differs from the base document's`);
    }
    schemas[name] = schema;
  }
  if (conflicts.length > 0) {
    throw new Error(`The OpenAPI document has conflicting definitions: ${conflicts.join(", ")}`);
  }
  for (const tag of fragment.tags) {
    if (!doc.tags.some((t) => t.name === tag.name)) doc.tags.push(tag);
  }
}

/**
 * Every endpoint's permission gate, `RequiredPermission` or
 * `DocumentedPermission`, keyed by method and the path after
 * `/api/org/{orgId}` (`"GET /slos/{id}"`), for checks that ask "what does this
 * route require".
 */
export function requiredPermissionIndex(domains: readonly Domain[]): Record<string, string> {
  const index: Record<string, string> = {};
  for (const domain of domains) {
    for (const endpoint of domain.endpoints()) {
      const permission =
        Context.get(endpoint.annotations, RequiredPermission) ??
        Context.get(endpoint.annotations, DocumentedPermission);
      if (permission === undefined) continue;
      const path = toOpenApiPath(endpoint.path).replace(/^\/api\/org\/\{orgId\}/, "") || "/";
      index[`${endpoint.method.toUpperCase()} ${path}`] = permission;
    }
  }
  return index;
}
