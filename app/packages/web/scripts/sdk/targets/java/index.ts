/**
 * The Java SDK target.
 *
 * Emits a Maven project under `sdk/java/`:
 *
 *   1. the hand-written request plumbing from `./runtime/*.java.txt`, copied
 *      out verbatim into `com.infrawrench.sdk`,
 *   2. one file per public type under `com.infrawrench.sdk.models` — a `record`
 *      for every object schema, a constants class for every enum schema,
 *   3. one file per namespace in the dotted call tree, bottomed out by
 *      `APIV1Client`, which owns the transport and the top-level namespaces.
 *
 * Three decisions worth stating up front, because they shape everything else.
 *
 * **One file per type, not one giant file.** Java ties a public type to a file
 * of the same name, so 177 schemas in one compilation unit would mean 176 of
 * them are package-private and invisible to consumers. Even ignoring that, a
 * 15k-line file is where `git blame` and every IDE go to die.
 *
 * **Records for models.** They give value semantics, `equals`/`hashCode`/
 * `toString`, and — the part that actually pays for itself here — a runtime
 * description of their own shape via `getRecordComponents()`, complete with
 * generic types. That is what lets `Json` map 177 types reflectively instead of
 * this file emitting ~350 serializer methods. The cost is that a record's
 * canonical constructor is positional, and the widest schema has 36 components,
 * so every record also gets a builder.
 *
 * **Zero dependencies.** `java.net.http.HttpClient` and a hand-written JSON
 * codec. An SDK that drags in Jackson drags in Jackson's version conflicts, and
 * "which Jackson does this pin?" is the most common reason a client library
 * cannot be added to an existing service at all.
 */
import { readFile } from "node:fs/promises";
import { camelCase, pascalCase, snakeCase, uniqueName } from "../../naming";
import { type CommentStyle, fileBanner, operationDocParts, wrap } from "../../emit";
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

const GROUP_ID = "com.infrawrench";
const ARTIFACT_ID = "infrawrench-sdk";
const PACKAGE_NAME = `${GROUP_ID}:${ARTIFACT_ID}`;

const ROOT_PACKAGE = "com.infrawrench.sdk";
const MODEL_PACKAGE = `${ROOT_PACKAGE}.models`;
const CLIENT_CLASS = "APIV1Client";

const SOURCE_ROOT = "src/main/java/com/infrawrench/sdk";
const MODEL_ROOT = `${SOURCE_ROOT}/models`;

/** Oldest LTS with records and `instanceof` patterns. */
const JAVA_RELEASE = "17";

/** Everything below this line in a `runtime/*.java.txt` file is emitted. */
const RUNTIME_SENTINEL = "// --8<--";

/**
 * Hand-written sources, each a complete compilation unit. They live as `.txt`
 * so that no javac invocation, IDE indexer or lint rule in this repository ever
 * treats the *package's* source as the *repository's* source. The tradeoff is
 * that nothing here compiles them, so `generate:sdk` for this target is only
 * really verified by running `javac` over the output.
 */
const RUNTIME_FILES = [
  "ApiConnectionException.java.txt",
  "ApiException.java.txt",
  "ApiTransport.java.txt",
  "ClientOptions.java.txt",
  "FileUpload.java.txt",
  "InfrawrenchException.java.txt",
  "Json.java.txt",
  "JsonException.java.txt",
  "JsonField.java.txt",
  "Multipart.java.txt",
  "RequestSpec.java.txt",
  "Types.java.txt",
  "Uris.java.txt",
] as const;

/** Type names the runtime already occupies in `com.infrawrench.sdk`. */
const RUNTIME_TYPES = [
  CLIENT_CLASS,
  "ApiConnectionException",
  "ApiException",
  "ApiTransport",
  "ClientOptions",
  "FileUpload",
  "InfrawrenchException",
  "Json",
  "JsonException",
  "JsonField",
  "Multipart",
  "RequestSpec",
  "Types",
  "Uris",
];

const JAVA_STYLE: CommentStyle = { line: "//", block: { open: "/*", prefix: " *", close: " */" } };

/** Reserved words. Illegal as any identifier, so a collision must be renamed. */
const JAVA_KEYWORDS = new Set(
  (
    "abstract assert boolean break byte case catch char class const continue default do double " +
    "else enum extends final finally float for goto if implements import instanceof int " +
    "interface long native new package private protected public return short static strictfp " +
    "super switch synchronized this throw throws transient try void volatile while _ " +
    "true false null"
  ).split(" "),
);

/**
 * Contextual keywords: legal as a method or field name, illegal as a type name,
 * so they only constrain the classes we declare.
 */
const RESTRICTED_TYPE_NAMES = new Set(["var", "yield", "record", "permits", "sealed"]);

/**
 * A record component may not be named after a no-argument `Object` method — the
 * generated accessor would try to override it and fail to compile.
 */
const OBJECT_METHODS = new Set([
  "clone",
  "equals",
  "finalize",
  "getClass",
  "hashCode",
  "notify",
  "notifyAll",
  "toString",
  "wait",
]);

/**
 * Names a model must not take. `java.lang` is auto-imported into every file, so
 * a model called `Error` sitting next to `throw new Error(…)` is a trap even
 * where it technically compiles — the TypeScript target renames it to
 * `ErrorModel` and this one does the same. `List`/`Map` are here because model
 * files import them, and the runtime names because namespace files import the
 * whole model package by wildcard.
 */
