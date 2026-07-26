/**
 * The C# SDK target.
 *
 * Emits a plain `Microsoft.NET.Sdk` class library — `net8.0`, nullable enabled,
 * **zero NuGet dependencies**, because `System.Net.Http` and `System.Text.Json`
 * are both in-box. Three parts, mirroring the TypeScript target:
 *
 *   1. the hand-written request plumbing from `./runtime/*.cs.txt`, copied
 *      verbatim (see `loadRuntime`),
 *   2. one type per `components.schemas` entry, plus one per anonymous object
 *      the spec inlines into a request or a response,
 *   3. one class per namespace in the dotted call tree, bottomed out by
 *      `APIV1Client`.
 *
 * ## Why one file per type
 *
 * TypeScript ships a single `index.ts` because the compiler collapses it anyway.
 * C# has no such step: the 240-odd public types here would make one file the
 * length of a small novel, and every IDE "go to definition", every stack frame
 * and every diff hunk would point at the same path. The .NET convention is
 * one file per type named after the type, so that is what this emits — under
 * `src/Models`, `src/Namespaces` and `src/Constants`. The csproj globs every
 * `.cs` file under the project by default, so the layout costs nothing to declare.
 *
 * ## Why records
 *
 * Models are `sealed record` with `init` accessors. Records give value equality
 * and `with` expressions for free, which is exactly right for DTOs that are
 * compared and copied rather than mutated, and `init` keeps the object-initializer
 * syntax that System.Text.Json and hand-written call sites both want. They are
 * *not* positional records: a positional record fixes parameter order, and the
 * order of `properties` in the spec is not something callers should be pinned to.
 *
 * ## The one target with no toolchain check
 *
 * Every other target either compiles its output or runs it. This one cannot —
 * there is no `dotnet` in the build environment — so the emitter leans on the
 * conservative end of the language throughout: no `required` members, no source
 * generators, no custom `JsonConverter`s, no clever generic variance. If a
 * construct has a version-sensitive edge, it is not used.
 */
