import { isObject, type JsonObject, type JsonValue } from "./json.js";
import { resolvePointer } from "./pointer.js";

const SCHEMA_PREFIX = "#/components/schemas/";

/** A mapping target as a pointer, because OpenAPI lets it name a schema bare. */
function asPointer(target: string): string {
  return target.startsWith("#") ? target : `${SCHEMA_PREFIX}${target}`;
}

function refOf(node: JsonValue | undefined): string | undefined {
  const ref = isObject(node) ? node["$ref"] : undefined;
  return typeof ref === "string" && ref.startsWith("#/") ? ref : undefined;
}

/** What a schema for the discriminator's property says it can be, through any `$ref`. */
function literalsOf(doc: JsonObject, schema: JsonValue | undefined, seen: Set<string>): string[] {
  const ref = refOf(schema);
  if (ref) {
    if (seen.has(ref)) return [];
    seen.add(ref);
    return literalsOf(doc, resolvePointer(doc, ref), seen);
  }
  if (!isObject(schema)) return [];
  if (typeof schema["const"] === "string") return [schema["const"]];
  const values = schema["enum"];
  return Array.isArray(values) ? values.filter((v) => typeof v === "string") : [];
}

/**
 * The values a member declares for `property`, or none if it does not say. Its own
 * properties come first, then the inline parts of an `allOf`, then what it inherits,
 * because a base's enum usually lists every member's value rather than this one's.
 */
function declaredValues(
  doc: JsonObject,
  member: JsonValue | undefined,
  property: string,
  seen: Set<string>,
  inherit: boolean,
): string[] {
  const ref = refOf(member);
  if (ref) {
    if (seen.has(ref)) return [];
    seen.add(ref);
    return declaredValues(doc, resolvePointer(doc, ref), property, seen, inherit);
  }
  if (!isObject(member)) return [];
  const properties = member["properties"];
  if (isObject(properties) && Object.hasOwn(properties, property)) {
    const literals = literalsOf(doc, properties[property], new Set());
    if (literals.length > 0) return literals;
  }
  const parts = Array.isArray(member["allOf"]) ? member["allOf"] : [];
  for (const part of parts.filter((p) => !refOf(p))) {
    const found = declaredValues(doc, part, property, seen, inherit);
    if (found.length > 0) return found;
  }
  if (!inherit) return [];
  for (const part of parts.filter((p) => refOf(p))) {
    const found = declaredValues(doc, part, property, seen, inherit);
    if (found.length > 0) return found;
  }
  return [];
}

/** Add `values` for `target`, keeping whatever the document already gave a value to. */
function addValues(mapping: JsonObject, values: readonly string[], target: string): void {
  for (const value of values) {
    if (!Object.hasOwn(mapping, value)) mapping[value] = target;
  }
}

function mappingOf(discriminator: JsonObject): JsonObject {
  const written = discriminator["mapping"];
  const mapping: JsonObject = {};
  if (!isObject(written)) return mapping;
  for (const [value, target] of Object.entries(written)) {
    if (typeof target === "string") mapping[value] = asPointer(target);
  }
  return mapping;
}

function mappedTargets(mapping: JsonObject): Set<JsonValue | undefined> {
  return new Set(Object.values(mapping));
}

/** A `oneOf` with a discriminator: each member is a `$ref` it may leave out of the mapping. */
function completeUnion(doc: JsonObject, schema: JsonObject, discriminator: JsonObject): void {
  const property = discriminator["propertyName"];
  const members = schema["oneOf"];
  if (typeof property !== "string" || !Array.isArray(members)) return;
  const mapping = mappingOf(discriminator);
  const mapped = mappedTargets(mapping);
  for (const member of members) {
    const target = refOf(member);
    if (!target || mapped.has(target)) continue;
    addValues(mapping, declaredValues(doc, member, property, new Set(), true), target);
  }
  discriminator["mapping"] = mapping;
}

/**
 * A discriminator on a base, with the members being whatever has it in an `allOf`. Only a
 * child's own declaration counts, because the base's enum says nothing about one child.
 */
function completeBase(
  doc: JsonObject,
  name: string,
  discriminator: JsonObject,
  schemas: JsonObject,
): void {
  const property = discriminator["propertyName"];
  if (typeof property !== "string") return;
  const base = `${SCHEMA_PREFIX}${name}`;
  const mapping = mappingOf(discriminator);
  const mapped = mappedTargets(mapping);
  for (const [childName, child] of Object.entries(schemas)) {
    const target = `${SCHEMA_PREFIX}${childName}`;
    const parts = isObject(child) ? child["allOf"] : undefined;
    if (mapped.has(target) || !Array.isArray(parts)) continue;
    if (!parts.some((part) => refOf(part) === base)) continue;
    addValues(mapping, declaredValues(doc, child, property, new Set(), false), target);
  }
  discriminator["mapping"] = mapping;
}

/**
 * Tell openapi-typescript what each discriminated schema's discriminator really is.
 *
 * With no `mapping`, or a target it does not list, it writes the schema's own name over
 * the property: `type: "TranscriptTextUsageDuration"` for a schema whose `type` is the
 * enum `duration`. That is the implicit mapping OpenAPI describes, and the wrong answer
 * for a document that says otherwise, so a comparison against the real value does not
 * compile. An `allOf` member that declares it comes out as `never`.
 *
 * This writes the missing entries from what each member declares, which is the document
 * saying the same thing a second way. A member that declares nothing keeps the schema's
 * name, and a mapping the document wrote wins. A value two members share goes to the
 * first, because a mapping cannot say otherwise. The output changes only where the old
 * literal was not the declared one, since it goes down the same path with another value.
 */
export function completeDiscriminatorMappings(doc: JsonObject): void {
  const components = doc["components"];
  const schemas = isObject(components) ? components["schemas"] : undefined;
  const visit = (node: JsonValue | undefined): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isObject(node)) return;
    const discriminator = node["discriminator"];
    if (isObject(discriminator) && Array.isArray(node["oneOf"])) {
      completeUnion(doc, node, discriminator);
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(doc);
  if (!isObject(schemas)) return;
  for (const [name, schema] of Object.entries(schemas)) {
    const discriminator = isObject(schema) ? schema["discriminator"] : undefined;
    if (isObject(discriminator) && !Array.isArray(isObject(schema) ? schema["oneOf"] : undefined)) {
      completeBase(doc, name, discriminator, schemas);
    }
  }
}
