import { Option, Predicate, Schema, SchemaAST } from "effect";
import { NORMALIZED_BEFORE_CHECKS } from "@infrawrench/api-contract/schemas";

export interface ToolInputJsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

type JsonNode = Record<string, unknown>;

/**
 * A tool's input fields as JSON Schema, for both the MCP server and the chat
 * agent's provider tool definitions: `{ type: "object", properties,
 * required? }`, the envelope both take.
 *
 * Effect writes draft 2020-12, which both model APIs accept, with every
 * schema inline (no `$ref`/`$defs`: the reference policy names nothing) and
 * nested objects closed (`additionalProperties: false`), as the strip-mode
 * objects they decode as were documented before. Each property describes the
 * value as sent: the encoded side of a transformation, and none of the
 * bounds of a string that is lower- or upper-cased before it is checked
 * ({@link NORMALIZED_BEFORE_CHECKS}), since the MCP SDK validates the raw
 * call against this document and `Active-Customers` is a key the handler
 * accepts.
 *
 * {@link tidy} then states each property the plain way MCP clients and the
 * connector directory read: a union of bare types as a `type` list, no
 * single-branch `anyOf`, `anyOf` for every union, and integers without the
 * safe-integer range Effect adds to each one. Defaults applied while decoding
 * are written as `default`, which Effect documents only when annotated.
 *
 * Fields are converted one at a time and cached by schema, so the per-request
 * MCP server and every chat turn reuse the work for the same field.
 */
export function toolInputJsonSchema(fields: Schema.Struct.Fields): ToolInputJsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(fields)) {
    const converted = fieldJsonSchema(field);
    properties[key] = structuredClone(converted.schema);
    if (converted.required) required.push(key);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

interface ConvertedField {
  readonly schema: JsonNode;
  readonly required: boolean;
}

const fieldCache = new WeakMap<Schema.Constraint, ConvertedField>();

function fieldJsonSchema(field: Schema.Constraint): ConvertedField {
  const cached = fieldCache.get(field);
  if (cached) return cached;
  const holder = Schema.Struct({ field });
  const { schema } = Schema.toJsonSchemaDocument(holder, {
    referencePolicy: () => undefined,
    onExcessProperty: "error",
    includeAnnotationKey: (key) => key === NORMALIZED_BEFORE_CHECKS,
  });
  const document = schema as { properties?: JsonNode; required?: ReadonlyArray<string> };
  const property = document.properties?.["field"];
  const node: JsonNode = Predicate.isObject(property) ? (property as JsonNode) : {};
  writeDecodingDefaults(holder.ast, document as JsonNode);
  const converted: ConvertedField = {
    schema: tidy(node) as JsonNode,
    required: document.required?.includes("field") ?? false,
  };
  fieldCache.set(field, converted);
  return converted;
}

/* ------------------------------ defaults ------------------------------ */

const defaultCache = new WeakMap<SchemaAST.AST, Option.Option<unknown>>();

/**
 * What decoding fills in for a property when its key is absent, if anything:
 * the default of `Schema.withDecodingDefaultKey`, found by decoding an object
 * without the key.
 */
function decodingDefault(property: SchemaAST.PropertySignature): Option.Option<unknown> {
  const cached = defaultCache.get(property.type);
  if (cached) return cached;
  const holder = Schema.Struct({ value: Schema.make<Schema.Codec<unknown>>(property.type) });
  const value = Option.flatMap(Schema.decodeUnknownOption(holder)({}), (object) =>
    "value" in object && isJson(object.value) ? Option.some(object.value) : Option.none(),
  );
  defaultCache.set(property.type, value);
  return value;
}

function isJson(value: unknown): boolean {
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) return true;
  if (Predicate.isNumber(value)) return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return Predicate.isObject(value) && Object.values(value).every(isJson);
}

/**
 * Walks the schema and its document together, writing `default` on every
 * property whose key decoding fills in. Objects, arrays and unions are
 * followed where the document mirrors them; anything else is left alone.
 */