import { readFile } from "node:fs/promises";
import { C_STYLE, commentLines, fileBanner, operationDocParts, wrap } from "../../emit";
import { camelCase, pascalCase, uniqueName } from "../../naming";
import {
  AUTHOR,
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

const PACKAGE_NAME = "Infrawrench.Sdk";
const CLIENT_CLASS = "APIV1Client";
const RUNTIME_SENTINEL = "// --8<--";

/**
 * The runtime sources, in the order they are reported. Each is a complete C#
 * file below its sentinel line — `using` directives and namespace declaration
 * included — so what is reviewed in `./runtime/` is exactly what ships.
 */
const RUNTIME_FILES = [
  "SdkJson",
  "ClientOptions",
  "RequestOptions",
  "FileUpload",
  "ApiException",
  "RequestSpec",
  "ApiTransport",
  "MultipartBuilder",
] as const;

/**
 * Emitted at the top of every generated file.
 *
 * The same block everywhere rather than a per-file computed set: an unused
 * `using` is not a warning in C#, whereas a missing one is an error, and this
 * emitter has no compiler to catch the second kind.
 */
const USING_BLOCK = [
  "using System;",
  "using System.Collections.Generic;",
  "using System.Net.Http;",
  "using System.Text.Json;",
  "using System.Text.Json.Nodes;",
  "using System.Text.Json.Serialization;",
  "using System.Threading;",
  "using System.Threading.Tasks;",
].join("\n");

/**
 * Names the generated assembly must not shadow.
 *
 * Type names declared in `namespace Infrawrench.Sdk` beat anything a `using`
 * brings in, so a schema called `Task` would silently take over every
 * `Task<T>` return in the package. Anything the emitted code names unqualified
 * therefore has to be listed here; a schema that lands on one is declared with
 * a `Model` suffix instead.
 */
const RESERVED_NAMES = new Set([
  // emitted by ./runtime/
  CLIENT_CLASS,
  "ApiException",
  "ApiTransport",
  "ClientOptions",
  "FileUpload",
  "MultipartBuilder",
  "RequestOptions",
  "RequestSpec",
  "SdkJson",
  // BCL types the emitted code names without qualification
  "ArgumentNullException",
  "ByteArrayContent",
  "CancellationToken",
  "CultureInfo",
  "Dictionary",
  "Encoding",
  "Exception",
  "HttpClient",
  "HttpCompletionOption",
  "HttpContent",
  "HttpMethod",
  "HttpRequestMessage",
  "HttpResponseMessage",
  "IDictionary",
  "IDisposable",
  "IEnumerable",
  "IFormattable",
  "IReadOnlyDictionary",
  "IReadOnlyList",
  "InvalidOperationException",
  "JsonArray",
  "JsonElement",
  "JsonException",
  "JsonExtensionData",
  "JsonIgnore",
  "JsonIgnoreCondition",
  "JsonNode",
  "JsonObject",
  "JsonPropertyName",
  "JsonSerializer",
  "JsonSerializerOptions",
  "JsonValue",
  "KeyValuePair",
  "List",
  "MediaTypeHeaderValue",
  "MultipartFormDataContent",
  "Obsolete",
  "ObsoleteAttribute",
  "StringBuilder",
  "StringComparer",
  "StringComparison",
  "StringContent",
  "Task",
  "TimeSpan",
  "Uri",
  // names that would be confusing rather than broken, but still are not free
  "Array",
  "Convert",
  "DateTime",
  "DateTimeOffset",
  "Guid",
  "Math",
  "Nullable",
  "Object",
  "Stream",
  "String",
  "Type",
]);

/** Every C# reserved word. Identifiers that land on one take an `@` prefix. */
const CS_KEYWORDS = new Set(
  (
    "abstract as base bool break byte case catch char checked class const continue decimal " +
    "default delegate do double else enum event explicit extern false finally fixed float for " +
    "foreach goto if implicit in int interface internal is lock long namespace new null object " +
    "operator out override params private protected public readonly ref return sbyte sealed " +
    "short sizeof stackalloc static string struct switch this throw true try typeof uint ulong " +
    "unchecked unsafe ushort using virtual void volatile while"
  ).split(" "),
);

const IDENTIFIER_START = /^[A-Za-z_]/;

// ---------------------------------------------------------------------------
// C# types
// ---------------------------------------------------------------------------

/**
 * A printed type, plus whether it is a value type.
 *
 * The flag exists for exactly one reason: a non-nullable *reference*-typed
 * property needs `= default!` to keep the nullable analyzer quiet, and a value
 * type must not have one.
 */
interface CsType {
  text: string;
  valueType: boolean;
}

function ref(text: string): CsType {
  return { text, valueType: false };
}

function value(text: string): CsType {
  return { text, valueType: true };
}

/** Idempotent — `string?` must not become `string??`. */
function nullable(type: CsType): CsType {
  return type.text.endsWith("?") ? type : { text: `${type.text}?`, valueType: type.valueType };
}

/**
 * The stand-in for anything the spec does not pin down: free-form values,
 * and unions whose members have nothing in common.
 *
 * `JsonNode` rather than `object` or `JsonElement` because it is the one of the
 * three a caller can both read and *build* without ceremony — it has implicit
 * conversions from the primitives and an indexer for objects and arrays.
 */
const JSON_NODE = ref("JsonNode?");

// ---------------------------------------------------------------------------
// Schema flattening
// ---------------------------------------------------------------------------

/**
 * What a composite type contributes once its `allOf`/`anyOf` layers are peeled
 * off. See `absorb` for the rules.
 */
interface Flat {
  properties: PropertyDef[];
  additional: TypeRef | null;
  nullable: boolean;
  /** Members that carry no properties — printed when nothing else does. */
  scalars: TypeRef[];
}

/**
 * Merge an `allOf` chain into a single property list.
 *
 * C# could express `allOf` as record inheritance, but only where every base is
 * itself a record and nothing else in the chain is a union or a free-form
 * object — which is not true here (`Role` extends `RoleSummary`, and
 * `RoleSummary` is `object | null`). Flattening always works, costs a little
 * duplication in the emitted source, and produces exactly one shape per type
 * rather than a hierarchy the serializer has to be told about.
 */
function flatten(type: TypeRef, schemas: Map<string, SchemaDef>): Flat {
  const flat: Flat = { properties: [], additional: null, nullable: false, scalars: [] };
  absorb(type, flat, schemas, new Set());
  return flat;
}

function absorb(
  type: TypeRef,
  flat: Flat,
  schemas: Map<string, SchemaDef>,
  seen: Set<string>,
): void {
  switch (type.kind) {
    case "null":
      flat.nullable = true;
      return;
    case "unknown":
      // `X & unknown` is X. Contributing nothing is the whole point.
      return;
    case "ref": {
      if (seen.has(type.name)) return;
      const schema = schemas.get(type.name);
      if (!schema) {
        flat.scalars.push(type);
        return;
      }
      seen.add(type.name);
      absorb(schema.type, flat, schemas, seen);
      return;
    }
    case "intersection":
      for (const member of type.members) absorb(member, flat, schemas, seen);
      return;
    case "union": {
      const members = type.members.filter((member) => {
        if (member.kind !== "null") return true;
        flat.nullable = true;
        return false;
      });
      // A single survivor is just a nullable version of that member. Several
      // are genuine alternatives, and merging them would invent a shape the
      // server never sends.
      if (members.length === 1) absorb(members[0]!, flat, schemas, seen);
      else for (const member of members) flat.scalars.push(member);
      return;
    }
    case "object":
      for (const property of type.properties) {
        const existing = flat.properties.findIndex((p) => p.name === property.name);
        if (existing === -1) flat.properties.push(property);
        else flat.properties[existing] = property;
      }
      if (type.additional !== null && flat.additional === null) flat.additional = type.additional;
      return;
    default:
      flat.scalars.push(type);
  }
}

// ---------------------------------------------------------------------------
// The model registry
// ---------------------------------------------------------------------------

/** A type the package declares as a `record`. */
interface RecordDef {
  name: string;
  description?: string | undefined;
  /** Set when the record came from `components.schemas`. */
  specName?: string | undefined;
  properties: PropertyDef[];
  additional: TypeRef | null;
  /** Emitted with a `ToMultipartContent()` helper. */
  multipart: boolean;
}

/** A spec enum, declared as string constants rather than a C# `enum`. */
interface EnumDef {
  name: string;
  specName: string;
  description?: string | undefined;
  values: string[];
}

/**
 * Resolves spec names to the identifiers the assembly actually declares, and
 * owns the decision of which schemas become types at all.
 *
 * A schema becomes a `record` when it has properties to declare. Everything
 * else — the string enums, the free-form `JsonObject` — is a *structural alias*
 * that prints as its underlying C# type wherever it is referenced. That avoids
 * a pile of single-field wrapper types, and it dodges a collision that would
 * otherwise be fatal: the spec's `JsonObject` and `System.Text.Json.Nodes.JsonObject`
 * cannot both be `JsonObject` in this namespace.
 */
class Model {
  readonly taken = new Set(RESERVED_NAMES);
  readonly records: RecordDef[] = [];
  readonly enums: EnumDef[] = [];
  readonly renamed: Array<{ from: string; to: string }> = [];
  /** Anonymous objects, keyed by the `TypeRef` node that produced them. */
  private readonly hoisted = new Map<TypeRef, RecordDef>();
  private readonly bySchema = new Map<string, RecordDef>();
  /** Schemas that print structurally, keyed by spec name. */
  private readonly aliases = new Map<string, TypeRef>();
  /** Schemas whose own definition admits `null`, so every reference is nullable. */
  private readonly nullableSchemas = new Set<string>();
  private readonly namespaces = new Map<string, string>();
  readonly schemas = new Map<string, SchemaDef>();

  constructor(ir: SdkIr) {
    for (const schema of ir.schemas) this.schemas.set(schema.name, schema);

    // Schemas first, so they keep their spec names wherever possible; the
    // namespace classes and the hoisted anonymous types take what is left.
    for (const schema of ir.schemas) {
      const flat = flatten(schema.type, this.schemas);
      if (flat.nullable) this.nullableSchemas.add(schema.name);
      if (flat.properties.length === 0) {
        this.aliases.set(schema.name, schema.type);
        continue;
      }
      const record: RecordDef = {
        name: this.claim(schema.name),
        description: schema.description,
        specName: schema.name,
        properties: flat.properties,
        additional: flat.additional,
        multipart: false,
      };
      this.records.push(record);
      this.bySchema.set(schema.name, record);
    }

    // Enums are declared as constants classes, so their names occupy the same
    // namespace as the records and have to be claimed alongside them.
    for (const schema of ir.schemas) {
      const alias = this.aliases.get(schema.name);
      if (!alias || alias.kind !== "string" || !alias.enum) continue;
      this.enums.push({
        name: this.claim(schema.name),
        specName: schema.name,
        description: schema.description,
        values: alias.enum,
      });
    }

    this.registerNamespaces(ir.root);

    for (const schema of ir.schemas) {
      const record = this.bySchema.get(schema.name);
      if (!record) continue;
      for (const property of record.properties) {
        this.hoist(property.type, record.name + pascalCase(property.name));
      }
      if (record.additional) this.hoist(record.additional, `${record.name}Value`);
    }

    for (const op of ir.operations) {
      const base = [...op.namespace, op.name].map(pascalCase).join("");
      for (const parameter of op.parameters) {
        this.hoist(parameter.type, base + pascalCase(parameter.name));
      }
      if (op.body) {
        this.hoist(op.body.type, `${base}Request`);
        if (op.body.encoding === "multipart") {
          const record = this.recordFor(op.body.type);
          if (record) record.multipart = true;
        }
      }
      if (op.response.type) this.hoist(op.response.type, `${base}Response`);
    }
  }

  /** Take `specName` if it is free, or a `Model`-suffixed variant if it is not. */
  private claim(specName: string): string {
    const base = IDENTIFIER_START.test(specName) ? specName : pascalCase(specName) || "Schema";
    const resolved = uniqueName(this.taken.has(base) ? `${base}Model` : base, this.taken);
    if (resolved !== specName) this.renamed.push({ from: specName, to: resolved });
    return resolved;
  }

  private registerNamespaces(node: NamespaceDef): void {
    const key = node.path.join(".");
    if (!this.namespaces.has(key)) {
      this.namespaces.set(
        key,
        node.path.length === 0
          ? CLIENT_CLASS
          : uniqueName(`${node.path.map(pascalCase).join("")}Namespace`, this.taken),
      );
    }
    for (const child of node.children.values()) this.registerNamespaces(child);
  }

  /**
   * Give every anonymous object in `type` a name.
   *
   * The hint is the path that led here — `AccountDetail` + `Meta` — which reads
   * far better in a stack trace than a serial number would, and stays stable as
   * long as the spec's property names do.
   */
  private hoist(type: TypeRef, hint: string): void {
    switch (type.kind) {
      case "array":
        this.hoist(type.items, `${hint}Item`);
        return;
      case "union": {
        const members = type.members.filter((member) => member.kind !== "null");
        // A union with real alternatives prints as `JsonNode?`, so naming the
        // objects inside it would declare types nothing ever references.
        if (members.length === 1) this.hoist(members[0]!, hint);
        return;
      }
      case "object":
      case "intersection": {
        if (this.hoisted.has(type)) return;
        const flat = flatten(type, this.schemas);
        if (flat.properties.length === 0) {
          if (flat.additional) this.hoist(flat.additional, `${hint}Value`);
          return;
        }
        const record: RecordDef = {
          name: uniqueName(IDENTIFIER_START.test(hint) ? hint : `Model${hint}`, this.taken),
          properties: flat.properties,
          additional: flat.additional,
          multipart: false,
        };
        this.records.push(record);
        this.hoisted.set(type, record);
        for (const property of flat.properties) {
          this.hoist(property.type, record.name + pascalCase(property.name));
        }
        if (flat.additional) this.hoist(flat.additional, `${record.name}Value`);
        return;
      }
      default:
        return;
    }
  }

  /** The record a body or response resolves to, if it resolves to one at all. */
  recordFor(type: TypeRef): RecordDef | undefined {
    if (type.kind === "ref") return this.bySchema.get(type.name);
    return this.hoisted.get(type);
  }

  alias(specName: string): TypeRef | undefined {
    return this.aliases.get(specName);
  }

  isNullableSchema(specName: string): boolean {
    return this.nullableSchemas.has(specName);
  }

  namespaceClass(path: string[]): string {
    return this.namespaces.get(path.join(".")) ?? CLIENT_CLASS;
  }
}

// ---------------------------------------------------------------------------
// Type printing
// ---------------------------------------------------------------------------

function printType(type: TypeRef, model: Model, seen: Set<string> = new Set()): CsType {
  switch (type.kind) {
    case "ref": {
      const record = model.recordFor(type);
      if (record) {
        const printed = ref(record.name);
        return model.isNullableSchema(type.name) ? nullable(printed) : printed;
      }
      const alias = model.alias(type.name);
      // Cycles between aliases would be pathological, but a generator that
      // hangs on one is worse than one that prints `JsonNode?`.
      if (!alias || seen.has(type.name)) return JSON_NODE;
      const printed = printType(alias, model, new Set(seen).add(type.name));
      return model.isNullableSchema(type.name) ? nullable(printed) : printed;
    }
    case "string":
      // Every `format` — uuid, date-time, email, uri — stays a string. Mapping
      // them to Guid/DateTimeOffset/Uri would be nicer to hold, but it moves
      // parsing into the deserializer, where one malformed field fails the
      // whole response instead of the one call site that cares.
      return ref("string");
    case "number":
      return value(type.integer ? "long" : "double");
    case "boolean":
      return value("bool");
    case "binary":
      return ref("FileUpload");
    case "null":
    case "unknown":
      return JSON_NODE;
    case "array":
      // `List<T>` rather than `IReadOnlyList<T>`: it round-trips through
      // System.Text.Json in both directions with no converter and no doubt,
      // and a caller can build one inline.
      return ref(`List<${printType(type.items, model, seen).text}>`);
    case "object":
    case "intersection": {
      const record = model.recordFor(type);
      const flat = flatten(type, model.schemas);
      if (record) {
        const printed = ref(record.name);
        return flat.nullable ? nullable(printed) : printed;
      }
      const printed = printComposite(flat, model, seen);
      return flat.nullable ? nullable(printed) : printed;
    }
    case "union": {
      const members = type.members.filter((member) => member.kind !== "null");
      const isNullable = members.length !== type.members.length;
      const distinct = [...new Set(members.map((m) => printType(m, model, seen).text))];
      if (distinct.length === 1) {
        const printed = printType(members[0]!, model, seen);
        return isNullable ? nullable(printed) : printed;
      }
      return JSON_NODE;
    }
  }
}

/** An object with no declared properties: an open map, or nothing at all. */
function printComposite(flat: Flat, model: Model, seen: Set<string>): CsType {
  if (flat.additional !== null) {
    return ref(`Dictionary<string, ${printType(flat.additional, model, seen).text}>`);
  }
  const distinct = [...new Set(flat.scalars.map((s) => printType(s, model, seen).text))];
  if (distinct.length === 1) return printType(flat.scalars[0]!, model, seen);
  if (distinct.length === 0) return ref("Dictionary<string, JsonNode?>");
  return JSON_NODE;
}

/**
 * A one-line note naming what a `JsonNode` actually holds.
 *
 * Degrading a union to `JsonNode?` is honest but opaque, so the alternatives go
 * in the doc comment where the caller can see what to deserialize into.
 */
function unionNote(type: TypeRef, model: Model): string | undefined {
  if (type.kind !== "union") return undefined;
  const members = type.members.filter((member) => member.kind !== "null");
  const distinct = [...new Set(members.map((m) => printType(m, model).text))];
  if (distinct.length < 2) return undefined;
  return `One of: ${distinct.join(", ")}. Returned as JsonNode so no branch is lost — deserialize into whichever you expect.`;
}

/** The allowed values of an inline enum, for the doc comment. */
function enumNote(type: TypeRef): string | undefined {
  if (type.kind !== "string" || !type.enum) return undefined;
  return `Allowed values: ${type.enum.map((v) => `"${v}"`).join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Identifiers and doc comments
// ---------------------------------------------------------------------------

function escapeIdentifier(name: string): string {
  const safe = IDENTIFIER_START.test(name) ? name : `_${name}`;
  return CS_KEYWORDS.has(safe) ? `@${safe}` : safe;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * An XML documentation comment.
 *
 * `emit.docComment` is not reused here because it cannot nest: C# wants the
 * prose inside a `<summary>` element and the per-argument notes in sibling
 * `<param>` elements, which is a structure, not a block of text. The wrapping
 * and the `///` prefixing — the parts that genuinely should look the same in
 * every SDK — still come from `emit`.
 */
function xmlDoc(indent: string, parts: Array<string | undefined>, tags: string[] = []): string[] {
  const blocks = parts.filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  if (blocks.length === 0 && tags.length === 0) return [];
  const lines: string[] = [];
  if (blocks.length > 0) {
    lines.push(
      "<summary>",
      ...wrap(escapeXml(blocks.join("\n\n")), 92 - indent.length),
      "</summary>",
    );
  }
  lines.push(...tags);
  return commentLines(lines, C_STYLE.doc ?? C_STYLE.line, indent);
}

function paramTag(name: string, description: string | undefined): string | undefined {
  if (!description || description.trim() === "") return undefined;
  // The XML name is the identifier without its `@` escape — `@class` is
  // documented as `class`.
  const bare = name.startsWith("@") ? name.slice(1) : name;
  return `<param name="${bare}">${escapeXml(description.trim())}</param>`;
}

/** Wrap a whole file: banner, usings, namespace, then the declaration. */
function csharpFile(ir: SdkIr, body: string): string {
  return `${fileBanner(ir, C_STYLE, PACKAGE_NAME)}${USING_BLOCK}\n\nnamespace ${PACKAGE_NAME};\n\n${body.trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const EXTENSION_MEMBER = "AdditionalProperties";
const MULTIPART_MEMBER = "ToMultipartContent";

/**
 * Property name → C# member name.
 *
 * Two rules beyond the casing. A member may not share its enclosing type's name
 * (so `Error.error` becomes `Error.ErrorValue`), and two spec properties that
 * pascal-case to the same identifier have to be pulled apart.
 */
function memberNames(record: RecordDef): Map<string, string> {
  const taken = new Set<string>([record.name, EXTENSION_MEMBER, MULTIPART_MEMBER]);
  const names = new Map<string, string>();
  for (const property of record.properties) {
    const cased = pascalCase(property.name) || "Value";
    const safe = IDENTIFIER_START.test(cased) ? cased : `Value${cased}`;
    names.set(property.name, uniqueName(safe === record.name ? `${safe}Value` : safe, taken));
  }
  return names;
}

function propertyType(property: PropertyDef, model: Model): CsType {
  const base = printType(property.type, model);
  return property.required ? base : nullable(base);
}

function emitRecord(ir: SdkIr, record: RecordDef, model: Model): string {
  const names = memberNames(record);
  const lines: string[] = [];

  lines.push(
    ...xmlDoc("", [
      record.description,
      record.specName && record.specName !== record.name
        ? `Spec schema: ${record.specName}.`
        : undefined,
      record.specName ? undefined : "Declared inline by the spec; named after where it appears.",
    ]),
  );
  lines.push(`public sealed record ${record.name}`, "{");

  let first = true;
  for (const property of record.properties) {
    if (!first) lines.push("");
    first = false;

    const member = names.get(property.name)!;
    const type = propertyType(property, model);
    lines.push(
      ...xmlDoc("    ", [
        property.description,
        enumNote(property.type),
        unionNote(property.type, model),
        property.deprecated === true ? "Deprecated." : undefined,
        property.required ? undefined : "Omitted from the request when left null.",
      ]),
    );
    lines.push(`    [JsonPropertyName(${JSON.stringify(property.name)})]`);
    // `= default!` only where the analyzer would otherwise complain: a
    // non-nullable reference type with no constructor to initialize it.
    const initializer = !type.valueType && !type.text.endsWith("?") ? " = default!;" : "";
    lines.push(`    public ${type.text} ${member} { get; init; }${initializer}`);
  }

  if (record.additional !== null) {
    if (!first) lines.push("");
    first = false;
    lines.push(
      ...xmlDoc("    ", [
        "Properties the spec does not name.",
        "Populated on deserialization and written back out on serialization, so a field the server added after this package was generated survives a round trip.",
      ]),
    );
    lines.push(
      "    [JsonExtensionData]",
      `    public Dictionary<string, JsonElement>? ${EXTENSION_MEMBER} { get; set; }`,
    );
  }

  if (record.multipart) {
    if (!first) lines.push("");
    lines.push(...emitMultipart(record, names));
  }

  lines.push("}");
  return csharpFile(ir, lines.join("\n"));
}

/** The `multipart/form-data` writer for a model the spec posts as a form. */
function emitMultipart(record: RecordDef, names: Map<string, string>): string[] {
  const lines = xmlDoc("    ", [
    "Render this model as a multipart/form-data body.",
    "Internal because it is request plumbing, not part of the model's contract; the generated call site is the only caller.",
  ]);
  lines.push(
    `    internal MultipartFormDataContent ${MULTIPART_MEMBER}()`,
    "    {",
    "        var content = new MultipartFormDataContent();",
  );
  for (const property of record.properties) {
    lines.push(
      `        MultipartBuilder.Add(content, ${JSON.stringify(property.name)}, ${names.get(property.name)!});`,
    );
  }
  lines.push("        return content;", "    }");
  return lines;
}

/**
 * A spec enum, as string constants rather than a C# `enum`.
 *
 * A real `enum` would need a converter, and — worse — would fail to
 * deserialize the moment the server learned a new value, which for a list like
 * `ResourceTypeId` is a certainty rather than a risk. Constants give callers
 * the same discoverability and the same compile-time spelling check while
 * leaving the field a plain `string` that cannot break.
 */
function emitEnum(ir: SdkIr, def: EnumDef): string {
  const taken = new Set<string>([def.name, "All"]);
  const lines: string[] = [];
  lines.push(
    ...xmlDoc("", [
      def.description,
      `The values \`${def.specName}\` documents. The fields that hold them are plain strings, so a value added to the API after this package was generated still round-trips.`,
    ]),
  );
  lines.push(`public static class ${def.name}`, "{");

  const members: string[] = [];
  for (const literal of def.values) {
    const cased = pascalCase(literal) || "Value";
    const start = IDENTIFIER_START.test(cased) ? cased : `Value${cased}`;
    // A constant may not share the name of the class that holds it.
    const member = uniqueName(start === def.name ? `${start}Value` : start, taken);
    members.push(member);
    lines.push(
      ...xmlDoc("    ", [`\`${literal}\``]),
      `    public const string ${member} = ${JSON.stringify(literal)};`,
      "",
    );
  }

  lines.push(
    ...xmlDoc("    ", ["Every value listed above, in spec order."]),
    `    public static readonly IReadOnlyList<string> All = new string[]`,
    "    {",
    ...members.map((member) => `        ${member},`),
    "    };",
    "}",
  );
  return csharpFile(ir, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** One argument of a generated method, already resolved to C#. */
interface Argument {
  id: string;
  type: string;
  /** `" = null"`, `" = default"`, or empty for a required argument. */
  suffix: string;
  doc?: string | undefined;
  /**
   * The spec name this argument carries, so the call site can find it again.
   * C# forces optional arguments last, which reorders them away from `op.parameters`.
   */
  wire?: string | undefined;
  body?: boolean | undefined;
}

function parameterDoc(parameter: ParameterDef, ir: SdkIr): string | undefined {
  const parts = [parameter.description, enumNote(parameter.type)].filter(Boolean).join(" ");
  if (!parameter.defaultable) return parts || undefined;
  const lead = parts ? `${parts.replace(/\.$/, "")}. ` : "";
  return `${lead}Defaults to the ${ir.defaultablePathParam ?? "scope"} the client was constructed with.`;
}

/**
 * The argument list, in the order C# forces.
 *
 * Optional arguments have to follow required ones, which decides most of it:
 * everything the wire requires comes first, then everything with a default,
 * then the defaultable scope parameter, then the two the SDK adds itself.
 */
function operationArguments(op: OperationDef, model: Model, ir: SdkIr): Argument[] {
  const taken = new Set<string>();
  const required: Argument[] = [];
  const optional: Argument[] = [];
  const scoped: Argument[] = [];

  for (const parameter of op.parameters) {
    const type = printType(parameter.type, model);
    const id = uniqueName(escapeIdentifier(camelCase(parameter.name) || "arg"), taken);
    const doc = parameterDoc(parameter, ir);
    const wire = parameter.name;
    if (parameter.defaultable) {
      scoped.push({ id, type: nullable(type).text, suffix: " = null", doc, wire });
    } else if (parameter.required) {
      required.push({ id, type: type.text, suffix: "", doc, wire });
    } else {
      optional.push({ id, type: nullable(type).text, suffix: " = null", doc, wire });
    }
  }

  if (op.body) {
    const type = printType(op.body.type, model);
    const id = uniqueName(escapeIdentifier("body"), taken);
    const doc =
      op.body.encoding === "multipart"
        ? "Sent as multipart/form-data."
        : (unionNote(op.body.type, model) ?? "The request body.");
    if (op.body.required) required.push({ id, type: type.text, suffix: "", doc, body: true });
    else optional.push({ id, type: nullable(type).text, suffix: " = null", doc, body: true });
  }

  const options = uniqueName(escapeIdentifier("options"), taken);
  const token = uniqueName(escapeIdentifier("cancellationToken"), taken);
  return [
    ...required,
    ...optional,
    ...scoped,
    {
      id: options,
      type: "RequestOptions?",
      suffix: " = null",
      doc: "Per-call header overrides.",
    },
    { id: token, type: "CancellationToken", suffix: " = default", doc: "Cancels the request." },
  ];
}

function returnType(op: OperationDef, model: Model): string | null {
  switch (op.response.encoding) {
    case "binary":
      return "byte[]";
    case "empty":
      return null;
    case "json":
      return op.response.type ? printType(op.response.type, model).text : JSON_NODE.text;
  }
}

function emitOperation(op: OperationDef, method: string, model: Model, ir: SdkIr): string[] {
  const args = operationArguments(op, model, ir);
  // The last two are always `options` and `cancellationToken`.
  const options = args[args.length - 2]!;
  const token = args[args.length - 1]!;

  const byName = new Map<string, string>();
  let bodyArg: string | null = null;
  for (const arg of args) {
    if (arg.wire !== undefined) byName.set(arg.wire, arg.id);
    if (arg.body === true) bodyArg = arg.id;
  }

  const returns = returnType(op, model);
  const signature = returns === null ? "Task" : `Task<${returns}>`;

  const lines: string[] = [];
  lines.push(
    ...xmlDoc(
      "    ",
      [
        ...operationDocParts(op),
        op.requiredPermission ? `Requires: ${op.requiredPermission}` : undefined,
        op.response.type ? unionNote(op.response.type, model) : undefined,
      ],
      [
        ...args
          .map((arg) => paramTag(arg.id, arg.doc))
          .filter((tag): tag is string => tag !== undefined),
        ...(returns === null
          ? []
          : [
              `<returns>${escapeXml(
                op.response.description ?? `The ${op.response.status} response body.`,
              )}</returns>`,
            ]),
        `<exception cref="ApiException">Thrown for any non-2xx response.</exception>`,
      ],
    ),
  );
  if (op.deprecated) lines.push('    [Obsolete("Deprecated in the API spec.")]');

  lines.push(`    public ${signature} ${method}(`);
  lines.push(
    ...args.map(
      (arg, i) => `        ${arg.type} ${arg.id}${arg.suffix}${i === args.length - 1 ? ")" : ","}`,
    ),
  );
  lines.push("    {");

  const initializer: string[] = [];
  const pathParams = op.parameters.filter((parameter) => parameter.in === "path");
  if (pathParams.length > 0) {
    initializer.push("            PathParams = new Dictionary<string, object?>");
    initializer.push("            {");
    for (const parameter of pathParams) {
      initializer.push(
        `                [${JSON.stringify(parameter.name)}] = ${byName.get(parameter.name)!},`,
      );
    }
    initializer.push("            },");
  }
  const queryParams = op.parameters.filter((parameter) => parameter.in === "query");
  if (queryParams.length > 0) {
    initializer.push("            Query = new List<KeyValuePair<string, object?>>");
    initializer.push("            {");
    for (const parameter of queryParams) {
      initializer.push(
        `                new KeyValuePair<string, object?>(${JSON.stringify(parameter.name)}, ${byName.get(parameter.name)!}),`,
      );
    }
    initializer.push("            },");
  }
  if (op.body && bodyArg) {
    if (op.body.encoding === "multipart") {
      // `?.` for an optional body: no form at all is a different request from
      // an empty one.
      const access = op.body.required ? "." : "?.";
      initializer.push(`            Form = ${bodyArg}${access}${MULTIPART_MEMBER}(),`);
    } else {
      initializer.push(`            Body = ${bodyArg},`);
    }
  }

  const construction = `new RequestSpec(${JSON.stringify(op.method.toUpperCase())}, ${JSON.stringify(op.path)})`;
  if (initializer.length === 0) {
    lines.push(`        var spec = ${construction};`);
  } else {
    lines.push(`        var spec = ${construction}`, "        {", ...initializer, "        };");
  }
  lines.push("");

  const send =
    op.response.encoding === "binary"
      ? "SendBinaryAsync"
      : op.response.encoding === "empty"
        ? "SendEmptyAsync"
        : `SendJsonAsync<${returns}>`;
  lines.push(`        return _transport.${send}(spec, ${options.id}, ${token.id});`);
  lines.push("    }");
  return lines;
}

// ---------------------------------------------------------------------------
// Namespace classes
// ---------------------------------------------------------------------------

function emitNamespace(ir: SdkIr, node: NamespaceDef, model: Model): string {
  const isRoot = node.path.length === 0;
  const className = model.namespaceClass(node.path);
  const taken = new Set<string>([className, "Transport", "Dispose", "_transport"]);

  const children = [...node.children.entries()].map(([key, child]) => ({
    property: uniqueName(pascalCase(key) || "Group", taken),
    type: model.namespaceClass(child.path),
    dotted: child.path.map(pascalCase).join("."),
  }));
  const operations = node.operations.map((op) => ({
    op,
    // The `Async` suffix is not decoration in .NET — it is how a caller knows
    // the result has to be awaited.
    method: uniqueName(`${pascalCase(op.name) || "Invoke"}Async`, taken),
  }));

  const lines: string[] = [];

  if (isRoot) {
    lines.push(
      ...xmlDoc("", [
        `A client for the ${ir.title}.`,
        "Calls mirror the URL structure, so POST /api/org/{orgId}/accounts/{id}/sync is client.Accounts.SyncAsync(id).",
        "Set OrgId once on ClientOptions and every org-scoped call can leave it off; pass it on a call to override.",
      ]),
      `public sealed class ${CLIENT_CLASS} : IDisposable`,
      "{",
      "    private readonly ApiTransport _transport;",
      "",
      ...xmlDoc("    ", ["Build a client. Pass null for the defaults."]),
      `    public ${CLIENT_CLASS}(ClientOptions? options = null)`,
      "    {",
      "        _transport = new ApiTransport(options);",
      ...children.map((child) => `        ${child.property} = new ${child.type}(_transport);`),
      "    }",
      "",
      ...xmlDoc("    ", [
        "The shared request plumbing. Reach for this only to read the resolved base URL.",
      ]),
      "    public ApiTransport Transport => _transport;",
    );
  } else {
    lines.push(
      ...xmlDoc("", [`client.${node.path.map(pascalCase).join(".")}`]),
      `public sealed class ${className}`,
      "{",
      "    private readonly ApiTransport _transport;",
      "",
      `    internal ${className}(ApiTransport transport)`,
      "    {",
      "        _transport = transport;",
      ...children.map((child) => `        ${child.property} = new ${child.type}(transport);`),
      "    }",
    );
  }

  for (const child of children) {
    lines.push("", ...xmlDoc("    ", [`client.${child.dotted}`]));
    lines.push(`    public ${child.type} ${child.property} { get; }`);
  }

  for (const { op, method } of operations) {
    lines.push("");
    lines.push(...emitOperation(op, method, model, ir));
  }

  if (isRoot) {
    lines.push(
      "",
      ...xmlDoc("    ", [
        "Dispose the transport, which disposes the HttpClient only when the client created it.",
      ]),
      "    public void Dispose()",
      "    {",
      "        _transport.Dispose();",
      "    }",
    );
  }

  lines.push("}");
  return csharpFile(ir, lines.join("\n"));
}

function namespaceNodes(node: NamespaceDef): NamespaceDef[] {
  return [node, ...[...node.children.values()].flatMap(namespaceNodes)];
}

// ---------------------------------------------------------------------------
// Runtime, project file, README
// ---------------------------------------------------------------------------

/**
 * Read one hand-written runtime source and strip its "how this file is used"
 * preamble. Everything after the sentinel is the file as it ships.
 */
async function loadRuntime(name: string, ir: SdkIr): Promise<string> {
  const source = await readFile(new URL(`./runtime/${name}.cs.txt`, import.meta.url), "utf8");
  const start = source.indexOf(RUNTIME_SENTINEL);
  if (start === -1) {
    throw new Error(`runtime/${name}.cs.txt is missing its "${RUNTIME_SENTINEL}" sentinel line`);
  }
  const newline = source.indexOf("\n", start);
  const body = source
    .slice(newline + 1)
    .replace('"@@BASE_URL@@"', JSON.stringify(ir.baseUrl))
    .replace('"@@SCOPE_PARAM@@"', JSON.stringify(ir.defaultablePathParam))
    .trim();
  return `${fileBanner(ir, C_STYLE, PACKAGE_NAME)}${body}\n`;
}

/**
 * XML forbids `--` anywhere inside a comment, so the shared banner's
 * `pnpm --filter …` hint makes MSBuild refuse to load the project at all — a
 * far worse outcome than a terser command line. pnpm documents `-F` as the
 * alias for `--filter`, so the regenerate hint stays runnable; any other run of
 * dashes is collapsed rather than risking an unparseable manifest.
 */
function xmlComment(lines: string[], indent = ""): string {
  const safe = lines.map((line) => line.replace(/--filter\b/g, "-F").replace(/-{2,}/g, "-"));
  return [
    `${indent}<!--`,
    ...safe.map((line) => (line === "" ? "" : `${indent}  ${line}`)),
    `${indent}-->`,
  ].join("\n");
}

function projectFile(ir: SdkIr): string {
  // MSBuild property values are XML text: metadata that happens to contain an
  // ampersand would otherwise produce a project file that will not even load.
  const description = escapeXml(`Generated C# client for the ${ir.title} (v${ir.apiVersion}).`);
  const author = escapeXml(AUTHOR.name);
  const copyright = escapeXml(COPYRIGHT_NOTICE);
  return `${xmlComment([
    `${PACKAGE_NAME} v${ir.apiVersion} | ${LICENSE} | ${COPYRIGHT_NOTICE}`,
    REPOSITORY_URL,
    "",
    "DO NOT EDIT. Regenerate with:",
    "  pnpm --filter @infrawrench/web generate:sdk",
  ])}
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <LangVersion>12.0</LangVersion>
    <Nullable>enable</Nullable>
    <!-- Every file states its own usings, so the implicit set only adds noise. -->
    <ImplicitUsings>disable</ImplicitUsings>
    <GenerateDocumentationFile>true</GenerateDocumentationFile>
    <!-- CS1591 is "missing XML comment": not every field in the spec carries a
         description, and a warning per undescribed field would bury real ones.
         CS1573 is the same situation one level down - it fires when a method
         documents some of its parameters but not all, which is exactly what a
         spec that describes "orgId" but not "id" produces. Both are suppressed
         rather than papered over with filler <param> text, so the parameters
         the spec does describe still surface in IntelliSense and the rest stay
         silent instead of showing invented prose. -->
    <NoWarn>$(NoWarn);CS1591;CS1573</NoWarn>
    <RootNamespace>${PACKAGE_NAME}</RootNamespace>
    <AssemblyName>${PACKAGE_NAME}</AssemblyName>
  </PropertyGroup>

  <PropertyGroup>
    <PackageId>${PACKAGE_NAME}</PackageId>
    <Version>${ir.apiVersion}</Version>
    <Authors>${author}</Authors>
    <Company>${author}</Company>
    <Copyright>${copyright}</Copyright>
    <Description>${description}</Description>
    <PackageLicenseExpression>${LICENSE}</PackageLicenseExpression>
    <PackageProjectUrl>${HOMEPAGE}</PackageProjectUrl>
    <RepositoryUrl>${REPOSITORY_URL}</RepositoryUrl>
    <RepositoryType>git</RepositoryType>
    <PackageTags>${KEYWORDS.join(";")}</PackageTags>
    <PackageReadmeFile>README.md</PackageReadmeFile>
    <IncludeSymbols>true</IncludeSymbols>
    <SymbolPackageFormat>snupkg</SymbolPackageFormat>
  </PropertyGroup>

  <ItemGroup>
    <!-- Update, not Include: the SDK's default globs already picked these up,
         and adding them twice is an error. -->
    <None Update="README.md" Pack="true" PackagePath="\\" />
    <None Update="LICENSE" Pack="true" PackagePath="\\" />
  </ItemGroup>

  <!-- No PackageReference of any kind. System.Net.Http and System.Text.Json
       are both in-box on net8.0, so this package adds nothing to a consumer's
       dependency graph. -->

</Project>
`;
}

function readme(ir: SdkIr, model: Model): string {
  const example = ir.operations.find((op) => op.namespace[0] === "accounts" && op.name === "list");
  const call = example
    ? `client.${example.namespace.map(pascalCase).join(".")}.${pascalCase(example.name)}Async()`
    : "client";
  const namespaces = [...ir.root.children.keys()].map(pascalCase);

  return `# ${PACKAGE_NAME}

Generated C# client for the ${ir.title} (API version \`${ir.apiVersion}\`).

**Do not edit this package by hand** — it is regenerated from \`openapi.json\` and
is not checked into the repository. Run
\`pnpm --filter @infrawrench/web generate:sdk\` to rebuild it; the generator lives
in [\`${GENERATOR_PATH}\`](${REPOSITORY_URL}/tree/main/${GENERATOR_PATH}).

## Install

Targets \`net8.0\`. **No NuGet dependencies** — \`System.Net.Http\` and
\`System.Text.Json\` are in-box.

## Usage

\`\`\`csharp
using Infrawrench.Sdk;

using var client = new ${CLIENT_CLASS}(new ClientOptions
{
    ApiKey = Environment.GetEnvironmentVariable("INFRAWRENCH_API_KEY"),
    OrgId = Environment.GetEnvironmentVariable("INFRAWRENCH_ORG_ID"),
});

try
{
    var accounts = await ${call};
}
catch (ApiException error)
{
    Console.Error.WriteLine($"{error.StatusCode} {error.Code}: {error.Message}");
}
\`\`\`

Calls are namespaced to mirror the URL structure, so
\`POST /api/org/{orgId}/accounts/{id}/sync\` is \`client.Accounts.SyncAsync(id)\`.
Set \`OrgId\` once on \`ClientOptions\` and every org-scoped call can omit it;
pass \`orgId\` on an individual call to override it.

Top-level namespaces: ${namespaces.map((name) => `\`${name}\``).join(", ")}.

