/**
 * The Swift SDK target.
 *
 * Emits a SwiftPM package — `InfrawrenchSDK` — made of four parts:
 *
 *   1. the hand-written request plumbing from `./runtime/*.swift.txt`, copied
 *      verbatim into `Sources/InfrawrenchSDK/`,
 *   2. one file per `components.schemas` entry under `Models/`,
 *   3. one file per top-level namespace under `Namespaces/`, each holding that
 *      namespace's class and every namespace nested beneath it,
 *   4. `Client.swift` with `APIV1Client`, plus the manifest, README, licence and
 *      an XCTest target that drives the emitted code through a stubbed
 *      `URLProtocol`.
 *
 * Where the TypeScript target can lean on structural types, Swift needs a
 * declaration for every shape, so most of what follows is about *naming* what
 * the spec left anonymous: inline objects, inline enums and `anyOf` branches all
 * become nested types inside the declaration that uses them.
 *
 * Three JSON Schema constructs have no Swift spelling and are resolved here
 * rather than pushed onto the caller:
 *
 *   - `allOf` is flattened into a single struct, because Swift has no
 *     intersection type. Members that contribute nothing (`{}`, `unknown`, a
 *     bare `null`) drop out, and a lone survivor is printed as itself rather
 *     than copied into a new struct under a new name.
 *   - a heterogeneous `anyOf` becomes an enum with one case per branch and a
 *     `JSONValue` catch-all, decoded by trying the branches in spec order.
 *   - `type: [x, null]` becomes `x?`, which is also why `printType` returns a
 *     string that may already end in `?` — callers must not blindly append one.
 */
import { readFile } from "node:fs/promises";
import { C_STYLE, docComment, fileBanner, operationDocParts, wrap } from "../../emit";
import { camelCase, pascalCase, uniqueName } from "../../naming";
import {
  AUTHOR,
  CONTRIBUTORS,
  COPYRIGHT_NOTICE,
  GENERATOR_PATH,
  HOMEPAGE,
  ISSUES_URL,
  KEYWORDS,
  LICENSE,
  LICENSE_TEXT,
  REPOSITORY_URL,
} from "../../package-metadata";
import type { SdkTarget, TargetContext } from "../../target";
import type {
  NamespaceDef,
  OperationDef,
  ParameterDef,
  PropertyDef,
  SchemaDef,
  SdkIr,
  TypeRef,
} from "../../types";

const PACKAGE_NAME = "InfrawrenchSDK";
const MODULE_NAME = "InfrawrenchSDK";
const TEST_MODULE_NAME = "InfrawrenchSDKSmokeTests";
const TEST_EXECUTABLE = "infrawrench-sdk-smoke";
const CLIENT_CLASS = "APIV1Client";
const SOURCES_DIR = `Sources/${MODULE_NAME}`;

/** Matches the toolchain the generated package is verified against. */
const SWIFT_TOOLS_VERSION = "6.1";

const RUNTIME_SENTINEL = "// --8<--";

/** Copied into the module as-is. */
const RUNTIME_FILES = ["JSONValue", "Errors", "Parameters", "Transport"] as const;

/** Also hand-written, but copied into the smoke-test target, not the module. */
const TEST_FILE = "SmokeTests";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Words that cannot appear as a bare identifier. Escaping is uniform — wrap in
 * backticks — so this only has to be a superset of what the spec can produce,
 * not a precise partition of Swift's grammar. Contextual keywords (`open`,
 * `some`, `any`, `each`) are legal as declaration names and are deliberately
 * absent, since escaping them would add noise and nothing else.
 */
const SWIFT_KEYWORDS = new Set([
  "Any", "Protocol", "Self", "Type", "as", "associatedtype", "associativity", "borrowing",
  "break", "case", "catch", "class", "consuming", "continue", "convenience", "default", "defer",
  "deinit", "do", "dynamic", "else", "enum", "extension", "fallthrough", "false", "fileprivate",
  "final", "for", "func", "guard", "if", "import", "in", "indirect", "infix", "init", "inout",
  "internal", "is", "lazy", "let", "macro", "mutating", "nil", "nonmutating", "operator",
  "optional", "override", "postfix", "precedence", "precedencegroup", "prefix", "private",
  "protocol", "public", "repeat", "required", "rethrows", "return", "self", "static", "struct",
  "subscript", "super", "switch", "throw", "throws", "true", "try", "typealias", "unowned",
  "var", "weak", "where", "while",
]); // prettier-ignore

/**
 * Type names the generated module cannot claim: what the runtime declares, plus
 * the standard library and Foundation names the generated code spells out. A
 * schema landing here is declared with a `Model` suffix instead — the spec has
 * an `Error` schema, and `struct Error` next to `throws` is not a fight worth
 * having.
 */
const RESERVED_TYPE_NAMES = new Set([
  // the module itself, which a type of the same name would shadow
  MODULE_NAME,
  // file names the module already uses — two same-named files in one target
  // collide at the object-file level, whatever their contents
  "Client", "Errors", "Parameters", "Transport",
  // declared by ./runtime/*.swift.txt
  "AnyEncodable", "ApiError", "ApiTransport", "ClientError", "ClientOptions", "InfrawrenchSDKInfo",
  "JSONValue", "MultipartEncodable", "MultipartField", "ParameterValue", "QueryParameter",
  "RequestOptions", "RequestSpec", CLIENT_CLASS,
  // standard library
  "Any", "AnyObject", "Array", "Bool", "CaseIterable", "Character", "Codable", "CodingKey",
  "Collection", "Comparable", "CustomStringConvertible", "Decodable", "Decoder", "Dictionary",
  "Double", "Encodable", "Encoder", "Equatable", "Error", "Float", "Hashable", "Identifiable",
  "Int", "Int8", "Int16", "Int32", "Int64", "Never", "Optional", "RawRepresentable", "Result",
  "Self", "Sendable", "Sequence", "Set", "String", "Substring", "Task", "Type", "UInt", "UInt8",
  "UInt16", "UInt32", "UInt64", "Void",
  // Foundation
  "Bundle", "Calendar", "Data", "Date", "DateFormatter", "Formatter", "JSONDecoder", "JSONEncoder",
  "JSONSerialization", "Locale", "LocalizedError", "Notification", "NSObject", "Operation",
  "Process", "Progress", "Stream", "Thread", "TimeInterval", "Timer", "URL", "URLComponents",
  "URLQueryItem", "URLRequest", "URLResponse", "URLSession", "UUID",
]); // prettier-ignore

