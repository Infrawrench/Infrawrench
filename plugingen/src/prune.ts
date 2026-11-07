import { HTTP_METHODS, isHttpMethod, type HttpMethod } from "./config.js";
import { PluginGenError } from "./errors.js";
import { isObject, type JsonObject, type JsonValue } from "./json.js";
import { child, decodeSegment, resolvePointer } from "./pointer.js";

/** A discriminator's `mapping`, if it is one rather than a property called that. */
function mappingTargets(discriminator: JsonValue | undefined): string[] | undefined {
  const mapping = isObject(discriminator) ? discriminator["mapping"] : undefined;
  if (!isObject(mapping)) return undefined;
  const targets = Object.values(mapping);
  return targets.every((target) => typeof target === "string")
    ? targets.filter((target) => typeof target === "string")
    : undefined;
}

function collectRefs(node: JsonValue | undefined, out: Set<string>, mappings: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out, mappings);
  } else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/")) {
        out.add(value);
        continue;
      }
      // A mapping names schemas without a `$ref`, and a schema reached only this
      // way must survive pruning: the document does not validate without it. It may
      // also name one bare, with no pointer at all.
      const targets = key === "discriminator" ? mappingTargets(value) : undefined;
      if (targets) {
        for (const target of targets) {
          const ref = target.startsWith("#/") ? target : `#/components/schemas/${target}`;
          out.add(ref);
          mappings.add(ref);
        }
      } else {
        collectRefs(value, out, mappings);
      }
    }
  }
}

/**
 * Bundlers point one operation at a schema inside another (`#/paths/...`), which
 * pruning may remove, or inside a component (`#/components/schemas/Tag/allOf/0`),
 * which openapi-typescript renders as a property the type does not have. Put the
 * schema where it is used.
 */
export function inlineDeepRefs(doc: JsonObject): void {
  const deep = /^#\/(paths\/|components\/[^/]+\/[^/]+\/)/;
  const expand = (
    node: JsonValue | undefined,
    within: ReadonlySet<string>,
  ): JsonValue | undefined => {
    if (Array.isArray(node)) return node.map((item) => expand(item, within) ?? null);
    if (!isObject(node)) return node;
    const ref = node["$ref"];
    if (typeof ref === "string" && deep.test(ref) && !within.has(ref)) {
      return expand(resolvePointer(doc, ref), new Set(within).add(ref));
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, expand(v, within)]));
  };
  doc["paths"] = expand(doc["paths"], new Set());
  doc["components"] = expand(doc["components"], new Set());
}

export function stripPathPrefix(doc: JsonObject, prefix: string): void {
  const paths = doc["paths"];
  const kept = Object.entries(isObject(paths) ? paths : {}).filter(([route]) =>
    route.startsWith(`${prefix}/`),
  );
  if (kept.length === 0) {
    throw new PluginGenError("operation-removed", `No path in the document starts with ${prefix}/`);
  }
  doc["paths"] = Object.fromEntries(
    kept.map(([route, item]) => [route.slice(prefix.length), item]),
  );
}

/** Keep the listed operations and everything they transitively reference. */
export function prune(doc: JsonObject, wanted: Readonly<Record<string, HttpMethod[]>>): JsonObject {
  const paths: JsonObject = {};
  for (const [route, methods] of Object.entries(wanted)) {
    const item = child(doc["paths"], route);
    if (!isObject(item)) {
      throw new PluginGenError("operation-removed", `${route} is not in the document`);
    }
    const kept: JsonObject = {};
    for (const [key, value] of Object.entries(item)) {
      if (!isHttpMethod(key) || methods.includes(key)) kept[key] = value;
    }
    for (const method of methods) {
      if (!child(item, method)) {
        throw new PluginGenError(
          "operation-removed",
          `${method.toUpperCase()} ${route} is not in the document`,
        );
      }
    }
    paths[route] = kept;
  }

  const seen = new Set<string>();
  const queue = new Set<string>();
  const mappings = new Set<string>();
  collectRefs(paths, queue, mappings);
  for (const ref of queue) {
    queue.delete(ref);
    if (seen.has(ref)) continue;
    seen.add(ref);
    const target = resolvePointer(doc, ref);
    if (target === undefined) {
      // A mapping's value need not lead anywhere (OpenRouter's does not); a `$ref` must.
      if (mappings.has(ref)) continue;
      throw new PluginGenError("parse", `Dangling reference ${ref}`);
    }
    const next = new Set<string>();
    collectRefs(target, next, mappings);
    for (const found of next) if (!seen.has(found)) queue.add(found);
  }

  // Nothing else survives: `webhooks` and `x-webhooks` point into `components`, and
  // whatever they reach has just been left out of it.
  const components: Record<string, JsonObject> = {};
  const pruned: JsonObject = { openapi: doc["openapi"], info: doc["info"], paths, components };
  for (const ref of seen) {
    const [root, section, name] = ref.slice(2).split("/");
    if (root !== "components" || section === undefined || name === undefined) continue;
    const decodedSection = decodeSegment(section);
    const decodedName = decodeSegment(name);
    (components[decodedSection] ??= {})[decodedName] = child(
      child(doc["components"], decodedSection),
      decodedName,
    );
  }
  return pruned;
}