Every method ends with an optional \`RequestOptions\` (per-call headers) and a
\`CancellationToken\`. Non-2xx responses throw \`ApiException\`, which carries
\`StatusCode\`, the parsed \`Body\`, the raw \`RawBody\`, and the machine-readable
\`Code\` when the API sends one.

## Shapes

- Models are \`sealed record\`s with \`init\` accessors, so \`with\` expressions work.
- Spec enums are \`static class\`es of \`const string\`s (for example \`ResourceStatus.Healthy\`).
  The fields that hold them stay \`string\`, so a value the API adds later still
  round-trips instead of failing to deserialize.
- Anything the spec leaves free-form, and any union whose branches have nothing
  in common, is \`JsonNode?\`. Call \`Deserialize<T>()\` on it when you know the shape.
- \`format: binary\` fields are \`FileUpload\`, which carries the bytes, the
  filename and an optional content type.
- Date, uuid, email and uri strings stay \`string\`: parsing them in the
  deserializer would let one malformed field fail an entire response.

## Supply your own HttpClient

\`\`\`csharp
var client = new ${CLIENT_CLASS}(new ClientOptions
{
    ApiKey = key,
    HttpClient = httpClientFactory.CreateClient("infrawrench"),
});
\`\`\`

The client disposes its \`HttpClient\` only when it created one itself.

## Scope

This package covers the published API surface only. Operations marked
\`x-internal\` in the spec — the admin surface, webhook receivers, desktop sync,
push registration, and the browser auth redirects — are not generated.

${ir.operations.length} operations across ${model.records.length} models.

## License

${LICENSE} — see [\`LICENSE\`](./LICENSE). ${COPYRIGHT_NOTICE}.

Note that this client is more permissively licensed than the service it talks
to: the Infrawrench source is BUSL-1.1, but the generated clients are ${LICENSE} so you
can link one into your own software without inheriting those terms.

Issues: <${ISSUES_URL}>
`;
}