/** Conformances every generated model declares. */
const MODEL_CONFORMANCES = "Codable, Hashable, Sendable";

function escapeIdentifier(name: string): string {
  return SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name;
}

/** Strip the backticks off an escaped identifier, for doc text and lookups. */
function unescapeIdentifier(name: string): string {
  return name.replace(/`/g, "");
}

/** A Swift identifier for a wire name, preserving it verbatim when it is one. */
function swiftIdentifier(wireName: string): string {
  if (IDENTIFIER.test(wireName)) return wireName;
  return camelCase(wireName) || "value";
}

function swiftTypeName(name: string): string {
  const base = IDENTIFIER.test(name) ? name : pascalCase(name);
  return base === "" ? "Value" : base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * `metrics` → `Metric`, for naming the type of an array's element. Purely
 * cosmetic: a wrong guess produces an ugly name, never a wrong one.
 */
function singular(name: string): string {
  if (/ies$/.test(name)) return `${name.slice(0, -3)}y`;
  if (/[^su]s$/.test(name)) return name.slice(0, -1);
  return name;
}

/** Only append `?` when the printed type is not already optional. */
function optionalize(type: string, when = true): string {
  return when && !type.endsWith("?") ? `${type}?` : type;
}

/** A doc comment for one sentence, wrapped — used where `docComment` would be noise. */
function docLines(text: string, indent: string): string[] {
  return wrap(text, 78 - indent.length).map((line) => `${indent}/// ${line}`);
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Resolves spec names to the type names the module actually declares. */
class NameTable {
  private readonly taken = new Set(RESERVED_TYPE_NAMES);
  private readonly schemas = new Map<string, string>();
  private readonly namespaces = new Map<string, string>();
  readonly renamed: Array<{ from: string; to: string }> = [];

  registerSchema(specName: string): void {
    const base = swiftTypeName(specName);
    const candidate = this.taken.has(base) ? `${base}Model` : base;
    const resolved = uniqueName(candidate, this.taken);
    if (resolved !== specName) this.renamed.push({ from: specName, to: resolved });
    this.schemas.set(specName, resolved);
  }

  registerNamespace(path: string[]): void {
    if (path.length === 0) return;
    const key = path.join(".");
    if (this.namespaces.has(key)) return;
    this.namespaces.set(key, uniqueName(`${path.map(pascalCase).join("")}Namespace`, this.taken));
  }

  schema(specName: string): string {
    return this.schemas.get(specName) ?? "JSONValue";
  }

  namespace(path: string[]): string {
    return path.length === 0 ? CLIENT_CLASS : (this.namespaces.get(path.join(".")) ?? CLIENT_CLASS);
  }

  /** Every module-scope name, so nested types can be kept from shadowing one. */
  allTypeNames(): Set<string> {
    return new Set(this.taken);
  }
}

interface Ctx {
  readonly names: NameTable;
  readonly schemas: Map<string, SchemaDef>;
  readonly warn: (message: string) => void;
}

/**
 * Where type declarations accumulate while a type is being printed.
 *
 * `taken` starts from every module-scope name: a nested `struct Account` would
 * silently shadow the model of that name for its whole enclosing type, so nested
 * names are made unique against the module, not just against their siblings.
 */
interface Scope {
  readonly taken: Set<string>;
  readonly decls: string[];
  readonly indent: string;
}

function rootScope(ctx: Ctx): Scope {
  return { taken: ctx.names.allTypeNames(), decls: [], indent: "" };
}

function childScope(scope: Scope, ownName: string): Scope {
  const taken = new Set(scope.taken);
  taken.add(ownName);
  return { taken, decls: [], indent: `${scope.indent}    ` };
}

// ---------------------------------------------------------------------------
// Schema analysis
// ---------------------------------------------------------------------------

const UNKNOWN: TypeRef = { kind: "unknown" };

/** Strip `null` branches from a union, reporting whether any were there. */
function splitNull(members: TypeRef[]): { members: TypeRef[]; nullable: boolean } {
  const kept = members.filter((member) => member.kind !== "null");
  return { members: kept, nullable: kept.length !== members.length };
}

/**
 * Peel one layer of nullability without resolving `$ref`s.
 *
 * Leaving refs alone is what keeps `Role = RoleSummary & { … }` non-optional:
 * `RoleSummary` is `object | null` on its own, but intersecting it with a set of
 * required properties is a promise that the null branch is not in play.
 */
function unwrapNullable(type: TypeRef): { type: TypeRef; nullable: boolean } {
  if (type.kind === "null") return { type: UNKNOWN, nullable: true };
  if (type.kind !== "union") return { type, nullable: false };
  const { members, nullable } = splitNull(type.members);
  if (members.length === 0) return { type: UNKNOWN, nullable: true };
  if (members.length === 1) {
    const inner = unwrapNullable(members[0]!);
    return { type: inner.type, nullable: nullable || inner.nullable };
  }
  return { type: { kind: "union", members }, nullable };
}

/** A member that constrains nothing, and so drops out of an intersection. */
function isVacuous(type: TypeRef): boolean {
  if (type.kind === "unknown") return true;
  return type.kind === "object" && type.properties.length === 0 && type.additional === null;
}

type ObjectRef = Extract<TypeRef, { kind: "object" }>;

/** Resolve a type to the object it ultimately describes, or `null`. */
function asObject(ctx: Ctx, type: TypeRef, seen = new Set<string>()): ObjectRef | null {
  const { type: bare } = unwrapNullable(type);
  if (bare.kind === "object") return bare;
  if (bare.kind === "ref") {
    if (seen.has(bare.name)) return null;
    seen.add(bare.name);
    const schema = ctx.schemas.get(bare.name);
    return schema ? asObject(ctx, schema.type, seen) : null;
  }
  if (bare.kind === "intersection") return asObject(ctx, flatten(ctx, bare.members).type, seen);
  return null;
}

/**
 * Collapse an `allOf` into one type.
 *
 * A single surviving member is returned untouched — that is what turns
 * `AgentSettings & {}` back into `AgentSettings` rather than into a nameless
 * copy of its properties. Only when two or more members genuinely contribute do
 * their properties get merged into one anonymous object.
 */
function flatten(ctx: Ctx, members: TypeRef[]): { type: TypeRef; nullable: boolean } {
  let nullable = false;
  const parts: TypeRef[] = [];
  for (const member of members) {
    const unwrapped = unwrapNullable(member);
    // A `{} | null` member says nothing except that null is allowed — which is
    // still worth keeping.
    nullable = nullable || unwrapped.nullable;
    if (!isVacuous(unwrapped.type)) parts.push(unwrapped.type);
  }
  if (parts.length === 0) return { type: UNKNOWN, nullable: true };
  if (parts.length === 1) return { type: parts[0]!, nullable };

  const properties: PropertyDef[] = [];
  const positions = new Map<string, number>();
  let additional: TypeRef | null = null;
  const others: TypeRef[] = [];
  for (const part of parts) {
    const object = asObject(ctx, part);
    if (!object) {
      others.push(part);
      continue;
    }
    for (const property of object.properties) {
      const at = positions.get(property.name);
      // Later members win: `A & { x: … }` is a narrowing of `A`.
      if (at === undefined) {
        positions.set(property.name, properties.length);
        properties.push(property);
      } else {
        properties[at] = property;
      }
    }
    additional = additional ?? object.additional;
  }
  if (properties.length > 0) return { type: { kind: "object", properties, additional }, nullable };
  if (additional) return { type: { kind: "object", properties: [], additional }, nullable };
  return { type: others[0] ?? parts[0]!, nullable };
}

/** Whether a value of this type can arrive as JSON `null`. */
function isNullable(ctx: Ctx, type: TypeRef, seen = new Set<string>()): boolean {
  switch (type.kind) {
    case "null":
      return true;
    case "union":
      return type.members.some((member) => member.kind === "null");
    case "intersection":
      return flatten(ctx, type.members).nullable;
    case "ref": {
      if (seen.has(type.name)) return false;
      seen.add(type.name);
      const schema = ctx.schemas.get(type.name);
      return schema ? isNullable(ctx, schema.type, seen) : false;
    }
    default:
      return false;
  }
}

/** The shape a named schema declares, with nullability peeled off. */
function schemaBody(ctx: Ctx, schema: SchemaDef): TypeRef {
  if (schema.type.kind === "intersection") return flatten(ctx, schema.type.members).type;
  return unwrapNullable(schema.type).type;
}

// ---------------------------------------------------------------------------
// Type printing
// ---------------------------------------------------------------------------

function printType(ctx: Ctx, type: TypeRef, scope: Scope, hint: string): string {
  switch (type.kind) {
    case "ref":
      return optionalize(ctx.names.schema(type.name), isNullable(ctx, type));
    case "string":
      return type.enum ? declareStringEnum(scope, hint, type.enum) : "String";
    case "number":
      return type.integer ? "Int" : "Double";
    case "boolean":
      return "Bool";
    case "binary":
      return "Data";
    case "null":
      return "JSONValue?";
    case "unknown":
      return "JSONValue";
    case "array":
      return `[${printType(ctx, type.items, scope, singular(hint))}]`;
    case "object":
      return printObject(ctx, type, scope, hint);
    case "union":
      return printUnion(ctx, type, scope, hint);
    case "intersection": {
      const { type: resolved, nullable } = flatten(ctx, type.members);
      return optionalize(printType(ctx, resolved, scope, hint), nullable);
    }
  }
}

function printObject(ctx: Ctx, type: ObjectRef, scope: Scope, hint: string): string {
  if (type.properties.length === 0) {
    if (!type.additional) return "JSONValue";
    return `[String: ${printType(ctx, type.additional, scope, `${hint}Value`)}]`;
  }
  if (type.additional) {
    // Swift structs have no index signature, so one of the two has to give, and
    // the declared properties are the half worth keeping.
    ctx.warn(`${hint}: additionalProperties dropped — the declared properties win`);
  }
  return declareStruct(ctx, scope, hint, type);
}

function printUnion(
  ctx: Ctx,
  type: Extract<TypeRef, { kind: "union" }>,
  scope: Scope,
  hint: string,
): string {
  const { members, nullable } = splitNull(type.members);
  if (members.length === 0) return "JSONValue?";
  // An `unknown` branch admits every value, so the narrower branches beside it
  // could never be relied on — the union as a whole is free-form.
  if (members.some((member) => member.kind === "unknown")) return "JSONValue?";

  const unique: TypeRef[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    const key = JSON.stringify(member);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(member);
  }
  if (unique.length === 1) return optionalize(printType(ctx, unique[0]!, scope, hint), nullable);
  return optionalize(declareUnionEnum(ctx, scope, hint, unique), nullable);
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

function declare(
  scope: Scope,
  hint: string,
  render: (name: string, inner: Scope) => string,
): string {
  const name = uniqueName(swiftTypeName(hint), scope.taken);
  scope.decls.push(render(name, childScope(scope, name)));
  return name;
}

function declareStruct(ctx: Ctx, scope: Scope, hint: string, object: ObjectRef): string {
  return declare(scope, hint, (name, inner) =>
    renderStruct(ctx, name, object, [], scope.indent, inner, false),
  );
}

function declareStringEnum(scope: Scope, hint: string, values: string[]): string {
  return declare(scope, hint, (name) => renderStringEnum(name, values, [], scope.indent));
}

function declareUnionEnum(ctx: Ctx, scope: Scope, hint: string, members: TypeRef[]): string {
  return declare(scope, hint, (name, inner) =>
    renderUnionEnum(ctx, name, members, [], scope.indent, inner),
  );
}

interface Field {
  /** Identifier as written, already backtick-escaped where needed. */
  swift: string;
  /** The same identifier unescaped, for comparison against the wire name. */
  bare: string;
  wire: string;
  type: string;
  optional: boolean;
  source: PropertyDef;
}

function toFields(ctx: Ctx, object: ObjectRef, scope: Scope): Field[] {
  return object.properties.map((property) => {
    const printed = printType(ctx, property.type, scope, property.name);
    const optional = !property.required || printed.endsWith("?");
    const bare = swiftIdentifier(property.name);
    return {
      swift: escapeIdentifier(bare),
      bare,
      wire: property.name,
      type: optionalize(printed, optional),
      optional,
      source: property,
    };
  });
}

function renderStruct(
  ctx: Ctx,
  name: string,
  object: ObjectRef,
  docParts: Array<string | undefined>,
  indent: string,
  inner: Scope,
  multipart: boolean,
): string {
  const fields = toFields(ctx, object, inner);
  const body = inner.indent;
  const lines: string[] = [];

  const doc = docComment(docParts, C_STYLE, indent);
  if (doc) lines.push(doc);
  lines.push(
    `${indent}public struct ${name}: ${MODEL_CONFORMANCES}${multipart ? ", MultipartEncodable" : ""} {`,
  );
  for (const decl of inner.decls) lines.push(decl, "");

  for (const field of fields) {
    const fieldDoc = docComment(
      [field.source.description, field.source.deprecated === true ? "Deprecated." : undefined],
      C_STYLE,
      body,
    );
    if (fieldDoc) lines.push(fieldDoc);
    lines.push(`${body}public var ${field.swift}: ${field.type}`);
  }

  // Swift's memberwise initializer is internal, so without this a public struct
  // in a library is not constructible by the people it was published for.
  lines.push(
    "",
    `${body}public init(`,
    fields
      .map((field) => `${body}    ${field.swift}: ${field.type}${field.optional ? " = nil" : ""}`)
      .join(",\n"),
    `${body}) {`,
    ...fields.map((field) => `${body}    self.${field.swift} = ${field.swift}`),
    `${body}}`,
  );

  // Only when a wire name could not be used verbatim: the synthesized keys are
  // right the rest of the time, and 160 hand-written copies of them are not.
  if (fields.some((field) => field.bare !== field.wire)) {
    lines.push(
      "",
      `${body}private enum CodingKeys: String, CodingKey {`,
      ...fields.map((field) => `${body}    case ${field.swift} = ${JSON.stringify(field.wire)}`),
      `${body}}`,
    );
  }

  if (multipart) lines.push("", renderMultipartFields(ctx, fields, body));

  lines.push(`${indent}}`);
  return lines.join("\n");
}

/** Whether a field can be written into a form part as a single string. */
function isScalar(ctx: Ctx, type: TypeRef, seen = new Set<string>()): boolean {
  switch (type.kind) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "ref": {
      if (seen.has(type.name)) return false;
      seen.add(type.name);
      const schema = ctx.schemas.get(type.name);
      return schema ? isScalar(ctx, schema.type, seen) : false;
    }
    default:
      return false;
  }
}

function renderMultipartFields(ctx: Ctx, fields: Field[], indent: string): string {
  const body = `${indent}    `;
  const lines = [
    `${indent}public var multipartFields: [MultipartField] {`,
    `${body}var fields: [MultipartField] = []`,
  ];
  for (const field of fields) {
    const wire = JSON.stringify(field.wire);
    const binary = field.source.type.kind === "binary";
    if (!binary && !isScalar(ctx, field.source.type)) {
      throw new Error(
        `multipart field "${field.wire}" is neither a scalar nor a file — the Swift target ` +
          "does not know how to write it as a form part",
      );
    }
    // A part with a filename is what makes a server treat it as an upload. The
    // spec carries no separate filename, so the field's own name stands in.
    const append = binary
      ? `fields.append(.file(${wire}, ${field.swift}, filename: ${wire}))`
      : `fields.append(.text(${wire}, ${field.swift}.parameterValue))`;
    lines.push(field.optional ? `${body}if let ${field.swift} { ${append} }` : `${body}${append}`);
  }
  lines.push(`${body}return fields`, `${indent}}`);
  return lines.join("\n");
}

/**
 * A string enum, with an escape hatch.
 *
 * A plain `enum: String, Codable` throws `dataCorrupted` the first time the
 * server sends a value this SDK was generated before — which would make adding a
 * resource type a breaking change for every client that had not upgraded. The
 * `unrecognized` case keeps the raw string instead, so decoding survives and the
 * value is still there to be read.
 */
function renderStringEnum(
  name: string,
  values: string[],
  docParts: Array<string | undefined>,
  indent: string,
): string {
  const body = `${indent}    `;
  const taken = new Set<string>();
  const cases = values.map((value, index) => ({
    value,
    name: uniqueName(camelCase(value) || `value${index + 1}`, taken),
  }));
  const fallback = uniqueName("unrecognized", taken);

  const lines: string[] = [];
  const doc = docComment(docParts, C_STYLE, indent);
  if (doc) lines.push(doc);
  lines.push(
    `${indent}public enum ${name}: RawRepresentable, ${MODEL_CONFORMANCES}, ParameterValue {`,
    ...cases.map((entry) => `${body}case ${escapeIdentifier(entry.name)}`),
    ...docLines(
      "A value the API added after this SDK was generated. Kept rather than rejected, so a new server-side value cannot break decoding.",
      body,
    ),
    `${body}case ${escapeIdentifier(fallback)}(String)`,
    "",
    `${body}public init(rawValue: String) {`,
    `${body}    switch rawValue {`,
    ...cases.map(
      (entry) =>
        `${body}    case ${JSON.stringify(entry.value)}: self = .${escapeIdentifier(entry.name)}`,
    ),
    `${body}    default: self = .${escapeIdentifier(fallback)}(rawValue)`,
    `${body}    }`,
    `${body}}`,
    "",
    `${body}public var rawValue: String {`,
    `${body}    switch self {`,
    ...cases.map(
      (entry) =>
        `${body}    case .${escapeIdentifier(entry.name)}: return ${JSON.stringify(entry.value)}`,
    ),
    `${body}    case .${escapeIdentifier(fallback)}(let value): return value`,
    `${body}    }`,
    `${body}}`,
    "",
    `${body}/// Every value the spec declares. \`${fallback}\` is deliberately absent.`,
    `${body}public static let allKnownCases: [${name}] = [`,
    ...cases.map((entry) => `${body}    .${escapeIdentifier(entry.name)},`),
    `${body}]`,
    "",
    `${body}public init(from decoder: any Decoder) throws {`,
    `${body}    self.init(rawValue: try decoder.singleValueContainer().decode(String.self))`,
    `${body}}`,
    "",
    `${body}public func encode(to encoder: any Encoder) throws {`,
    `${body}    var container = encoder.singleValueContainer()`,
    `${body}    try container.encode(rawValue)`,
    `${body}}`,
    `${indent}}`,
  );
  return lines.join("\n");
}

/** The case name a union branch gets: what it *is*, not where it came from. */
function unionCaseName(ctx: Ctx, member: TypeRef, hint: string): string {
  switch (member.kind) {
    case "ref":
      return camelCase(ctx.names.schema(member.name));
    case "string":
      return member.enum ? camelCase(hint) || "option" : "string";
    case "number":
      return member.integer ? "int" : "double";
    case "boolean":
      return "bool";
    case "binary":
      return "data";
    case "array":
      return "array";
    case "object":
    case "intersection":
      return "object";
    default:
      return "value";
  }
}

function renderUnionEnum(
  ctx: Ctx,
  name: string,
  members: TypeRef[],
  docParts: Array<string | undefined>,
  indent: string,
  inner: Scope,
): string {
  const body = inner.indent;
  const taken = new Set<string>();
  const branches = members.map((member) => {
    const caseName = uniqueName(unionCaseName(ctx, member, name), taken);
    return {
      name: escapeIdentifier(caseName),
      type: printType(ctx, member, inner, `${name}${pascalCase(caseName)}`),
    };
  });
  const fallback = escapeIdentifier(uniqueName("other", taken));

  const lines: string[] = [];
  const doc = docComment(
    [
      ...docParts,
      "The spec allows several shapes here. Decoding tries the branches in spec order, so the most specific match wins.",
    ],
    C_STYLE,
    indent,
  );
  if (doc) lines.push(doc);
  lines.push(`${indent}public enum ${name}: ${MODEL_CONFORMANCES} {`);
  for (const decl of inner.decls) lines.push(decl, "");
  lines.push(
    ...branches.map((branch) => `${body}case ${branch.name}(${branch.type})`),
    ...docLines("A shape none of the branches above matched.", body),
    `${body}case ${fallback}(JSONValue)`,
    "",
    `${body}public init(from decoder: any Decoder) throws {`,
    `${body}    let container = try decoder.singleValueContainer()`,
    ...branches.flatMap((branch) => [
      `${body}    if let value = try? container.decode(${branch.type.replace(/\?$/, "")}.self) {`,
      `${body}        self = .${branch.name}(value)`,
      `${body}        return`,
      `${body}    }`,
    ]),
    `${body}    self = .${fallback}(try container.decode(JSONValue.self))`,
    `${body}}`,
    "",
    `${body}public func encode(to encoder: any Encoder) throws {`,
    `${body}    var container = encoder.singleValueContainer()`,
    `${body}    switch self {`,
    ...[...branches.map((branch) => branch.name), fallback].map(
      (caseName) => `${body}    case .${caseName}(let value): try container.encode(value)`,
    ),
    `${body}    }`,
    `${body}}`,
    `${indent}}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function emitSchema(ctx: Ctx, schema: SchemaDef, multipart: boolean): string {
  const name = ctx.names.schema(schema.name);
  const scope = rootScope(ctx);
  const docParts = [
    schema.description,
    name === schema.name ? undefined : `Spec schema: \`${schema.name}\`.`,
    isNullable(ctx, { kind: "ref", name: schema.name })
      ? "The API may send `null` in place of this, which is why references to it are optional."
      : undefined,
  ];
  const body = schemaBody(ctx, schema);

  if (body.kind === "object" && body.properties.length > 0) {
    return renderStruct(ctx, name, body, docParts, "", childScope(scope, name), multipart);
  }
  if (body.kind === "string" && body.enum) {
    return renderStringEnum(name, body.enum, docParts, "");
  }
  if (body.kind === "union") {
    const { members } = splitNull(body.members);
    if (members.length > 1 && !members.some((member) => member.kind === "unknown")) {
      return renderUnionEnum(ctx, name, members, docParts, "", childScope(scope, name));
    }
  }

  // Everything else — a constrained string, an array, an open map — is a
  // typealias, with any inline types it needed emitted beside it.
  const printed = printType(ctx, body, scope, singular(name));
  const doc = docComment(docParts, C_STYLE, "");
  return [...scope.decls, `${doc ? `${doc}\n` : ""}public typealias ${name} = ${printed}`].join(
    "\n\n",
  );
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Prefix for the types an operation needs declared at module scope. */
function operationPrefix(op: OperationDef): string {
  return pascalCase([...op.namespace, op.name].join("-"));
}

/**
 * Inline enums on parameters print as `String`.
 *
 * A named type per query parameter would be a whole declaration for a
 * `"true" | "false"` flag, so the allowed values go in the doc comment instead.
 * Parameters that reference a *named* enum schema keep it and stay type-safe.
 */
function parameterType(ctx: Ctx, param: ParameterDef, scope: Scope): string {
  if (param.type.kind === "string" && param.type.enum) return "String";
  return printType(ctx, param.type, scope, param.name);
}

function parameterDoc(param: ParameterDef, scopeParam: string | null): string | undefined {
  const parts: string[] = [];
  if (param.description) parts.push(param.description.replace(/\.$/, ""));
  if (param.type.kind === "string" && param.type.enum) {
    parts.push(`One of ${param.type.enum.map((value) => `\`${value}\``).join(", ")}`);
  }
  if (param.defaultable) {
    parts.push(`Defaults to the \`${scopeParam ?? param.name}\` the client was created with`);
  }
  return parts.length === 0 ? undefined : `${parts.join(". ")}.`;
}

interface Argument {
  /** Label and identifier, already escaped. */
  name: string;
  type: string;
  optional: boolean;
  doc: string | undefined;
}

function operationArguments(ctx: Ctx, op: OperationDef, scope: Scope, ir: SdkIr): Argument[] {
  const args: Argument[] = op.parameters.map((param) => {
    const printed = parameterType(ctx, param, scope);
    // A defaultable path parameter is required on the wire but optional here —
    // the transport fills it in from client configuration.
    const optional = param.defaultable || !param.required || printed.endsWith("?");
    return {
      name: escapeIdentifier(swiftIdentifier(param.name)),
      type: optionalize(printed, optional),
      optional,
      doc: parameterDoc(param, ir.defaultablePathParam),
    };
  });

  if (op.body) {
    // A null request body says nothing, so schema nullability is dropped here
    // and `required` alone decides whether `body` can be left off.
    const printed = printType(ctx, op.body.type, scope, `${operationPrefix(op)}Body`).replace(
      /\?$/,
      "",
    );
    args.push({
      name: "body",
      type: optionalize(printed, !op.body.required),
      optional: !op.body.required,
      doc: op.body.encoding === "multipart" ? "Sent as `multipart/form-data`." : undefined,
    });
  }
  return args;
}

/** The Swift return type, or `null` for a call that returns nothing. */
function returnType(ctx: Ctx, op: OperationDef, scope: Scope): string | null {
  switch (op.response.encoding) {
    case "binary":
      return "Data";
    case "empty":
      return null;
    case "json":
      return printType(ctx, op.response.type ?? UNKNOWN, scope, `${operationPrefix(op)}Result`);
  }
}

function emitOperation(
  ctx: Ctx,
  op: OperationDef,
  scope: Scope,
  ir: SdkIr,
  indent: string,
): string {
  const args = operationArguments(ctx, op, scope, ir);
  const result = returnType(ctx, op, scope);
  const body = `${indent}    `;
  const byWireName = new Map(args.map((arg) => [unescapeIdentifier(arg.name), arg]));

  const lines: string[] = [];
  const doc = docComment(
    [
      ...operationDocParts(op),
      ...args
        .filter((arg) => arg.doc !== undefined)
        .map((arg) => `- Parameter ${unescapeIdentifier(arg.name)}: ${arg.doc}`),
    ],
    C_STYLE,
    indent,
  );
  if (doc) lines.push(doc);
  if (op.deprecated) lines.push(`${indent}@available(*, deprecated)`);

  lines.push(
    `${indent}public func ${escapeIdentifier(swiftIdentifier(op.name))}(`,
    [
      ...args.map((arg) => `${body}${arg.name}: ${arg.type}${arg.optional ? " = nil" : ""}`),
      `${body}options: RequestOptions? = nil`,
    ].join(",\n"),
    `${indent}) async throws${result === null ? "" : ` -> ${result}`} {`,
  );

  // Built without trailing commas: SwiftPM only started accepting those in
  // 6.1, and there is no reason to make the emitted code the thing that pins
  // the minimum toolchain.
  const spec: string[] = [
    `method: ${JSON.stringify(op.method.toUpperCase())}`,
    `path: ${JSON.stringify(op.path)}`,
  ];
  const pathParams = op.parameters.filter((param) => param.in === "path");
  if (pathParams.length > 0) {
    const entries = pathParams.map((param) => {
      const arg = byWireName.get(param.name);
      return `${JSON.stringify(param.name)}: ${arg?.name}${arg?.optional ? "?" : ""}.parameterValue`;
    });
    spec.push(`pathParameters: [${entries.join(", ")}]`);
  }
  const queryParams = op.parameters.filter((param) => param.in === "query");
  if (queryParams.length > 0) {
    const entries = queryParams.map(
      (param) =>
        `QueryParameter(${JSON.stringify(param.name)}, ${byWireName.get(param.name)?.name})`,
    );
    spec.push(`query: [${entries.join(", ")}]`);
  }
  if (op.body?.encoding === "multipart") {
    spec.push(`multipart: body${op.body.required ? "" : "?"}.multipartFields`);
  } else if (op.body) {
    spec.push(
      op.body.required ? "body: AnyEncodable(body)" : "body: body.map { AnyEncodable($0) }",
    );
  }

  const send =
    op.response.encoding === "binary"
      ? "sendData"
      : op.response.encoding === "empty"
        ? "sendVoid"
        : "send";
  lines.push(
    `${body}${result === null ? "" : "return "}try await transport.${send}(`,
    `${body}    RequestSpec(`,
    spec.map((entry) => `${body}        ${entry}`).join(",\n"),
    `${body}    ),`,
    `${body}    options: options`,
    `${body})`,
    `${indent}}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/** One namespace class. Children are declared, not defined, here. */
function emitNamespaceClass(ctx: Ctx, node: NamespaceDef, scope: Scope, ir: SdkIr): string {
  const isRoot = node.path.length === 0;
  const className = ctx.names.namespace(node.path);
  const lines: string[] = [];

  if (isRoot) {
    const example = ir.operations.find(
      (op) => op.namespace[0] === "accounts" && op.name === "list",
    );
    const call = example ? [...example.namespace, example.name].join(".") : "accounts.list";
    lines.push(
      "/// A client for the Infrawrench API.",
      "///",
      "/// ```swift",
      `/// let client = ${CLIENT_CLASS}(apiKey: apiKey, orgId: orgId)`,
      `/// let accounts = try await client.${call}()`,
      "/// ```",
      "///",
      "/// Calls mirror the URL structure, so `POST /api/org/{orgId}/accounts/{id}/sync` is",
      "/// `client.accounts.sync(id:)`. The `orgId` given here fills itself in on every",
      "/// org-scoped call; pass one to a single call to override it.",
    );
  } else {
    lines.push(`/// \`client.${node.path.join(".")}\``);
  }

  lines.push(
    `public final class ${className}: Sendable {`,
    isRoot
      ? "    /// Shared request plumbing. Reach for it only to inspect the resolved base URL."
      : "    /// Shared request plumbing.",
    `    ${isRoot ? "public " : ""}let transport: ApiTransport`,
  );
  for (const [key, child] of node.children) {
    lines.push(
      `    /// \`client.${child.path.join(".")}\``,
      `    public let ${escapeIdentifier(swiftIdentifier(key))}: ${ctx.names.namespace(child.path)}`,
    );
  }

  lines.push("");
  if (isRoot) {
    lines.push(
      "    public init(_ options: ClientOptions = ClientOptions()) {",
      // A local, because `self` is off limits until every stored property is set.
      "        let transport = ApiTransport(options: options)",
      "        self.transport = transport",
    );
  } else {
    lines.push("    init(transport: ApiTransport) {", "        self.transport = transport");
  }
  for (const [key, child] of node.children) {
    const property = escapeIdentifier(swiftIdentifier(key));
    lines.push(
      `        self.${property} = ${ctx.names.namespace(child.path)}(transport: transport)`,
    );
  }
  lines.push("    }");

  if (isRoot) {
    lines.push(
      "",
      "    /// The common case, without spelling out `ClientOptions`.",
      "    public convenience init(",
      "        apiKey: String? = nil,",
      "        orgId: String? = nil,",
      "        baseURL: String = InfrawrenchSDKInfo.defaultBaseURL",
      "    ) {",
      "        self.init(ClientOptions(baseURL: baseURL, apiKey: apiKey, orgId: orgId))",
      "    }",
    );
  }

  for (const op of node.operations) lines.push("", emitOperation(ctx, op, scope, ir, "    "));
  lines.push("}");
  return lines.join("\n");
}