/** Keywords that only feed doc comments, which were 73% of Hetzner's generated bytes. */
const DOC_KEYWORDS: ReadonlySet<string> = new Set([
  "description",
  "title",
  "summary",
  "example",
  "examples",
  "externalDocs",
]);
/** Under these, keys are names a provider chose, so `description` may be a real field. */
const NAME_MAPS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "schemas",
  "$defs",
  "headers",
]);
const LITERAL_VALUES: ReadonlySet<string> = new Set(["default", "enum", "const"]);
const EXTERNAL_KEYS: ReadonlySet<string> = new Set(["$ref", "externalValue"]);

export function withoutDocs(node: JsonObject): JsonObject;
export function withoutDocs(
  node: JsonValue | undefined,
  keysAreNames?: boolean,
): JsonValue | undefined;
export function withoutDocs(node: JsonValue | undefined, keysAreNames = false) {
  if (Array.isArray(node)) return node.map((item) => withoutDocs(item) ?? null);
  if (!isObject(node)) return node;
  const kept: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (keysAreNames) kept[key] = withoutDocs(value);
    else if (LITERAL_VALUES.has(key)) kept[key] = value;
    else if (!DOC_KEYWORDS.has(key)) kept[key] = withoutDocs(value, NAME_MAPS.has(key));
  }
  return kept;
}

/**
 * The client only ever returns a 2xx body; errors reach callers as a message. An
 * operation with no 2xx says how it succeeds under `default`, if anywhere (Gemini's
 * document does this throughout), so that stands in for a 200.
 */
export function dropErrorResponses(doc: JsonObject): void {
  const paths = doc["paths"];
  for (const item of Object.values(isObject(paths) ? paths : {})) {
    for (const method of HTTP_METHODS) {
      const responses = child(child(item, method), "responses");
      if (!isObject(responses)) continue;
      const codes = Object.keys(responses);
      if (responses["default"] && !codes.some((code) => code.startsWith("2"))) {
        responses["200"] = responses["default"];
      }
      for (const code of codes) {
        if (!code.startsWith("2")) delete responses[code];
      }
    }
  }
}

function hasExternalRef(node: JsonValue | undefined): boolean {
  if (Array.isArray(node)) return node.some(hasExternalRef);
  if (!isObject(node)) return false;
  return Object.entries(node).some(
    ([key, value]) =>
      (EXTERNAL_KEYS.has(key) && typeof value === "string" && !value.startsWith("#")) ||
      hasExternalRef(value),
  );
}

/**
 * Redocly follows any `$ref` or `externalValue` it finds, over HTTP and on the local
 * disk, and treats a mapping value that looks like a path as a reference. Only ever
 * resolve inside the document: otherwise a vendor document could pull a file from the
 * runner into generated code, or make the runner call any address.
 *
 * It follows them inside an `x-` extension too, even though nothing there can reach
 * the types, and real documents do hold them there (Cohere's code samples). So an
 * extension holding one is removed, and anywhere else it fails the run. Getting a name
 * map wrong is safe either way: it removes the reference, or it refuses the document.
 */
export function containExternalRefs(node: JsonValue | undefined, keysAreNames = false): void {
  if (Array.isArray(node)) {
    for (const item of node) containExternalRefs(item);
    return;
  }
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (keysAreNames) {
      containExternalRefs(value);
      continue;
    }
    if (LITERAL_VALUES.has(key)) continue;
    if (key.startsWith("x-")) {
      if (hasExternalRef(value)) delete node[key];
      continue;
    }
    if (EXTERNAL_KEYS.has(key) && typeof value === "string" && !value.startsWith("#")) {
      throw new PluginGenError("unsafe", `The document refers outside itself: ${value}`);
    }
    for (const target of key === "discriminator" ? (mappingTargets(value) ?? []) : []) {
      if (!target.startsWith("#") && /[/\\]|\.(json|ya?ml)$/i.test(target)) {
        throw new PluginGenError(
          "unsafe",
          `A discriminator refers outside the document: ${target}`,
        );
      }
    }
    containExternalRefs(value, NAME_MAPS.has(key));
  }
}