// ---------------------------------------------------------------------------

export const csharpTarget: SdkTarget = {
  id: "csharp",
  displayName: "C#",
  packageName: PACKAGE_NAME,
  artifacts: [
    `${PACKAGE_NAME}.csproj`,
    "LICENSE",
    "README.md",
    `src/${CLIENT_CLASS}.cs`,
    "src/ApiTransport.cs",
    "src/ApiException.cs",
    "src/ClientOptions.cs",
  ],

  async generate(ir: SdkIr, ctx: TargetContext): Promise<void> {
    const model = new Model(ir);

    for (const name of RUNTIME_FILES) {
      await ctx.write(`src/${name}.cs`, await loadRuntime(name, ir));
    }

    for (const record of model.records) {
      await ctx.write(`src/Models/${record.name}.cs`, emitRecord(ir, record, model));
    }
    for (const def of model.enums) {
      await ctx.write(`src/Constants/${def.name}.cs`, emitEnum(ir, def));
    }

    for (const node of namespaceNodes(ir.root)) {
      const className = model.namespaceClass(node.path);
      const path =
        node.path.length === 0 ? `src/${className}.cs` : `src/Namespaces/${className}.cs`;
      await ctx.write(path, emitNamespace(ir, node, model));
    }

    await ctx.write(`${PACKAGE_NAME}.csproj`, projectFile(ir));
    await ctx.write("README.md", readme(ir, model));
    // MIT requires the license text and copyright notice to travel with every
    // copy, so this is an artifact, not a nicety.
    await ctx.write("LICENSE", LICENSE_TEXT);

    for (const { from, to } of model.renamed) {
      ctx.log(`  renamed schema ${from} → ${to} (collides with a reserved name)`);
    }
    ctx.log(
      `  ${model.records.length} records, ${model.enums.length} constant classes, ` +
        `${namespaceNodes(ir.root).length} namespace classes`,
    );
  },
};