/** A namespace and everything beneath it, parents first. */
function emitNamespaceTree(ctx: Ctx, node: NamespaceDef, scope: Scope, ir: SdkIr): string[] {
  const out = [emitNamespaceClass(ctx, node, scope, ir)];
  for (const child of node.children.values()) out.push(...emitNamespaceTree(ctx, child, scope, ir));
  return out;
}

// ---------------------------------------------------------------------------
// Package files
// ---------------------------------------------------------------------------

function packageManifest(ir: SdkIr): string {
  // The tools-version comment has to be the literal first line of the file, so
  // the banner goes underneath it rather than on top.
  return [
    `// swift-tools-version: ${SWIFT_TOOLS_VERSION}`,
    fileBanner(ir, C_STYLE, PACKAGE_NAME),
    "import PackageDescription",
    "",
    "let package = Package(",
    `    name: ${JSON.stringify(PACKAGE_NAME)},`,
    "    // The floor is the async URLSession API this client is built on.",
    "    platforms: [.macOS(.v12), .iOS(.v15), .tvOS(.v15), .watchOS(.v8)],",
    "    products: [",
    `        .library(name: ${JSON.stringify(MODULE_NAME)}, targets: [${JSON.stringify(MODULE_NAME)}]),`,
    `        .executable(name: ${JSON.stringify(TEST_EXECUTABLE)}, targets: [${JSON.stringify(TEST_MODULE_NAME)}]),`,
    "    ],",
    "    targets: [",
    "        // No dependencies, by design: Foundation is the whole of it, so this",
    "        // package resolves and builds with no network access at all.",
    `        .target(name: ${JSON.stringify(MODULE_NAME)}),`,
    "        // The smoke suite is an executable rather than a `.testTarget`:",
    "        // XCTest is absent from a Command Line Tools-only macOS toolchain,",
    "        // and swift-testing would be a package dependency. This runs",
    `        // wherever the package builds — \`swift run ${TEST_EXECUTABLE}\`.`,
    `        .executableTarget(name: ${JSON.stringify(TEST_MODULE_NAME)}, dependencies: [${JSON.stringify(MODULE_NAME)}]),`,
    "    ]",
    ")",
    "",
  ].join("\n");
}