const RESERVED_MODEL_NAMES = new Set([
  ...RESTRICTED_TYPE_NAMES,
  ...RUNTIME_TYPES,
  "Appendable",
  "AutoCloseable",
  "Boolean",
  "Byte",
  "Character",
  "CharSequence",
  "Class",
  "ClassLoader",
  "Cloneable",
  "Collection",
  "Comparable",
  "Deprecated",
  "Double",
  "Enum",
  "Error",
  "Exception",
  "Float",
  "FunctionalInterface",
  "Integer",
  "Iterable",
  "Iterator",
  "List",
  "Long",
  "Map",
  "Math",
  "Module",
  "Number",
  "Object",
  "Optional",
  "Override",
  "Package",
  "Process",
  "Readable",
  "Record",
  "Runnable",
  "Runtime",
  "RuntimeException",
  "SafeVarargs",
  "Set",
  "Short",
  "StackTraceElement",
  "StrictMath",
  "String",
  "StringBuilder",
  "SuppressWarnings",
  "System",
  "Thread",
  "ThreadLocal",
  "Throwable",
  "Void",
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * A legal Java member name for a wire name.
 *
 * The trailing underscore is the whole trick: it is the one suffix that cannot
 * collide with another spec name (spec names never end in `_`), it survives
 * regeneration, and it reads as "this was a keyword" to anyone who has seen a
 * generated client before. `client.dashboards().default_()` is not pretty; it is
 * the price of a path segment called `default`.
 */
function safeMember(name: string): string {
  const base = IDENTIFIER.test(name) ? name : camelCase(name) || "value";
  return JAVA_KEYWORDS.has(base) || OBJECT_METHODS.has(base) ? `${base}_` : base;
}

/** `ssh-keys` → `SshKeys`, guaranteed to be a legal type name. */
function safeTypeName(name: string): string {
  const base = IDENTIFIER.test(name) ? name : pascalCase(name);
  const cleaned = base === "" ? "Type" : base;
  return JAVA_KEYWORDS.has(cleaned) || RESTRICTED_TYPE_NAMES.has(cleaned)
    ? `${cleaned}Model`
    : cleaned;
}

/** `us-east-1` → `US_EAST_1`, for a `public static final String`. */
function constantName(value: string): string {
  const base = snakeCase(value).toUpperCase();
  if (base === "") return "EMPTY";
  return /^[0-9]/.test(base) ? `V_${base}` : base;
}

// ---------------------------------------------------------------------------
// Javadoc
// ---------------------------------------------------------------------------

/**
 * Spec prose becomes Javadoc, and Javadoc is HTML. An unescaped `<` opens a tag
 * javadoc never closes and a line that happens to start with `@` becomes a block
 * tag; both are warnings today and errors under `-Xdoclint`.
 */
function escapeDoc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\//g, "*&#47;")
    .replace(/\{@/g, "{&#64;");
}

function renderDoc(lines: string[], indent: string): string {
  if (lines.length === 1) return `${indent}/** ${lines[0]} */`;
  return [
    `${indent}/**`,
    ...lines.map((line) => (line === "" ? `${indent} *` : `${indent} * ${line}`)),
    `${indent} */`,
  ].join("\n");
}

/**
 * A Javadoc block from spec prose plus zero or more `@`-tag lines. Returns
 * `null` when there is nothing to say, so callers can skip the comment entirely
 * rather than emit an empty one.
 */
function javadoc(blocks: Array<string | undefined>, tags: string[], indent: string): string | null {
  const prose = blocks.filter(
    (block): block is string => typeof block === "string" && block.trim() !== "",
  );
  if (prose.length === 0 && tags.length === 0) return null;
  const wrapped =
    prose.length === 0
      ? []
      : wrap(escapeDoc(prose.join("\n\n")), 96 - indent.length).map((line) =>
          line.startsWith("@") ? `&#64;${line.slice(1)}` : line,
        );
  const separator = wrapped.length > 0 && tags.length > 0 ? [""] : [];
  return renderDoc([...wrapped, ...separator, ...tags], indent);
}

/** Javadoc we wrote ourselves, so it must not be HTML-escaped. */
function rawJavadoc(lines: string[], indent: string): string {
  return renderDoc(lines, indent);
}

// ---------------------------------------------------------------------------
// The model space
// ---------------------------------------------------------------------------

interface ComponentModel {
  name: string;
  wireName: string;
  javaType: string;
  required: boolean;
  description?: string | undefined;
  deprecated: boolean;
  /** What a union collapsed away, for the doc comment. */
  unionNote?: string | undefined;
}

interface RecordModel {
  name: string;
  description?: string | undefined;
  /** Spec schema this came from, absent when synthesized from an inline shape. */
  specName?: string | undefined;
  components: ComponentModel[];
}

interface ConstantsModel {
  name: string;
  specName: string;
  description?: string | undefined;
  values: string[];
}

type Representation =
  { kind: "record"; name: string } | { kind: "constants"; name: string } | { kind: "alias" };

/**
 * Decides what each spec schema becomes in Java, and manufactures a named record
 * for every inline object along the way.
 *
 * Java has no structural types, so an anonymous `{ id: string }` nested three
 * levels into a response has to be given a name and a file. The name is built
 * from the path that reached it (`AccountDetail` + `.account` →
 * `AccountDetailAccount`), which stays stable across regenerations for as long
 * as the spec's property names do.
 */
class ModelSpace {
  private readonly schemas = new Map<string, SchemaDef>();
  private readonly representations = new Map<string, Representation>();
  private readonly aliases = new Map<string, string>();
  private readonly taken = new Set(RESERVED_MODEL_NAMES);
  /** Records whose components are not resolved yet. Drained iteratively. */
  private readonly pending: Array<{ model: RecordModel; properties: PropertyDef[] }> = [];

  readonly records: RecordModel[] = [];
  readonly constants: ConstantsModel[] = [];
  readonly renamed: Array<{ from: string; to: string }> = [];

  constructor(schemas: readonly SchemaDef[]) {
    for (const schema of schemas) this.schemas.set(schema.name, schema);

    // Three passes, so that a ref resolves to a name without recursing into the
    // referent's body: classify everything, assign names, then fill in.
    for (const schema of schemas) this.representations.set(schema.name, this.classify(schema));
    for (const schema of schemas) {
      const representation = this.representations.get(schema.name);
      if (representation === undefined || representation.kind === "alias") continue;
      const resolved = this.claim(representation.name);
      this.representations.set(schema.name, { ...representation, name: resolved });
      if (resolved !== schema.name) this.renamed.push({ from: schema.name, to: resolved });
    }
    for (const schema of schemas) {
      const representation = this.representations.get(schema.name);
      if (representation === undefined || representation.kind === "alias") continue;
      if (representation.kind === "constants") {
        this.constants.push({
          name: representation.name,
          specName: schema.name,
          description: schema.description,
          values: enumValues(schema.type) ?? [],
        });
      } else {
        this.enqueue(
          representation.name,
          schema.description,
          schema.name,
          flatten(schema.type, this.schemas) ?? [],
        );
      }
    }
    this.drain();
  }

  private claim(name: string): string {
    return uniqueName(this.taken.has(name) ? `${name}Model` : name, this.taken);
  }

  private classify(schema: SchemaDef): Representation {
    if (enumValues(schema.type) !== null) {
      return { kind: "constants", name: safeTypeName(schema.name) };
    }
    const properties = flatten(schema.type, this.schemas);
    if (properties !== null && properties.length > 0) {
      return { kind: "record", name: safeTypeName(schema.name) };
    }
    // Everything else — a bare string, a free-form object, a union of scalars —
    // is spelled inline at its use sites. Java has no type aliases, and a record
    // wrapping a single `String` would be a worse model than the `String`.
    return { kind: "alias" };
  }

  private enqueue(
    name: string,
    description: string | undefined,
    specName: string | undefined,
    properties: PropertyDef[],
  ): void {
    const model: RecordModel = { name, description, specName, components: [] };
    this.records.push(model);
    this.pending.push({ model, properties });
  }

  /**
   * Resolve queued records to completion. Iterative rather than recursive
   * because resolving one record's components can enqueue more (an inline
   * object inside an inline object), and a self-referential schema would
   * otherwise recurse forever.
   *
   * Must be called again after the operations are printed: an inline request or
   * response body is only discovered then, and a record left in the queue would
   * be emitted with no components at all.
   */
  drain(): void {
    for (let next = this.pending.shift(); next !== undefined; next = this.pending.shift()) {
      const used = new Set<string>();
      const model = next.model;
      model.components = next.properties.map((property) => ({
        name: uniqueName(safeMember(property.name), used),
        wireName: property.name,
        javaType: this.javaType(property.type, `${model.name}${pascalCase(property.name)}`),
        required: property.required,
        description: property.description,
        deprecated: property.deprecated === true,
        unionNote: unionNote(property.type, this.schemas),
      }));
    }
  }

  /** Declare a record for a shape the spec left anonymous. */
  private synthesize(hint: string, properties: PropertyDef[]): string {
    const name = this.claim(safeTypeName(hint));
    this.enqueue(name, undefined, undefined, properties);
    return name;
  }

  /**
   * The Java type for one `TypeRef`. `hint` names any record this has to
   * manufacture on the way.
   */
  javaType(ref: TypeRef, hint: string): string {
    switch (ref.kind) {
      case "ref":
        return this.refType(ref.name, hint);
      case "string":
        return "String";
      case "number":
        // Boxed, always: every one of these fields can be absent in at least one
        // direction, and a primitive cannot say "absent".
        return ref.integer ? "Long" : "Double";
      case "boolean":
        return "Boolean";
      case "binary":
        return "FileUpload";
      case "null":
      case "unknown":
        return "Object";
      case "array":
        return `List<${this.javaType(ref.items, `${hint}Item`)}>`;
      case "object":
        return this.objectType(ref, hint);
      case "union": {
        // `T | null` is just `T`: every type this target prints is a reference
        // type, so nullability is already expressible and needs no encoding.
        const members = ref.members.filter((member) => member.kind !== "null");
        return members.length === 1 ? this.javaType(members[0]!, hint) : "Object";
      }
      case "intersection": {
        const properties = flatten(ref, this.schemas);
        return properties !== null && properties.length > 0
          ? this.synthesize(hint, properties)
          : "Object";
      }
    }
  }

  private objectType(ref: Extract<TypeRef, { kind: "object" }>, hint: string): string {
    if (ref.properties.length > 0) return this.synthesize(hint, ref.properties);
    // No declared properties: this is a bag, and a record with no components
    // would model it worse than the map it actually is.
    const value = ref.additional ? this.javaType(ref.additional, `${hint}Value`) : "Object";
    return `Map<String, ${value}>`;
  }

  private refType(specName: string, hint: string): string {
    const representation = this.representations.get(specName);
    if (representation === undefined) return "Object";
    if (representation.kind === "record") return representation.name;
    // An enum schema is a `String` at every use site; the constants class only
    // exists so the allowed values stay discoverable.
    if (representation.kind === "constants") return "String";

    const cached = this.aliases.get(specName);
    if (cached !== undefined) return cached;
    // Seed before recursing, so a schema that reaches itself through an alias
    // bottoms out instead of looping.
    this.aliases.set(specName, "Object");
    const schema = this.schemas.get(specName);
    const resolved = schema === undefined ? "Object" : this.javaType(schema.type, hint);
    this.aliases.set(specName, resolved);
    return resolved;
  }
}

/** The string values of an enum-only schema, or `null` if it isn't one. */
function enumValues(ref: TypeRef): string[] | null {
  if (ref.kind === "string" && ref.enum !== undefined && ref.enum.length > 0) return ref.enum;
  return null;
}

/**
 * Reduce a `TypeRef` to the property list of an object, or `null` when it isn't
 * one.
 *
 * This is where `allOf` stops existing. Java records cannot extend anything, so
 * `Role = RoleSummary & { permissions }` becomes a record carrying both sets of
 * components rather than a subtype. The duplication is real; it is still better
 * than modelling composition with interfaces that the reflective JSON layer
 * would then have to reconstruct.
 */
function flatten(
  ref: TypeRef,
  schemas: Map<string, SchemaDef>,
  visited: Set<string> = new Set(),
): PropertyDef[] | null {
  switch (ref.kind) {
    case "object":
      return ref.properties;
    case "ref": {
      if (visited.has(ref.name)) return null;
      visited.add(ref.name);
      const schema = schemas.get(ref.name);
      return schema === undefined ? null : flatten(schema.type, schemas, visited);
    }
    case "union": {
      const members = ref.members.filter((member) => member.kind !== "null");
      return members.length === 1 ? flatten(members[0]!, schemas, visited) : null;
    }
    case "intersection": {
      const merged: PropertyDef[] = [];
      const seen = new Set<string>();
      for (const member of ref.members) {
        for (const property of flatten(member, schemas, visited) ?? []) {
          if (seen.has(property.name)) continue;
          seen.add(property.name);
          merged.push(property);
        }
      }
      return merged.length > 0 ? merged : null;
    }
    default:
      return null;
  }
}

/**
 * A one-line description of what a union collapsed to `Object` used to be, so
 * the loss shows up in the Javadoc rather than only in the diff of this file.
 */
function unionNote(ref: TypeRef, schemas: Map<string, SchemaDef>): string | undefined {
  if (ref.kind !== "union") return undefined;
  const members = ref.members.filter((member) => member.kind !== "null");
  if (members.length < 2) return undefined;
  const describe = (member: TypeRef): string => {
    switch (member.kind) {
      case "ref":
        return schemas.has(member.name) ? member.name : "object";
      case "number":
        return member.integer ? "integer" : "number";
      default:
        return member.kind;
    }
  };
  return `JSON union, typed as Object: one of ${members.map(describe).join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Type tokens
// ---------------------------------------------------------------------------

/**
 * An expression producing the `java.lang.reflect.Type` for a rendered Java type.
 *
 * Driven off the printed string rather than off the `TypeRef` on purpose:
 * printing is what decided which records exist, and re-walking the `TypeRef`
 * would manufacture a duplicate of every inline model.
 */
function typeToken(java: string): string {
  if (java.startsWith("List<")) return `Types.list(${typeToken(java.slice(5, -1))})`;
  if (java.startsWith("Map<String, ")) return `Types.map(${typeToken(java.slice(12, -1))})`;
  return `${java}.class`;
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

/** The `java.util` imports a body needs, plus whatever else the caller names. */
function importsFor(body: string, extra: string[]): string[] {
  const imports = [...extra];
  if (/\bList</.test(body)) imports.push("java.util.List");
  if (/\bMap</.test(body)) imports.push("java.util.Map");
  return [...new Set(imports)].sort();
}

function compilationUnit(ir: SdkIr, packageName: string, imports: string[], body: string): string {
  const header = [`package ${packageName};`];
  if (imports.length > 0) header.push("", ...imports.map((name) => `import ${name};`));
  return `${fileBanner(ir, JAVA_STYLE, PACKAGE_NAME)}${header.join("\n")}\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function emitRecord(ir: SdkIr, model: RecordModel): string {
  const tags = model.components.map((component) => {
    const prose = [component.description, component.unionNote].filter(Boolean).join(" ");
    const renamed = component.wireName === component.name ? "" : ` Sent as ${component.wireName}.`;
    return `@param ${component.name} ${escapeDoc(prose + renamed).trim() || "&#8212;"}`;
  });
  const doc = javadoc(
    [
      model.description,
      model.specName !== undefined && model.specName !== model.name
        ? `Spec schema: ${model.specName}.`
        : undefined,
    ],
    tags,
    "",
  );

  const components = model.components.map((component) => {
    // The annotation appears only where it changes behaviour: a renamed key, or
    // a required field that has to be sent as an explicit null rather than
    // omitted. Everything else is inferable from the component itself.
    const annotations: string[] = [];
    if (component.wireName !== component.name) annotations.push(`name = "${component.wireName}"`);
    if (component.required) annotations.push("required = true");
    const annotation = annotations.length > 0 ? `@JsonField(${annotations.join(", ")}) ` : "";
    const deprecated = component.deprecated ? "@Deprecated " : "";
    return `    ${deprecated}${annotation}${component.javaType} ${component.name}`;
  });

  const lines: string[] = [];
  if (doc) lines.push(doc);
  lines.push(`public record ${model.name}(`, components.join(",\n"), "    ) {", "");
  lines.push(...emitBuilder(model));
  lines.push("}");

  const body = lines.join("\n");
  const extra: string[] = [];
  if (body.includes("@JsonField(")) extra.push(`${ROOT_PACKAGE}.JsonField`);
  if (/\bFileUpload\b/.test(body)) extra.push(`${ROOT_PACKAGE}.FileUpload`);
  return compilationUnit(ir, MODEL_PACKAGE, importsFor(body, extra), body);
}

/**
 * Records are positional, and the widest schema here has 36 components, which
 * makes the canonical constructor unusable by hand — nobody can read
 * `new Resource(a, b, null, null, c, …)`, let alone review a change to it. Every
 * record therefore gets a builder, plus `toBuilder()` so an existing value can
 * be varied by one field without respelling the rest.
 */
function emitBuilder(model: RecordModel): string[] {
  const lines: string[] = [
    "  /** A fresh builder. Unset components stay null, which serializes as absent. */",
    "  public static Builder builder() {",
    "    return new Builder();",
    "  }",
    "",
    "  /** This value's components, ready to be varied. */",
    "  public Builder toBuilder() {",
    "    Builder builder = new Builder();",
  ];
  for (const component of model.components) {
    lines.push(`    builder.${component.name} = this.${component.name};`);
  }
  lines.push("    return builder;", "  }", "");
  lines.push(`  /** Mutable accumulator for {@link ${model.name}}. Not thread-safe. */`);
  lines.push("  public static final class Builder {", "");
  for (const component of model.components) {
    lines.push(`    private ${component.javaType} ${component.name};`);
  }
  lines.push("", "    Builder() {}");
  for (const component of model.components) {
    lines.push(
      "",
      `    public Builder ${component.name}(${component.javaType} value) {`,
      `      this.${component.name} = value;`,
      "      return this;",
      "    }",
    );
  }
  lines.push(
    "",
    `    public ${model.name} build() {`,
    `      return new ${model.name}(${model.components.map((component) => component.name).join(", ")});`,
    "    }",
    "  }",
  );
  return lines;
}

/**
 * An enum schema becomes a holder of `String` constants, not a Java `enum`.
 *
 * `ResourceTypeId` has 280-odd values and gains more every time a plugin learns
 * a new resource. With a real enum, a server returning a value this SDK predates
 * turns every `resources().list()` into a decode failure — a released client
 * would break on a server-side addition it does not even care about. String
 * constants keep the discoverability (`ResourceTypeId.EC2_INSTANCE` still
 * autocompletes) and cost only the compile-time exhaustiveness that an open,
 * server-driven value set never really offered.
 */
function emitConstants(ir: SdkIr, model: ConstantsModel): string {
  const used = new Set<string>();
  const lines: string[] = [];
  const doc = javadoc(
    [
      model.description,
      `Allowed values for ${model.specName}. The API may add more, so treat an unrecognized ` +
        "value as data rather than as an error.",
    ],
    [],
    "",
  );
  if (doc) lines.push(doc);
  lines.push(`public final class ${model.name} {`, "");
  for (const value of model.values) {
    lines.push(
      `  public static final String ${uniqueName(constantName(value), used)} = ${JSON.stringify(value)};`,
    );
  }
  lines.push(
    "",
    "  /** Every value the spec declares, in spec order. */",
    "  public static final List<String> VALUES = List.of(",
    `      ${model.values.map((value) => JSON.stringify(value)).join(", ")});`,
    "",
    `  private ${model.name}() {}`,
    "}",
  );
  const body = lines.join("\n");
  return compilationUnit(ir, MODEL_PACKAGE, importsFor(body, []), body);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface JavaParam {
  name: string;
  javaType: string;
  doc: string;
  defaultable: boolean;
}

/** Base name for any record an operation's inline body or response needs. */
function operationHint(op: OperationDef): string {
  return `${pascalCase(op.namespace.join("-"))}${pascalCase(op.name)}`;
}

/**
 * Spec parameters in the order a human would want to type them: the
 * client-scoped id first (it is the one you usually pass null for), then what
 * the endpoint requires, then what it merely accepts.
 */
function orderedParameters(op: OperationDef): ParameterDef[] {
  return [
    ...op.parameters.filter((param) => param.defaultable),
    ...op.parameters.filter((param) => !param.defaultable && param.required),
    ...op.parameters.filter((param) => !param.defaultable && !param.required),
  ];
}

function parameterDoc(param: ParameterDef, scopeParam: string | null): string {
  const base = param.description ? `${param.description.replace(/\.$/, "")}. ` : "";
  if (param.defaultable) {
    return `${base}Pass null to use the ${scopeParam ?? "default"} the client was built with.`;
  }
  if (!param.required) return `${base}Optional; null omits it.`;
  return param.description ?? "";
}

function operationParams(
  op: OperationDef,
  models: ModelSpace,
  scopeParam: string | null,
): JavaParam[] {
  const used = new Set<string>();
  const params: JavaParam[] = orderedParameters(op).map((param) => ({
    name: uniqueName(safeMember(param.name), used),
    javaType: models.javaType(param.type, `${operationHint(op)}${pascalCase(param.name)}`),
    doc: parameterDoc(param, scopeParam),
    defaultable: param.defaultable,
  }));
  if (op.body) {
    params.push({
      name: uniqueName("body", used),
      javaType: models.javaType(op.body.type, `${operationHint(op)}Request`),
      doc:
        op.body.encoding === "multipart"
          ? "Sent as multipart/form-data."
          : op.body.required
            ? "Request body."
            : "Request body. Optional; null omits it.",
      defaultable: false,
    });
  }
  return params;
}

function returnType(op: OperationDef, models: ModelSpace): string {
  switch (op.response.encoding) {
    case "binary":
      return "byte[]";
    case "empty":
      return "void";
    case "json":
      return op.response.type
        ? models.javaType(op.response.type, `${operationHint(op)}Response`)
        : "Object";
  }
}

function emitOperation(
  op: OperationDef,
  models: ModelSpace,
  scopeParam: string | null,
  indent: string,
): string[] {
  const params = operationParams(op, models, scopeParam);
  const ordered = orderedParameters(op);
  const result = returnType(op, models);
  const name = safeMember(op.name);
  const javaName = (param: ParameterDef): string => params[ordered.indexOf(param)]!.name;

  const tags = params.map((param) => `@param ${param.name} ${escapeDoc(param.doc) || "&#8212;"}`);
  if (result !== "void") {
    tags.push(`@return ${escapeDoc(op.response.description ?? "The response body.")}`);
  }
  tags.push("@throws ApiException on any non-2xx response.");

  const lines: string[] = [];
  const doc = javadoc(operationDocParts(op), tags, indent);
  if (doc) lines.push(doc);
  if (op.deprecated) lines.push(`${indent}@Deprecated`);
  lines.push(
    `${indent}public ${result} ${name}(${params.map((param) => `${param.javaType} ${param.name}`).join(", ")}) {`,
  );

  const chain = [
    `new RequestSpec(${JSON.stringify(op.method.toUpperCase())}, ${JSON.stringify(op.path)})`,
  ];
  for (const param of op.parameters) {
    const setter = param.in === "path" ? "path" : "query";
    chain.push(`.${setter}(${JSON.stringify(param.name)}, ${javaName(param)})`);
  }
  if (op.body) {
    const bodyParam = params[params.length - 1]!.name;
    chain.push(
      op.body.encoding === "multipart" ? `.multipart(${bodyParam})` : `.json(${bodyParam})`,
    );
  }
  lines.push(`${indent}  RequestSpec spec = ${chain[0]!}`);
  for (const link of chain.slice(1)) lines.push(`${indent}      ${link}`);
  lines[lines.length - 1] += ";";

  if (result === "void") lines.push(`${indent}  transport.execute(spec);`);
  else if (result === "byte[]") lines.push(`${indent}  return transport.bytes(spec);`);
  else lines.push(`${indent}  return transport.request(spec, ${typeToken(result)});`);
  lines.push(`${indent}}`);

  // The convenience overload: exactly one parameter shorter than the full form.
  // That difference in arity is what keeps the pair unambiguous whatever the
  // spec's types are — two same-arity overloads can erase to one signature, and
  // would then stop compiling the moment a parameter changed type.
  const defaultable = params.find((param) => param.defaultable);
  if (defaultable !== undefined) {
    const rest = params.filter((param) => param !== defaultable);
    const call = [`(${defaultable.javaType}) null`, ...rest.map((param) => param.name)].join(", ");
    lines.push("");
    lines.push(
      rawJavadoc(
        [
          `Same as {@link #${name}(${params.map((param) => param.javaType).join(", ")})}, using`,
          `the ${scopeParam ?? "scope"} the client was built with.`,
        ],
        indent,
      ),
    );
    if (op.deprecated) lines.push(`${indent}@Deprecated`);
    lines.push(
      `${indent}public ${result} ${name}(${rest.map((param) => `${param.javaType} ${param.name}`).join(", ")}) {`,
      `${indent}  ${result === "void" ? "" : "return "}${name}(${call});`,
      `${indent}}`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/** Java class name for a namespace path. `[]` is the client itself. */
function namespaceClass(path: string[]): string {
  return path.length === 0 ? CLIENT_CLASS : `${path.map(pascalCase).join("")}Namespace`;
}

/** `client.resources().secretVersions()` — how a path reads at a call site. */
function dottedPath(path: string[]): string {
  return ["client", ...path.map((segment) => `${safeMember(segment)}()`)].join(".");
}

/**
 * Namespaces are reached through accessor methods (`client.accounts()`) rather
 * than public final fields (`client.accounts`).
 *
 * Fields would read marginally better and cost one less pair of parens per
 * segment. Methods win anyway: a public field is a permanent commitment to a
 * concrete type in a way a method is not, mocking and delegation both need
 * methods, and every other Java client a consumer has used spells navigation
 * this way. The dotted shape the SDK promises survives either way —
 * `client.resources().secretVersions().add(…)`.
 */
function emitAccessors(children: Array<[string, NamespaceDef]>): string[] {
  const lines: string[] = [];
  for (const [key, child] of children) {
    const member = safeMember(key);
    lines.push("");
    lines.push(rawJavadoc([`Calls under {@code ${dottedPath(child.path)}}.`], "  "));
    lines.push(
      `  public ${namespaceClass(child.path)} ${member}() {`,
      `    return ${member};`,
      "  }",
    );
  }
  return lines;
}

function emitNamespace(
  ir: SdkIr,
  node: NamespaceDef,
  models: ModelSpace,
  scopeParam: string | null,
): string {
  const className = namespaceClass(node.path);
  const children = [...node.children.entries()];
  const lines: string[] = [];

  lines.push(
    rawJavadoc(
      [
        `Calls under {@code ${dottedPath(node.path)}}.`,
        "",
        "<p>Obtained from the client, never constructed directly.",
      ],
      "",
    ),
  );
  lines.push(`public final class ${className} {`, "");
  lines.push("  private final ApiTransport transport;");
  for (const [key, child] of children) {
    lines.push(`  private final ${namespaceClass(child.path)} ${safeMember(key)};`);
  }
  lines.push("", `  ${className}(ApiTransport transport) {`, "    this.transport = transport;");
  for (const [key, child] of children) {
    lines.push(`    this.${safeMember(key)} = new ${namespaceClass(child.path)}(transport);`);
  }
  lines.push("  }");
  lines.push(...emitAccessors(children));
  for (const op of node.operations) {
    lines.push("");
    lines.push(...emitOperation(op, models, scopeParam, "  "));
  }
  lines.push("}");

  const body = lines.join("\n");
  return compilationUnit(ir, ROOT_PACKAGE, importsFor(body, [`${MODEL_PACKAGE}.*`]), body);
}

function emitClient(ir: SdkIr, models: ModelSpace, scopeParam: string | null): string {
  const children = [...ir.root.children.entries()];
  const scopeMember = scopeParam === null ? null : safeMember(camelCase(scopeParam));
  const example = ir.operations.find((op) => op.namespace[0] === "accounts" && op.name === "list");
  const exampleCall = example
    ? `${dottedPath(example.namespace)}.${safeMember(example.name)}()`
    : "client";

  const lines: string[] = [];
  lines.push(
    rawJavadoc(
      [
        `A client for the ${escapeDoc(ir.title)}.`,
        "",
        "<pre>{@code",
        `${CLIENT_CLASS} client = ${CLIENT_CLASS}.builder()`,
        '    .apiKey(System.getenv("INFRAWRENCH_API_KEY"))',
        ...(scopeMember === null
          ? []
          : [`    .${scopeMember}(System.getenv("INFRAWRENCH_ORG_ID"))`]),
        "    .build();",
        "",
        `var accounts = ${exampleCall};`,
        "}</pre>",
        "",
        "<p>Thread-safe. Build one and share it — each instance owns an",
        "{@link java.net.http.HttpClient}, and therefore a connection pool.",
      ],
      "",
    ),
  );
  lines.push(`public final class ${CLIENT_CLASS} {`, "");
  lines.push("  private final ApiTransport transport;");
  for (const [key, child] of children) {
    lines.push(`  private final ${namespaceClass(child.path)} ${safeMember(key)};`);
  }
  lines.push(
    "",
    "  /** Prefer {@link #builder()}; this is for callers assembling options elsewhere. */",
    `  public ${CLIENT_CLASS}(ClientOptions options) {`,
    "    this.transport = new ApiTransport(options);",
  );
  for (const [key, child] of children) {
    lines.push(`    this.${safeMember(key)} = new ${namespaceClass(child.path)}(transport);`);
  }
  lines.push("  }", "");
  lines.push(
    "  public static Builder builder() {",
    "    return new Builder();",
    "  }",
    "",
    "  /** Shared request plumbing. Reach for this only to inspect the resolved base URL. */",
    "  public ApiTransport transport() {",
    "    return transport;",
    "  }",
  );
  lines.push(...emitAccessors(children));
  for (const op of ir.root.operations) {
    lines.push("");
    lines.push(...emitOperation(op, models, scopeParam, "  "));
  }
  lines.push("", ...emitClientBuilder(ir, scopeMember, scopeParam));
  lines.push("}");

  const body = lines.join("\n");
  const extra = [`${MODEL_PACKAGE}.*`, "java.net.http.HttpClient", "java.time.Duration"];
  return compilationUnit(ir, ROOT_PACKAGE, importsFor(body, extra), body);
}

/**
 * The client's builder wraps `ClientOptions.Builder` rather than replacing it.
 * That is what lets the runtime stay free of anything the spec could rename:
 * `ClientOptions` knows only "the client-scoped path parameter", and this is the
 * one place it acquires the name `orgId`.
 */
function emitClientBuilder(
  ir: SdkIr,
  scopeMember: string | null,
  scopeParam: string | null,
): string[] {
  const lines: string[] = [
    `  /** Fluent configuration for {@link ${CLIENT_CLASS}}. Not thread-safe. */`,
    "  public static final class Builder {",
    "",
    "    private final ClientOptions.Builder options = ClientOptions.builder();",
    "",
    "    private Builder() {}",
    "",
    `    /** Base URL of the deployment. Defaults to {@code ${ir.baseUrl}}. */`,
    "    public Builder baseUrl(String value) {",
    "      options.baseUrl(value);",
    "      return this;",
    "    }",
    "",
    "    /** API key or access token, sent as {@code Authorization: Bearer …}. */",
    "    public Builder apiKey(String value) {",
    "      options.apiKey(value);",
    "      return this;",
    "    }",
  ];
  if (scopeMember !== null) {
    lines.push(
      "",
      "    /**",
      `     * Default {@code ${scopeParam}}. Every scoped call accepts one; set it here once and`,
      "     * the short overloads can leave it off.",
      "     */",
      `    public Builder ${scopeMember}(String value) {`,
      "      options.defaultPathParam(value);",
      "      return this;",
      "    }",
    );
  }
  lines.push(
    "",
    "    /** A header merged into every request. */",
    "    public Builder header(String name, String value) {",
    "      options.header(name, value);",
    "      return this;",
    "    }",
    "",
    "    /** Connect and per-request timeout. None by default. */",
    "    public Builder timeout(Duration value) {",
    "      options.timeout(value);",
    "      return this;",
    "    }",
    "",
    "    /** Supply the {@link HttpClient} — for a proxy, a custom SSLContext, or a shared pool. */",
    "    public Builder httpClient(HttpClient value) {",
    "      options.httpClient(value);",
    "      return this;",
    "    }",
    "",
    `    public ${CLIENT_CLASS} build() {`,
    `      return new ${CLIENT_CLASS}(options.build());`,
    "    }",
    "  }",
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Package files
// ---------------------------------------------------------------------------

/**
 * XML comments may not contain `--` anywhere, which rules out writing the
 * regenerate command (`pnpm --filter …`) inside one — Maven refuses to parse the
 * POM at all, so the failure is total rather than cosmetic. Everything that goes
 * into a comment goes through here.
 */
function xmlComment(lines: string[], indent = ""): string {
  const safe = lines.map((line) => line.replace(/-{2,}/g, "—"));
  return [
    `${indent}<!--`,
    ...safe.map((line) => (line === "" ? "" : `${indent}  ${line}`)),
    `${indent}-->`,
  ].join("\n");
}

function pom(ir: SdkIr): string {
  const developers = [AUTHOR, ...CONTRIBUTORS]
    .map((person) =>
      [
        "    <developer>",
        `      <name>${person.name}</name>`,
        `      <email>${person.email}</email>`,
        "    </developer>",
      ].join("\n"),
    )
    .join("\n");

  const banner = xmlComment([
    `${PACKAGE_NAME} v${ir.apiVersion} | ${LICENSE} | ${COPYRIGHT_NOTICE}`,
    REPOSITORY_URL,
    "",
    "DO NOT EDIT. Regenerate with the generate:sdk script in",
    "app/packages/web of the Infrawrench repository.",
  ]);
  const noDependencies = xmlComment(
    [
      "There is no <dependencies> element, and that is the point: the client is",
      "built on java.net.http.HttpClient and a hand-written JSON codec, so adding",
      "it to a build cannot conflict with anything already there.",
    ],
    "  ",
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
${banner}
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <groupId>${GROUP_ID}</groupId>
  <artifactId>${ARTIFACT_ID}</artifactId>
  <version>${ir.apiVersion}</version>
  <packaging>jar</packaging>

  <name>${ARTIFACT_ID}</name>
  <description>Generated Java client for the ${ir.title} (v${ir.apiVersion}).</description>
  <url>${HOMEPAGE}</url>
  <inceptionYear>2026</inceptionYear>

  <licenses>
    <license>
      <name>${LICENSE} License</name>
      <url>https://opensource.org/licenses/MIT</url>
      <distribution>repo</distribution>
      <comments>The generated client is ${LICENSE}; the service it talks to is BUSL-1.1.</comments>
    </license>
  </licenses>

  <organization>
    <name>${AUTHOR.name}</name>
    <url>${AUTHOR.url}</url>
  </organization>

  <developers>
${developers}
  </developers>

  <scm>
    <url>${REPOSITORY_URL}</url>
    <connection>scm:git:${REPOSITORY_URL}.git</connection>
    <developerConnection>scm:git:${REPOSITORY_URL}.git</developerConnection>
  </scm>

  <issueManagement>
    <system>GitHub</system>
    <url>${ISSUES_URL}</url>
  </issueManagement>

  <properties>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <maven.compiler.release>${JAVA_RELEASE}</maven.compiler.release>
    <sdk.keywords>${KEYWORDS.join(",")}</sdk.keywords>
  </properties>

${noDependencies}

  <!--
    Release-only. The default build stays a plain compile so anyone can consume
    the sources without a signing key; Maven Central additionally demands a
    sources jar, a javadoc jar and a detached GPG signature for every artifact,
    and none of those belong in a local build. CI activates this with
    "mvn -Prelease deploy".

    Maven Central is the one registry in this pipeline with no OIDC trusted
    publishing, so the "central" credentials come from repository secrets via
    the settings.xml that actions/setup-java writes.
  -->
  <profiles>
    <profile>
      <id>release</id>
      <build>
        <plugins>
          <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-source-plugin</artifactId>
            <version>3.3.1</version>
            <executions>
              <execution>
                <id>attach-sources</id>
                <goals><goal>jar-no-fork</goal></goals>
              </execution>
            </executions>
          </plugin>
          <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-javadoc-plugin</artifactId>
            <version>3.11.2</version>
            <executions>
              <execution>
                <id>attach-javadocs</id>
                <goals><goal>jar</goal></goals>
              </execution>
            </executions>
            <configuration>
              <!-- The spec does not describe every field, and a missing-comment
                   warning must not fail a release. -->
              <doclint>all,-missing</doclint>
            </configuration>
          </plugin>
          <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-gpg-plugin</artifactId>
            <version>3.2.7</version>
            <executions>
              <execution>
                <id>sign-artifacts</id>
                <phase>verify</phase>
                <goals><goal>sign</goal></goals>
              </execution>
            </executions>
            <configuration>
              <!-- No TTY on a runner: the passphrase arrives as an env var. -->
              <gpgArguments>
                <arg>--pinentry-mode</arg>
                <arg>loopback</arg>
              </gpgArguments>
            </configuration>
          </plugin>
          <plugin>
            <groupId>org.sonatype.central</groupId>
            <artifactId>central-publishing-maven-plugin</artifactId>
            <!--
              Keep this current with the Central API. 0.7.0 uploaded fine and
              then threw UnrecognizedPropertyException on a "warnings" field the
              server had started returning, so a successful publish was reported
              as a build failure.
            -->
            <version>0.11.0</version>
            <extensions>true</extensions>
            <configuration>
              <publishingServerId>central</publishingServerId>
              <autoPublish>true</autoPublish>
              <waitUntil>published</waitUntil>
            </configuration>
          </plugin>
        </plugins>
      </build>
    </profile>
  </profiles>
</project>
`;
}

function readme(ir: SdkIr, scopeParam: string | null): string {
  const scopeMember = scopeParam === null ? "orgId" : safeMember(camelCase(scopeParam));
  const example = ir.operations.find((op) => op.namespace[0] === "accounts" && op.name === "list");
  const call = example
    ? `${dottedPath(example.namespace)}.${safeMember(example.name)}()`
    : "client";

  return `# ${PACKAGE_NAME}

Generated Java client for the ${ir.title} (API version \`${ir.apiVersion}\`).

**Do not edit this package by hand** — it is regenerated from \`openapi.json\` and
is not checked into the repository. Run
\`pnpm --filter @infrawrench/web generate:sdk\` to rebuild it; the generator lives
in [\`${GENERATOR_PATH}\`](${REPOSITORY_URL}/tree/main/${GENERATOR_PATH}).

## Install

\`\`\`xml
<dependency>
  <groupId>${GROUP_ID}</groupId>
  <artifactId>${ARTIFACT_ID}</artifactId>
  <version>${ir.apiVersion}</version>
</dependency>
\`\`\`

Requires Java ${JAVA_RELEASE}+. **No dependencies** — the client is built on
\`java.net.http.HttpClient\` and its own JSON codec, so it cannot conflict with
whatever your service already pins.

## Usage

\`\`\`java
import com.infrawrench.sdk.${CLIENT_CLASS};
import com.infrawrench.sdk.ApiException;

${CLIENT_CLASS} client = ${CLIENT_CLASS}.builder()
    .apiKey(System.getenv("INFRAWRENCH_API_KEY"))
    .${scopeMember}(System.getenv("INFRAWRENCH_ORG_ID"))
    .build();

try {
  var accounts = ${call};
} catch (ApiException e) {
  System.err.println(e.statusCode() + " " + e.code() + " " + e.body());
}
\`\`\`

Calls are namespaced to mirror the URL structure, so
\`POST /api/org/{${scopeMember}}/accounts/{id}/sync\` is \`client.accounts().sync(id)\`.
Namespaces are accessor methods rather than public fields, so navigation always
carries parentheses: \`client.resources().secretVersions().add(…)\`.

### The ${scopeMember}

Set \`${scopeMember}\` once on the builder and every scoped call can leave it off:
each such operation has two overloads, one taking the \`${scopeMember}\` first and
one without it. Pass it explicitly to override the client default for a single
call. If neither is supplied the call throws \`IllegalArgumentException\` naming
the parameter.

### Nulls

There are no optional-parameter overloads beyond that pair, because two
overloads of the same arity can erase to the same signature and stop compiling
the moment the spec changes a type. **Pass \`null\` for any optional parameter**
and it is left out of the request entirely.

### Models

Every object schema is a \`record\`, with a builder for the wide ones:

\`\`\`java
var dashboard = DashboardWidget.builder()
    .kind(DashboardWidgetKind.COST_GRAPH)
    .build();
\`\`\`

Records are value types, so \`equals\`, \`hashCode\` and \`toString\` behave. Fields
with a fixed value set are typed \`String\`, with the values exposed as constants
(\`ResourceTypeId.EC2_INSTANCE\`) — the API gains values faster than a released
SDK can, and a closed Java \`enum\` would turn a new resource type into a decode
failure on an old client.

Unions the JVM cannot express (\`string | number\`) are typed \`Object\`; the
Javadoc on the component says what it can actually be.

### Errors

Non-2xx throws \`ApiException\`, carrying \`statusCode()\`, the parsed \`body()\`,
the untouched \`rawBody()\`, and \`code()\` — the machine-readable discriminator the
API sends (e.g. \`reauthentication_required\`). Branch on \`code()\`, not on the
message. Transport failures throw \`ApiConnectionException\`, and a response that
does not match the spec throws \`JsonException\`. All three extend
\`InfrawrenchException\`, and all are unchecked.

### Uploads

Multipart endpoints take a \`FileUpload\`:

\`\`\`java
client.storage().upload(StorageUploadForm.builder()
    .accountId(accountId)
    .bucket("my-bucket")
    .key("report.pdf")
    .file(FileUpload.ofPath(Path.of("report.pdf")))
    .build());
\`\`\`

## Not included

Per-call request options (headers, timeout, cancellation) are configured on the
client rather than per call: a trailing options argument on every method would
double the overload count and reintroduce exactly the ambiguity the two-overload
rule avoids. Build a second client — or use \`ClientOptions.toBuilder()\` — when
one call needs different settings.

This package also covers the published API surface only. Operations marked
\`x-internal\` in the spec — the admin surface, webhook receivers, desktop sync,
push registration, and the browser auth redirects — are not generated.

## License

${LICENSE} — see [\`LICENSE\`](./LICENSE). ${COPYRIGHT_NOTICE}.

Note that this client is more permissively licensed than the service it talks
to: the Infrawrench source is BUSL-1.1, but the generated clients are ${LICENSE} so you
can link one into your own software without inheriting those terms.

Issues: <${ISSUES_URL}>
`;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** Read one hand-written source, drop its preamble, substitute the spec values. */
async function loadRuntime(ir: SdkIr, fileName: string): Promise<string> {
  const source = await readFile(new URL(`./runtime/${fileName}`, import.meta.url), "utf8");
  const start = source.indexOf(RUNTIME_SENTINEL);
  if (start === -1) {
    throw new Error(`runtime/${fileName} is missing its "${RUNTIME_SENTINEL}" sentinel line`);
  }
  const newline = source.indexOf("\n", start);
  return `${source
    .slice(newline + 1)
    .replace('"@@BASE_URL@@"', JSON.stringify(ir.baseUrl))
    .replace('"@@SCOPE_PARAM@@"', JSON.stringify(ir.defaultablePathParam))
    .trim()}\n`;
}

// ---------------------------------------------------------------------------

export const javaTarget: SdkTarget = {
  id: "java",
  displayName: "Java",
  packageName: PACKAGE_NAME,
  artifacts: [
    "pom.xml",
    "README.md",
    "LICENSE",
    `${SOURCE_ROOT}/${CLIENT_CLASS}.java`,
    `${SOURCE_ROOT}/ApiTransport.java`,
    `${SOURCE_ROOT}/Json.java`,
  ],

  async generate(ir: SdkIr, ctx: TargetContext): Promise<void> {
    const models = new ModelSpace(ir.schemas);
    const scopeParam = ir.defaultablePathParam;

    // Namespaces are rendered before any model is written: emitting an
    // operation is what discovers the inline request and response shapes that
    // still need records of their own.
    const namespaces: Array<{ path: string[]; source: string }> = [];
    const walk = (node: NamespaceDef): void => {
      if (node.path.length > 0) {
        namespaces.push({ path: node.path, source: emitNamespace(ir, node, models, scopeParam) });
      }
      for (const child of node.children.values()) walk(child);
    };
    walk(ir.root);
    const client = emitClient(ir, models, scopeParam);
    // Printing the operations is what discovered their inline bodies; resolve
    // the records that discovery queued before any of them is written out.
    models.drain();

    for (const fileName of RUNTIME_FILES) {
      const simpleName = fileName.replace(/\.java\.txt$/, "");
      await ctx.write(
        `${SOURCE_ROOT}/${simpleName}.java`,
        `${fileBanner(ir, JAVA_STYLE, PACKAGE_NAME)}${await loadRuntime(ir, fileName)}`,
      );
    }

    await ctx.write(`${SOURCE_ROOT}/${CLIENT_CLASS}.java`, client);
    for (const namespace of namespaces) {
      await ctx.write(`${SOURCE_ROOT}/${namespaceClass(namespace.path)}.java`, namespace.source);
    }
    for (const model of models.records) {
      await ctx.write(`${MODEL_ROOT}/${model.name}.java`, emitRecord(ir, model));
    }
    for (const model of models.constants) {
      await ctx.write(`${MODEL_ROOT}/${model.name}.java`, emitConstants(ir, model));
    }

    await ctx.write("pom.xml", pom(ir));
    await ctx.write("README.md", readme(ir, scopeParam));
    // MIT requires the license text and copyright notice to travel with every
    // copy, so this is an artifact, not a nicety.
    await ctx.write("LICENSE", LICENSE_TEXT);

    for (const { from, to } of models.renamed) {
      ctx.log(`  renamed schema ${from} → ${to} (collides with a reserved name)`);
    }
    const synthesized = models.records.filter((model) => model.specName === undefined).length;
    ctx.log(
      `  ${RUNTIME_FILES.length} runtime + ${namespaces.length + 1} namespace + ` +
        `${models.records.length} model (${synthesized} from inline shapes) + ` +
        `${models.constants.length} constants sources`,
    );
  },
};