function writeDecodingDefaults(ast: SchemaAST.AST, node: unknown): void {
  if (!Predicate.isObject(node)) return;
  const json = node as JsonNode;
  if (SchemaAST.isObjects(ast)) {
    const properties = json["properties"];
    if (!Predicate.isObject(properties)) return;
    for (const property of ast.propertySignatures) {
      if (!Predicate.isString(property.name)) continue;
      const child = (properties as JsonNode)[property.name];
      if (!Predicate.isObject(child)) continue;
      const value = decodingDefault(property);
      if (Option.isSome(value) && !("default" in child)) {
        (child as JsonNode)["default"] = value.value;
      }
      writeDecodingDefaults(property.type, child);
    }
  } else if (SchemaAST.isArrays(ast)) {
    const [item] = ast.rest;
    if (item !== undefined && ast.elements.length === 0) writeDecodingDefaults(item, json["items"]);
  } else if (SchemaAST.isUnion(ast)) {
    const branches = json["anyOf"] ?? json["oneOf"];
    if (Array.isArray(branches) && branches.length === ast.types.length) {
      ast.types.forEach((member, i) => writeDecodingDefaults(member, branches[i]));
    }
  }
}

/* ------------------------------- tidying ------------------------------- */

const SAFE_INTEGER_BOUNDS = [
  ["minimum", Number.MIN_SAFE_INTEGER],
  ["maximum", Number.MAX_SAFE_INTEGER],
] as const;

/** Keywords that only annotate: an `allOf` branch of nothing else is folded into its parent. */
const ANNOTATION_KEYWORDS = new Set(["title", "description", "default", "examples"]);

function tidy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(tidy);
  if (!Predicate.isObject(value)) return value;
  // Effect writes a string's annotated checks as `allOf` branches beside its
  // own, so the marker can sit on either; it covers the whole string.
  const normalizedBeforeChecks = carriesNormalizedMarker(value);
  let node: JsonNode = {};
  for (const [key, child] of Object.entries(value)) node[key] = tidy(child);

  if (node["type"] === "integer") {
    for (const [keyword, bound] of SAFE_INTEGER_BOUNDS) {
      if (node[keyword] === bound) delete node[keyword];
    }
  }

  // A key's own annotations (`annotateKey`) arrive as an `allOf` of
  // annotations; they describe this property, so they win over the value's.
  const allOf = node["allOf"];
  if (Array.isArray(allOf) && allOf.every(isAnnotationOnly)) {
    delete node["allOf"];
    for (const branch of allOf as JsonNode[]) Object.assign(node, branch);
  }

  delete node[NORMALIZED_BEFORE_CHECKS];
  if (normalizedBeforeChecks) {
    delete node["minLength"];
    delete node["maxLength"];
    delete node["pattern"];
  }

  // `UuidRef` documents the UUID every stored id is but only checks it is
  // non-empty; the MCP SDK's validator asserts formats, so it must not either.
  if (node["format"] === "uuid") delete node["format"];

  // A single literal (`Schema.Literal`) is a `const`, as JSON Schema says it.
  const literals = node["enum"];
  if (Array.isArray(literals) && literals.length === 1) {
    delete node["enum"];
    node["const"] = literals[0];
  }

  if (Array.isArray(node["oneOf"]) && node["anyOf"] === undefined) {
    node["anyOf"] = node["oneOf"];
    delete node["oneOf"];
  }

  const anyOf = node["anyOf"];
  if (Array.isArray(anyOf)) {
    const [only] = anyOf;
    if (anyOf.length === 1 && Predicate.isObject(only)) {
      // A one-branch union is that branch, with this node's annotations.
      const { anyOf: _anyOf, ...annotations } = node;
      node = { ...(only as JsonNode), ...annotations };
    } else if (anyOf.length > 1 && anyOf.every(isBareType)) {
      // `string | number` is `type: ["string", "number"]`, as JSON Schema writes it.
      const { anyOf: _anyOf, ...rest } = node;
      node = { type: (anyOf as JsonNode[]).map((branch) => branch["type"]), ...rest };
    }
  }
  return node;
}

/** Whether this node, or one of its `allOf` branches, has {@link NORMALIZED_BEFORE_CHECKS}. */
function carriesNormalizedMarker(node: object): boolean {
  const json = node as JsonNode;
  if (json[NORMALIZED_BEFORE_CHECKS] === true) return true;
  const allOf = json["allOf"];
  return (
    Array.isArray(allOf) &&
    allOf.some((branch) => Predicate.isObject(branch) && carriesNormalizedMarker(branch))
  );
}

function isAnnotationOnly(branch: unknown): boolean {
  return (
    Predicate.isObject(branch) && Object.keys(branch).every((key) => ANNOTATION_KEYWORDS.has(key))
  );
}

function isBareType(branch: unknown): boolean {
  return (
    Predicate.isObject(branch) &&
    Object.keys(branch).length === 1 &&
    Predicate.isString((branch as JsonNode)["type"])
  );
}