function readme(ir: SdkIr): string {
  const example = ir.operations.find((op) => op.namespace[0] === "accounts" && op.name === "list");
  const call = example ? [...example.namespace, example.name].join(".") : "accounts.list";
  return `# ${PACKAGE_NAME}

Generated Swift client for the ${ir.title} (API version \`${ir.apiVersion}\`).

**Do not edit this package by hand** — it is regenerated from \`openapi.json\` and
is not checked into the repository. Run
\`pnpm --filter @infrawrench/web generate:sdk\` to rebuild it; the generator lives
in [\`${GENERATOR_PATH}\`](${REPOSITORY_URL}/tree/main/${GENERATOR_PATH}).

## Version

SwiftPM takes a package's version from its Git tag, so \`Package.swift\` has
nowhere to record which API this code matches. It is recorded in the code
instead:

\`\`\`swift
InfrawrenchSDKInfo.apiVersion      // "${ir.apiVersion}"
InfrawrenchSDKInfo.defaultBaseURL  // "${ir.baseUrl}"
\`\`\`

## Usage

\`\`\`swift
import ${MODULE_NAME}

let client = ${CLIENT_CLASS}(
    apiKey: ProcessInfo.processInfo.environment["INFRAWRENCH_API_KEY"],
    orgId: ProcessInfo.processInfo.environment["INFRAWRENCH_ORG_ID"]
)

do {
    let accounts = try await client.${call}()
} catch let error as ApiError {
    print(error.status, error.code ?? "-", error.body)
} catch let error as ClientError {
    print(error)  // a missing org id, an unbuildable URL — nothing left the process
}
\`\`\`

Calls are namespaced to mirror the URL structure, so \`POST /api/org/{orgId}/accounts/{id}/sync\`
is \`client.accounts.sync(id:)\`. Set \`orgId\` once on the client and every
org-scoped call can omit it; pass \`orgId\` to an individual call to override it.

Every method takes a trailing \`RequestOptions\` (\`headers\`, \`timeout\`).
Non-2xx responses throw \`ApiError\`, which carries \`status\`, the parsed
\`body\`, and the machine-readable \`code\` when the API sends one.

## Notes on the generated types

- **Free-form JSON** — \`additionalProperties: true\` objects and untyped
  properties are \`JSONValue\`, an enum covering the whole JSON grammar, with
  subscripts: \`error.body["details"]?["field"]?.stringValue\`.
- **String enums** carry an \`unrecognized(String)\` case. A value the server
  adds after this package was generated decodes into it rather than throwing, so
  a new resource type does not break an old client. \`allKnownCases\` lists the
  values the spec declared.
- **\`allOf\`** is flattened into a single struct, because Swift has no
  intersection type.
- **Multi-shape \`anyOf\`** becomes an enum with one case per branch and an
  \`other(JSONValue)\` catch-all.
- **Nullable properties** are Swift optionals, and \`nil\` is omitted from
  request bodies rather than sent as \`null\`.
- **Dates** stay \`String\`. The spec's \`date-time\` values are RFC 3339, but
  decoding them into \`Date\` would impose one date strategy on every property in
  the package, including the many that are not dates.

## Platforms

macOS 12+, iOS 15+, tvOS 15+, watchOS 8+, and Linux. On Linux the async
\`URLSession\` API lives in \`FoundationNetworking\`, which the transport imports
conditionally and falls back behind. No dependencies — Foundation only.

## Scope

This package covers the published API surface only. Operations marked
\`x-internal\` in the spec — the admin surface, webhook receivers, desktop sync,
push registration and the browser auth redirects — are not generated.

## Testing against it

\`\`\`
swift run ${TEST_EXECUTABLE}
\`\`\`

runs a generated smoke suite that drives the client through a stubbed
\`URLProtocol\`, without a network. It is an executable rather than a
\`.testTarget\` because XCTest is missing from a Command Line Tools-only macOS
toolchain and swift-testing would be a dependency — and this package has none.

The same technique works for testing your own code: build a \`URLSession\` from a
configuration whose \`protocolClasses\` is your stub, and hand it to
\`ClientOptions(session:)\`.

## License

${LICENSE} — see [\`LICENSE\`](./LICENSE). ${COPYRIGHT_NOTICE}.

Note that this client is more permissively licensed than the service it talks
to: the Infrawrench source is BUSL-1.1, but the generated clients are ${LICENSE} so you
can link one into your own software without inheriting those terms.

Keywords: ${KEYWORDS.join(", ")}.
Author: ${AUTHOR.name} <${AUTHOR.email}>, with ${CONTRIBUTORS.map((c) => c.name).join(", ")}.
Homepage: <${HOMEPAGE}>
Issues: <${ISSUES_URL}>
`;
}

/**
 * Read one hand-written Swift file and substitute the spec-derived constants.
 *
 * The sources live under `./runtime/` with a `.txt` suffix so that nothing in
 * this repository tries to compile them, and so the generator's own typecheck
 * does not have to know Swift. They are real files rather than template strings
 * for the same reason the TypeScript target does it: a syntax error belongs in
 * the file you edit, not in generated output nobody reads.
 */
async function loadRuntime(ir: SdkIr, name: string): Promise<string> {
  const source = await readFile(new URL(`./runtime/${name}.swift.txt`, import.meta.url), "utf8");
  const start = source.indexOf(RUNTIME_SENTINEL);
  if (start === -1) {
    throw new Error(`runtime/${name}.swift.txt is missing its "${RUNTIME_SENTINEL}" sentinel line`);
  }
  const newline = source.indexOf("\n", start);
  const body = source
    .slice(newline + 1)
    .replaceAll("@@API_VERSION@@", ir.apiVersion)
    .replaceAll("@@BASE_URL@@", ir.baseUrl)
    .replaceAll('"@@SCOPE_PARAM@@"', JSON.stringify(ir.defaultablePathParam))
    .trim();
  return `${fileBanner(ir, C_STYLE, PACKAGE_NAME)}${body}\n`;
}

// ---------------------------------------------------------------------------

export const swiftTarget: SdkTarget = {
  id: "swift",
  displayName: "Swift",
  packageName: PACKAGE_NAME,
  artifacts: [
    "Package.swift",
    "README.md",
    "LICENSE",
    `${SOURCES_DIR}/Transport.swift`,
    `${SOURCES_DIR}/Client.swift`,
  ],

  async generate(ir: SdkIr, ctx: TargetContext): Promise<void> {
    const names = new NameTable();
    for (const schema of ir.schemas) names.registerSchema(schema.name);
    const registerNamespaces = (node: NamespaceDef): void => {
      names.registerNamespace(node.path);
      for (const child of node.children.values()) registerNamespaces(child);
    };
    registerNamespaces(ir.root);

    const emitCtx: Ctx = {
      names,
      schemas: new Map(ir.schemas.map((schema) => [schema.name, schema])),
      warn: (message) => ctx.log(`  ! ${message}`),
    };

    // Which models the transport has to be able to take apart into form fields.
    const multipartSchemas = new Set(
      ir.operations
        .map((op) => op.body)
        .filter((body) => body?.encoding === "multipart" && body.type.kind === "ref")
        .map((body) => (body!.type as Extract<TypeRef, { kind: "ref" }>).name),
    );

    for (const name of RUNTIME_FILES) {
      await ctx.write(`${SOURCES_DIR}/${name}.swift`, await loadRuntime(ir, name));
    }

    // One file per type. A single 9,000-line module would compile just as well
    // — SwiftPM builds the whole target either way — but jump-to-definition,
    // review diffs and compiler diagnostics all key off file names, and 177
    // types in one file makes every one of those worse.
    const banner = fileBanner(ir, C_STYLE, PACKAGE_NAME);
    const header = `${banner}import Foundation\n\n`;
    for (const schema of ir.schemas) {
      await ctx.write(
        `${SOURCES_DIR}/Models/${names.schema(schema.name)}.swift`,
        `${header}${emitSchema(emitCtx, schema, multipartSchemas.has(schema.name))}\n`,
      );
    }

    // Namespaces are grouped by their top-level segment, so a feature's whole
    // call surface — `client.accounts` and everything under it — reads in one
    // place. Types an operation needs declared go in the same file.
    const clientScope = rootScope(emitCtx);
    const client = emitNamespaceClass(emitCtx, ir.root, clientScope, ir);
    await ctx.write(
      `${SOURCES_DIR}/Client.swift`,
      `${header}${[...clientScope.decls, client].join("\n\n")}\n`,
    );

    for (const child of ir.root.children.values()) {
      const scope = rootScope(emitCtx);
      const classes = emitNamespaceTree(emitCtx, child, scope, ir);
      // Named after the class rather than the namespace segment: `Profile` is
      // both a model and a namespace here, and two `Profile.swift` files in one
      // target collide at the object-file level.
      await ctx.write(
        `${SOURCES_DIR}/Namespaces/${names.namespace(child.path)}.swift`,
        `${header}${[...scope.decls, ...classes].join("\n\n")}\n`,
      );
    }

    await ctx.write("Package.swift", packageManifest(ir));
    await ctx.write("README.md", readme(ir));
    // MIT requires the license text and the copyright notice to travel with
    // every copy, so this is an artifact, not a nicety.
    await ctx.write("LICENSE", LICENSE_TEXT);
    await ctx.write(
      `Sources/${TEST_MODULE_NAME}/${TEST_FILE}.swift`,
      await loadRuntime(ir, TEST_FILE),
    );

    for (const { from, to } of names.renamed) {
      ctx.log(`  renamed schema ${from} → ${to} (collides with a reserved name)`);
    }
    ctx.log(`  ${ir.schemas.length} models, ${ir.operations.length} operations`);
  },
};
