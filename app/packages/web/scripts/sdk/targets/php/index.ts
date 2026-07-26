/**
 * The PHP SDK target.
 *
 * Emits a Composer package that is one class per file, PSR-4 mapped from
 * `Infrawrench\Sdk\` to `src/`:
 *
 *   1. the hand-written request plumbing from `./runtime/*.php.txt`, copied out
 *      verbatim into `src/`, `src/Http/` and `src/Internal/`,
 *   2. `src/Model/` — one declaration per `components.schemas` entry,
 *   3. `src/Api/` — one class per namespace in the dotted call tree, bottomed
 *      out by `src/APIV1Client.php`, which owns the transport.
 *
 * One file per class rather than one module, because PSR-4 is how PHP finds
 * code: a single file would have to be `require`d by hand, defeating Composer's
 * autoloader and parsing all 177 models to make one call. Splitting also means
 * an editor jumps straight to `Account.php`, and a diff between two API versions
 * names the models that changed instead of showing one enormous hunk.
 *
 * Unlike the TypeScript target there is no compile step to catch generator bugs,
 * so what stands in for it is `php -l` over the output and a smoke test that
 * drives a client through a fake `HttpSender`.
 */
import { readFile } from "node:fs/promises";
import { commentLines, fileBanner, operationDocParts, wrap, type CommentStyle } from "../../emit";
import { camelCase, pascalCase, snakeCase, uniqueName } from "../../naming";
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
  SdkIr,
  SchemaDef,
  TypeRef,
} from "../../types";

const PACKAGE_NAME = "infrawrench/sdk";
const CLIENT_CLASS = "APIV1Client";
const PHP_CONSTRAINT = ">=8.1";
const RUNTIME_SENTINEL = "// --8<--";

const NS_ROOT = "Infrawrench\\Sdk";
const NS_API = `${NS_ROOT}\\Api`;
const NS_HTTP = `${NS_ROOT}\\Http`;
const NS_INTERNAL = `${NS_ROOT}\\Internal`;
const NS_MODEL = `${NS_ROOT}\\Model`;

/** Only the banner goes through `emit.ts`; PHPDoc blocks are built by `phpDoc`. */
const PHP_STYLE: CommentStyle = {
  line: "//",
  block: { open: "/*", prefix: " *", close: " */" },
};

/**
 * The runtime, and where each file lands.
 *
 * Kept as real PHP outside a template string for the same reason the TypeScript
 * target keeps its `runtime.ts`: a mistake in the request plumbing should be
 * visible in a file an editor will lint, not buried in output nobody reads.
 */
const RUNTIME_FILES: ReadonlyArray<{ source: string; target: string }> = [
  { source: "ApiException.php.txt", target: "src/ApiException.php" },
  { source: "TransportException.php.txt", target: "src/TransportException.php" },
  { source: "MissingParameterException.php.txt", target: "src/MissingParameterException.php" },
  { source: "RequestOptions.php.txt", target: "src/RequestOptions.php" },
  { source: "FileUpload.php.txt", target: "src/FileUpload.php" },
  { source: "HttpResponse.php.txt", target: "src/Http/HttpResponse.php" },
  { source: "HttpSender.php.txt", target: "src/Http/HttpSender.php" },
  { source: "CurlSender.php.txt", target: "src/Http/CurlSender.php" },
  { source: "StreamSender.php.txt", target: "src/Http/StreamSender.php" },
  { source: "ApiNamespace.php.txt", target: "src/Internal/ApiNamespace.php" },
  { source: "Coerce.php.txt", target: "src/Internal/Coerce.php" },
  { source: "Multipart.php.txt", target: "src/Internal/Multipart.php" },
  { source: "RequestSpec.php.txt", target: "src/Internal/RequestSpec.php" },
  { source: "Transport.php.txt", target: "src/Internal/Transport.php" },
];

/** Short names the runtime owns. Nothing generated may reuse one — see `Imports`. */
const RUNTIME_CLASSES = [
  "ApiException",
  "ApiNamespace",
  "Coerce",
  "CurlSender",
  "FileUpload",
  "HttpResponse",
  "HttpSender",
  "MissingParameterException",
  "Multipart",
  "RequestOptions",
  "RequestSpec",
  "StreamSender",
  "Transport",
  "TransportException",
  CLIENT_CLASS,
];

/**
 * Words PHP refuses as a class name, whatever the case — class names are
 * case-insensitive, so `Int` is as reserved as `int`. Enumerated by feeding
 * every reserved word to the parser rather than from memory, which is how
 * `resource`, `numeric` and `enum` stayed off it: they are only soft-reserved
 * and declare fine.
 *
 * Only *declarations* are constrained. PHP 7's context-sensitive lexer made all
 * of these legal as method names, which is why the dotted call tree needs no
 * escaping at all: `$client->accounts->list()`, `$client->sshKeys->import()`,
 * even a hypothetical `->unset()`, are every one of them fine.
 */
const RESERVED_CLASS_NAMES = new Set([
  "abstract",
  "and",
  "array",
  "as",
  "bool",
  "break",
  "callable",
  "case",
  "catch",
  "class",
  "clone",
  "const",
  "continue",
  "declare",
  "default",
  "do",
  "echo",
  "else",
  "elseif",
  "empty",
  "enddeclare",
  "endfor",
  "endforeach",
  "endif",
  "endswitch",
  "endwhile",
  "eval",
  "exit",
  "extends",
  "false",
  "final",
  "finally",
  "float",
  "fn",
  "for",
  "foreach",
  "function",
  "global",
  "goto",
  "if",
  "implements",
  "include",
  "include_once",
  "instanceof",
  "insteadof",
  "int",
  "interface",
  "isset",
  "iterable",
  "list",
  "match",
  "mixed",
  "namespace",
  "never",
  "new",
  "null",
  "object",
  "or",
  "parent",
  "print",
  "private",
  "protected",
  "public",
  "readonly",
  "require",
  "require_once",
  "return",
  "self",
  "static",
  "string",
  "switch",
  "throw",
  "trait",
  "true",
  "try",
  "unset",
  "use",
  "var",
  "void",
  "while",
  "xor",
  "yield",
]);

/** The one class of method name PHP really does reserve: the magic methods. */
const RESERVED_METHOD_NAMES = new Set([
  "__call",
  "__callstatic",
  "__clone",
  "__construct",
  "__debuginfo",
  "__destruct",
  "__get",
  "__invoke",
  "__isset",
  "__serialize",
  "__set",
  "__set_state",
  "__sleep",
  "__tostring",
  "__unserialize",
  "__unset",
  "__wakeup",
]);

/** `$this` cannot be a parameter; `$options` is every method's trailing argument. */
const RESERVED_VARIABLES = new Set(["this", "options"]);

const PHP_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Longer enum member lists are summarised as `string` rather than spelled out. */
const MAX_INLINE_ENUM_MEMBERS = 8;

/** How deep an `array{…}` shape is spelled out before it degrades to `array`. */
const MAX_SHAPE_DEPTH = 3;

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/**
 * A PHPDoc block, or `null` when there is nothing worth saying.
 *
 * Prose is wrapped by `emit.ts`; tag lines are not, because wrapping
 * `@param array{a: string, b: int} $x` across two lines stops it being a tag.
 */
function phpDoc(prose: Array<string | undefined>, tags: string[] = [], indent = ""): string | null {
  const blocks = prose.filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  if (blocks.length === 0 && tags.length === 0) return null;

  // A `*/` inside a description would close the block early.
  const escape = (text: string): string => text.replace(/\*\//g, "*\\/");
  const lines = blocks.length === 0 ? [] : wrap(escape(blocks.join("\n\n")), 96 - indent.length);
  if (lines.length > 0 && tags.length > 0) lines.push("");
  lines.push(...tags.map(escape));

  const first = lines[0];
  if (lines.length === 1 && first !== undefined && first.length + indent.length <= 90) {
    return `${indent}/** ${first} */`;
  }
  return [`${indent}/**`, ...commentLines(lines, "*", `${indent} `), `${indent} */`].join("\n");
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/**
 * `use` statements for one emitted file.
 *
 * Keyed on the fully qualified name and rendered without aliases, which is only
 * safe because every class this SDK declares has a globally unique short name:
 * models, namespace classes and the runtime all draw from the one `taken` set in
 * `Registry`, so two imports can never collide.
 */
class Imports {
  private readonly used = new Set<string>();

  constructor(private readonly ownNamespace: string) {}

  /** Register `fqcn` and return the name to write at the use site. */
  use(fqcn: string): string {
    const cut = fqcn.lastIndexOf("\\");
    if (fqcn.slice(0, cut) !== this.ownNamespace) this.used.add(fqcn);
    return fqcn.slice(cut + 1);
  }

  lines(): string[] {
    return [...this.used].sort().map((fqcn) => `use ${fqcn};`);
  }
}

// ---------------------------------------------------------------------------
// Schema classification
// ---------------------------------------------------------------------------

/** A `TypeRef` with its nullability lifted out, since PHP spells that `?T`. */
interface Flat {
  inner: TypeRef;
  nullable: boolean;
}

type ObjectRef = Extract<TypeRef, { kind: "object" }>;

/** A member that contributes nothing to an intersection and only obscures it. */
function isEmptyMember(ref: TypeRef): boolean {
  if (ref.kind === "unknown") return true;
  return ref.kind === "object" && ref.properties.length === 0 && ref.additional === null;
}

type SchemaEntry =
  | {
      kind: "model";
      specName: string;
      className: string;
      fqcn: string;
      description: string | undefined;
      properties: PropertyDef[];
      nullable: boolean;
    }
  | {
      kind: "constants";
      specName: string;
      className: string;
      fqcn: string;
      description: string | undefined;
      values: string[];
    }
  | { kind: "alias"; specName: string; type: TypeRef; nullable: boolean };

/**
 * Everything name- and shape-related the emitters look up.
 *
 * Classification runs before naming because the two pull in opposite
 * directions: deciding whether `Role` is a class means merging `RoleSummary`
 * into it, which needs the raw schema graph, while naming needs the final list
 * of classes.
 */
class Registry {
  private readonly defs = new Map<string, SchemaDef>();
  private readonly entries = new Map<string, SchemaEntry>();
  /** Several PHP namespaces, but one pool of short names — see `Imports`. */
  private readonly taken = new Set<string>(RUNTIME_CLASSES);
  private readonly namespaces = new Map<string, string>();
  readonly renamed: Array<{ from: string; to: string }> = [];

  constructor(ir: SdkIr) {
    for (const schema of ir.schemas) this.defs.set(schema.name, schema);
    for (const schema of ir.schemas) this.entries.set(schema.name, this.classify(schema));
    this.registerNamespaces(ir.root);
  }

  private className(specName: string): string {
    const base = pascalCase(specName) || "Schema";
    const safe = RESERVED_CLASS_NAMES.has(base.toLowerCase()) ? `${base}Type` : base;
    const resolved = uniqueName(safe, this.taken);
    if (resolved !== specName) this.renamed.push({ from: specName, to: resolved });
    return resolved;
  }

  private classify(schema: SchemaDef): SchemaEntry {
    const { inner, nullable } = this.shallow(schema.type);

    if (inner.kind === "object" && inner.properties.length > 0) {
      const className = this.className(schema.name);
      return {
        kind: "model",
        specName: schema.name,
        className,
        fqcn: `${NS_MODEL}\\${className}`,
        description: schema.description,
        properties: inner.properties,
        nullable,
      };
    }

    if (inner.kind === "string" && inner.enum && inner.enum.length > 0) {
      const className = this.className(schema.name);
      return {
        kind: "constants",
        specName: schema.name,
        className,
        fqcn: `${NS_MODEL}\\${className}`,
        description: schema.description,
        values: inner.enum,
      };
    }

    // A bare `string`, a free-form map, a union of unrelated shapes: PHP has no
    // type aliases, so a class here would be one nobody could hold an instance
    // of. Use sites inline the shape instead.
    return { kind: "alias", specName: schema.name, type: inner, nullable };
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

  entry(specName: string): SchemaEntry | undefined {
    return this.entries.get(specName);
  }

  /** Every schema that became a file, in spec order. */
  declared(): SchemaEntry[] {
    return [...this.entries.values()].filter((entry) => entry.kind !== "alias");
  }

  namespaceClass(path: string[]): string {
    return this.namespaces.get(path.join(".")) ?? CLIENT_CLASS;
  }

  namespaceFqcn(path: string[]): string {
    const className = this.namespaceClass(path);
    return path.length === 0 ? `${NS_ROOT}\\${className}` : `${NS_API}\\${className}`;
  }

  /**
   * Structural normalization that does not follow `$ref`s: collapse a union to
   * a single member plus a nullable flag, and merge an intersection into one
   * object wherever every member is object-shaped.
   */
  shallow(ref: TypeRef, depth = 0): Flat {
    if (depth > 8) return { inner: { kind: "unknown" }, nullable: false };

    if (ref.kind === "union") {
      let nullable = false;
      const members: TypeRef[] = [];
      const seen = new Set<string>();
      for (const member of ref.members) {
        const flat = this.shallow(member, depth + 1);
        nullable = nullable || flat.nullable;
        if (flat.inner.kind === "null") continue;
        const key = JSON.stringify(flat.inner);
        if (seen.has(key)) continue;
        seen.add(key);
        members.push(flat.inner);
      }
      if (members.length === 0) return { inner: { kind: "unknown" }, nullable: true };
      if (members.length === 1) return { inner: members[0]!, nullable };
      return { inner: { kind: "union", members }, nullable };
    }

    if (ref.kind === "intersection") {
      let nullable = false;
      const members: TypeRef[] = [];
      for (const member of ref.members) {
        const flat = this.shallow(member, depth + 1);
        nullable = nullable || flat.nullable;
        if (!isEmptyMember(flat.inner)) members.push(flat.inner);
      }
      if (members.length === 0) return { inner: { kind: "unknown" }, nullable };
      if (members.length === 1) return { inner: members[0]!, nullable };
      return { inner: this.mergeObjects(members, depth) ?? { kind: "unknown" }, nullable };
    }

    if (ref.kind === "null") return { inner: { kind: "null" }, nullable: true };
    return { inner: ref, nullable: false };
  }

  /**
   * `allOf` is set intersection on JSON Schema, and PHP has no structural
   * types, so the only faithful rendering is one class carrying everybody's
   * properties. Later members win, matching how a reader reads the list.
   */
  private mergeObjects(members: TypeRef[], depth: number): TypeRef | null {
    const properties = new Map<string, PropertyDef>();
    let additional: TypeRef | null = null;
    for (const member of members) {
      const shape = this.objectShape(member, depth);
      if (!shape) return null;
      for (const property of shape.properties) properties.set(property.name, property);
      additional ??= shape.additional;
    }
    return { kind: "object", properties: [...properties.values()], additional };
  }

  private objectShape(ref: TypeRef, depth: number): ObjectRef | null {
    if (depth > 8) return null;
    if (ref.kind === "object") return ref;
    if (ref.kind === "ref") {
      const def = this.defs.get(ref.name);
      return def ? this.objectShape(this.shallow(def.type, depth + 1).inner, depth + 1) : null;
    }
    return null;
  }

  /**
   * `shallow`, plus enough `$ref` following to pick up nullability declared on
   * the target schema and to inline aliases, which have no class to point at.
   */
  resolve(ref: TypeRef, depth = 0): Flat {
    const flat = this.shallow(ref);
    if (flat.inner.kind !== "ref" || depth > 8) return flat;

    const entry = this.entries.get(flat.inner.name);
    if (!entry) return { inner: { kind: "unknown" }, nullable: flat.nullable };
    if (entry.kind === "alias") {
      const target = this.resolve(entry.type, depth + 1);
      return { inner: target.inner, nullable: flat.nullable || entry.nullable || target.nullable };
    }
    return {
      inner: flat.inner,
      nullable: flat.nullable || (entry.kind === "model" && entry.nullable),
    };
  }
}

// ---------------------------------------------------------------------------
// Type printing
// ---------------------------------------------------------------------------

interface TypeContext {
  registry: Registry;
  imports: Imports;
}

/**
 * PHP's own type declaration for a value.
 *
 * Deliberately coarse — one `array` for every list, map and shape — because a
 * declaration that turns out to be wrong at runtime is a `TypeError` in the
 * caller's face. PHPDoc carries the precision instead, where being wrong costs
 * a static-analysis warning.
 */
function nativeType(ref: TypeRef, ctx: TypeContext, forceNullable = false): string {
  const { inner, nullable } = ctx.registry.resolve(ref);
  const atoms = nativeAtoms(inner, ctx);
  if (atoms.size === 0 || atoms.has("mixed")) return "mixed";
  if (!nullable && !forceNullable) return [...atoms].join("|");
  // `?A|B` is not valid PHP; only the single-atom form may use the shorthand.
  return atoms.size === 1 ? `?${[...atoms][0]!}` : [...atoms, "null"].join("|");
}

function nativeAtoms(ref: TypeRef, ctx: TypeContext): Set<string> {
  switch (ref.kind) {
    case "ref": {
      const entry = ctx.registry.entry(ref.name);
      if (entry?.kind === "model") return new Set([ctx.imports.use(entry.fqcn)]);
      // A constants class is a catalogue of strings, not a type of its own.
      return new Set([entry?.kind === "constants" ? "string" : "mixed"]);
    }
    case "string":
      return new Set(["string"]);
    case "number":
      return new Set([ref.integer ? "int" : "float"]);
    case "boolean":
      return new Set(["bool"]);
    case "binary":
      return new Set([ctx.imports.use(`${NS_ROOT}\\FileUpload`), "string"]);
    case "array":
    case "object":
      return new Set(["array"]);
    case "union": {
      const atoms = new Set<string>();
      for (const member of ref.members) {
        for (const atom of nativeAtoms(ctx.registry.resolve(member).inner, ctx)) atoms.add(atom);
      }
      return atoms;
    }
    case "null":
    case "unknown":
    case "intersection":
      return new Set(["mixed"]);
  }
}

interface DocOptions {
  depth: number;
  /**
   * False once we are inside a position the generated `fromArray` passes
   * through untouched, where a `$ref` really does arrive as a raw array —
   * claiming `Account` there would be a lie the caller only discovers at
   * runtime. See `decodeExpr` for where the hydration boundary falls.
   */
  hydrated: boolean;
}

/** The precise PHPDoc type: `list<Account>`, `array{ts: string}`, `'a'|'b'`. */
function docType(ref: TypeRef, ctx: TypeContext, opts: DocOptions, forceNullable = false): string {
  const { inner, nullable } = ctx.registry.resolve(ref);
  const printed = docAtom(inner, ctx, opts);
  if (printed === "mixed" || (!nullable && !forceNullable)) return printed;
  return `${printed}|null`;
}

function docAtom(ref: TypeRef, ctx: TypeContext, opts: DocOptions): string {
  switch (ref.kind) {
    case "ref": {
      const entry = ctx.registry.entry(ref.name);
      // `Foo::*` is how PHPStan and Psalm spell "one of this class's constants",
      // so the exact value set survives even though the property is a `string`.
      if (entry?.kind === "constants") return `${ctx.imports.use(entry.fqcn)}::*`;
      if (entry?.kind === "model") {
        return opts.hydrated ? ctx.imports.use(entry.fqcn) : "array<string, mixed>";
      }
      return "mixed";
    }
    case "string":
      return ref.enum && ref.enum.length > 0 && ref.enum.length <= MAX_INLINE_ENUM_MEMBERS
        ? ref.enum.map((value) => `'${value.replace(/'/g, "\\'")}'`).join("|")
        : "string";
    case "number":
      return ref.integer ? "int" : "float";
    case "boolean":
      return "bool";
    case "binary":
      return `${ctx.imports.use(`${NS_ROOT}\\FileUpload`)}|string`;
    case "array":
      return `list<${docType(ref.items, ctx, opts)}>`;
    case "object":
      return docObject(ref, ctx, opts);
    case "union": {
      if (opts.depth >= MAX_SHAPE_DEPTH) return "mixed";
      const members = ref.members.map((member) =>
        docType(member, ctx, { ...opts, depth: opts.depth + 1 }),
      );
      return [...new Set(members)].join("|");
    }
    case "null":
      return "null";
    case "intersection":
    case "unknown":
      return "mixed";
  }
}

function docObject(ref: ObjectRef, ctx: TypeContext, opts: DocOptions): string {
  if (ref.properties.length === 0) {
    return ref.additional
      ? `array<string, ${docType(ref.additional, ctx, opts)}>`
      : "array<string, mixed>";
  }
  if (opts.depth >= MAX_SHAPE_DEPTH) return "array<string, mixed>";

  // Nothing below an inline object is turned into a class, so everything it
  // mentions arrives as raw decoded JSON.
  const inner: DocOptions = { depth: opts.depth + 1, hydrated: false };
  const fields = ref.properties.map(
    (property) =>
      `${property.name}${property.required ? "" : "?"}: ${docType(property.type, ctx, inner)}`,
  );
  const shape = `array{${fields.join(", ")}}`;
  // Past a point a shape stops being documentation and starts being noise.
  return shape.length > 200 ? "array<string, mixed>" : shape;
}

/**
 * Only worth a `@param`/`@return` line when it says more than the declaration.
 * `?X` and `X|null` are the same type spelled two ways, so neither counts.
 */
function docAddsInformation(doc: string, native: string): boolean {
  const normalize = (type: string): string =>
    type.startsWith("?") ? `${type.slice(1)}|null` : type;
  return normalize(doc) !== normalize(native);
}

// ---------------------------------------------------------------------------
// Decoding and encoding
// ---------------------------------------------------------------------------

/**
 * PHP expression turning `expr` — a `mixed` straight off `json_decode` — into
 * the declared type.
 *
 * Hydration follows `$ref`s through lists and maps but stops at an inline
 * object with named properties: giving every anonymous shape in the spec its own
 * class would roughly double the file count for types nobody can name. `docType`
 * knows where that boundary falls and stops promising model classes past it.
 */
function decodeExpr(ref: TypeRef, expr: string, ctx: TypeContext, forceNullable = false): string {
  const { inner, nullable: resolved } = ctx.registry.resolve(ref);
  const nullable = resolved || forceNullable;
  const coerce = ctx.imports.use(`${NS_INTERNAL}\\Coerce`);
  const suffix = nullable ? "OrNull" : "";

  /** `Coerce::nullable(…)` wraps whatever cannot express its own null case. */
  const guard = (build: (value: string) => string, type: string): string =>
    nullable
      ? `${coerce}::nullable(${expr}, static fn (mixed $value): ${type} => ${build("$value")})`
      : build(expr);

  switch (inner.kind) {
    case "ref": {
      const entry = ctx.registry.entry(inner.name);
      if (entry?.kind === "model") {
        const model = ctx.imports.use(entry.fqcn);
        return guard((value) => `${model}::fromArray(${coerce}::toArray(${value}))`, model);
      }
      // Constants classes are strings on the wire and strings in the model.
      return `${coerce}::toString${suffix}(${expr})`;
    }
    case "string":
      return `${coerce}::toString${suffix}(${expr})`;
    case "number":
      return `${coerce}::to${inner.integer ? "Int" : "Float"}${suffix}(${expr})`;
    case "boolean":
      return `${coerce}::toBool${suffix}(${expr})`;
    case "binary":
      return `${coerce}::toBytes${suffix}(${expr})`;
    case "array": {
      const element = decodeExpr(inner.items, "$item", ctx);
      if (element === "$item") return `${coerce}::toList${suffix}(${expr})`;
      const type = nativeType(inner.items, ctx);
      return guard(
        (value) => `${coerce}::mapList(${value}, static fn (mixed $item): ${type} => ${element})`,
        "array",
      );
    }
    case "object": {
      // Only a pure map (no named properties) is worth walking; anything with
      // properties is handed over as the raw array `docType` promised.
      if (inner.properties.length > 0 || inner.additional === null) {
        return `${coerce}::toArray${suffix}(${expr})`;
      }
      const element = decodeExpr(inner.additional, "$item", ctx);
      if (element === "$item") return `${coerce}::toArray${suffix}(${expr})`;
      const type = nativeType(inner.additional, ctx);
      return guard(
        (value) => `${coerce}::mapValues(${value}, static fn (mixed $item): ${type} => ${element})`,
        "array",
      );
    }
    case "null":
    case "unknown":
    case "union":
    case "intersection":
      // Declared `mixed`; there is nothing to narrow it to.
      return expr;
  }
}

/** The inverse: a PHP value back to something `json_encode` will accept. */
function encodeExpr(ref: TypeRef, expr: string, ctx: TypeContext, forceNullable = false): string {
  const { inner, nullable: resolved } = ctx.registry.resolve(ref);
  const nullable = resolved || forceNullable;

  const mapModels = (items: TypeRef): string | null => {
    const element = encodeExpr(items, "$item", ctx);
    if (element === "$item") return null;
    const type = nativeType(items, ctx);
    return `array_map(static fn (${type} $item): array => ${element}, ${expr})`;
  };

  switch (inner.kind) {
    case "ref": {
      const entry = ctx.registry.entry(inner.name);
      if (entry?.kind !== "model") return expr;
      return nullable ? `${expr}?->toArray()` : `${expr}->toArray()`;
    }
    case "array": {
      const mapped = mapModels(inner.items);
      if (mapped === null) return expr;
      return nullable ? `${expr} === null ? null : ${mapped}` : mapped;
    }
    case "object": {
      if (inner.properties.length > 0 || inner.additional === null) return expr;
      const mapped = mapModels(inner.additional);
      if (mapped === null) return expr;
      return nullable ? `${expr} === null ? null : ${mapped}` : mapped;
    }
    default:
      return expr;
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

interface ModelField {
  /** Wire name — the array key. */
  wire: string;
  /** PHP property and constructor-parameter name. */
  php: string;
  native: string;
  doc: string;
  required: boolean;
  type: TypeRef;
  description: string | undefined;
  deprecated: boolean;
}

function modelFields(properties: PropertyDef[], ctx: TypeContext): ModelField[] {
  const taken = new Set<string>(RESERVED_VARIABLES);
  const fields = properties.map((property): ModelField => {
    const base = camelCase(property.name);
    const safe = PHP_IDENTIFIER.test(base) ? base : `field${pascalCase(property.name) || "Value"}`;
    const optional = !property.required;
    return {
      wire: property.name,
      php: uniqueName(safe, taken),
      // An optional field defaults to `null`, so its declaration has to admit
      // one even where the spec's own type does not.
      native: nativeType(property.type, ctx, optional),
      doc: docType(property.type, ctx, { depth: 0, hydrated: true }, optional),
      required: property.required,
      type: property.type,
      description: property.description,
      deprecated: property.deprecated === true,
    };
  });

  // PHP will not accept a required parameter after an optional one. Named
  // arguments make the declaration order invisible at the call site anyway.
  return [
    ...fields.filter((field) => field.required),
    ...fields.filter((field) => !field.required),
  ];
}

function emitModel(entry: Extract<SchemaEntry, { kind: "model" }>, ir: SdkIr): string {
  const imports = new Imports(NS_MODEL);
  const ctx: TypeContext = { registry: REGISTRY, imports };
  const fields = modelFields(entry.properties, ctx);

  const parameterTags = fields
    .filter((field) => docAddsInformation(field.doc, field.native) || field.description)
    .map((field) => {
      const notes = [field.description, field.deprecated ? "Deprecated." : undefined]
        .filter(Boolean)
        .join(" ");
      return `@param ${field.doc} $${field.php}${notes ? ` ${notes}` : ""}`;
    });

  const declaration = fields.map(
    (field) =>
      `        public readonly ${field.native} $${field.php}${field.required ? "" : " = null"},`,
  );

  const hydration = fields.map(
    (field) =>
      `            ${field.php}: ` +
      `${decodeExpr(field.type, `$data['${field.wire}'] ?? null`, ctx, !field.required)},`,
  );

  const optional = fields.filter((field) => !field.required);
  const entries = fields
    .filter((field) => field.required)
    .map(
      (field) =>
        `            '${field.wire}' => ${encodeExpr(field.type, `$this->${field.php}`, ctx)},`,
    );

  const serialization: string[] =
    optional.length === 0
      ? ["        return [", ...entries, "        ];"]
      : ["        $payload = [", ...entries, "        ];"];
  for (const field of optional) {
    // Only optional fields are dropped when null. A nullable *required* field
    // means the server wants to see the null, and pruning it would change the
    // request — so the two cases stay apart here rather than in a helper that
    // could only guess which is which.
    const value = encodeExpr(field.type, `$this->${field.php}`, ctx);
    serialization.push(
      `        if ($this->${field.php} !== null) {`,
      `            $payload['${field.wire}'] = ${value};`,
      "        }",
    );
  }
  if (optional.length > 0) serialization.push("", "        return $payload;");

  const body = [
    phpDoc([
      entry.description,
      entry.className === entry.specName ? undefined : `Spec schema: \`${entry.specName}\`.`,
      entry.nullable ? "The API may send `null` in place of this object." : undefined,
    ]),
    `final class ${entry.className} implements \\JsonSerializable`,
    "{",
    phpDoc([], parameterTags, "    "),
    "    public function __construct(",
    ...declaration,
    "    ) {",
    "    }",
    "",
    phpDoc(
      ["Build one from a decoded JSON object."],
      ["@param array<string, mixed> $data"],
      "    ",
    ),
    "    public static function fromArray(array $data): self",
    "    {",
    "        return new self(",
    ...hydration,
    "        );",
    "    }",
    "",
    phpDoc(
      ["The wire representation, ready for `json_encode`."],
      ["@return array<string, mixed>"],
      "    ",
    ),
    "    public function toArray(): array",
    "    {",
    ...serialization,
    "    }",
    "",
    phpDoc([], ["@return array<string, mixed>"], "    "),
    "    public function jsonSerialize(): mixed",
    "    {",
    "        return $this->toArray();",
    "    }",
    "}",
  ];

  const rendered = body.filter((line): line is string => line !== null).join("\n");
  return phpFile(ir, NS_MODEL, usedImports(imports, rendered), rendered);
}

/**
 * Drop imports the rendered body never mentions.
 *
 * A type printer registers an import the moment it prints a name, but a name
 * that only reached a `@param` line the doc builder then discarded as redundant
 * leaves the import behind — and an unused `use` is something a reviewer has to
 * stop and think about.
 */
function usedImports(imports: Imports, rendered: string): string[] {
  return imports.lines().filter((line) => {
    const fqcn = line.slice("use ".length, -1);
    const short = fqcn.slice(fqcn.lastIndexOf("\\") + 1);
    return new RegExp(`\\b${short}\\b`).test(rendered);
  });
}

function constantName(value: string, taken: Set<string>): string {
  let base = snakeCase(value).toUpperCase();
  if (base === "" || !/^[A-Z_]/.test(base)) base = `VALUE_${base}`;
  // `Foo::CLASS` is reserved for `Foo::class`, whatever the case.
  if (base === "CLASS") base = "CLASS_NAME";
  return uniqueName(base, taken);
}

function emitConstants(entry: Extract<SchemaEntry, { kind: "constants" }>, ir: SdkIr): string {
  const taken = new Set<string>();
  const members = entry.values.map((value) => ({ name: constantName(value, taken), value }));

  const body = [
    phpDoc([
      entry.description,
      `The values \`${entry.specName}\` accepts.`,
      // A PHP 8.1 backed enum is the obvious choice here and the wrong one:
      // `Foo::from()` raises on any value it has not heard of, so the day the
      // API gains a plugin or a permission, every deployed client starts
      // throwing while decoding responses nobody asked it about. Constants keep
      // the property a plain `string` so an unknown value round-trips, and the
      // `Foo::*` PHPDoc type still gives static analysis the exact set.
      "Constants rather than an enum, deliberately: a value added by a newer API " +
        "version has to deserialize, and `enum::from()` would raise instead.",
      entry.className === entry.specName ? undefined : `Spec schema: \`${entry.specName}\`.`,
    ]),
    `final class ${entry.className}`,
    "{",
    ...members.map(
      (member) => `    public const ${member.name} = '${member.value.replace(/'/g, "\\'")}';`,
    ),
    "",
    phpDoc(["Every value, in the order the spec lists them."], ["@return list<string>"], "    "),
    "    public static function values(): array",
    "    {",
    "        return [",
    ...members.map((member) => `            self::${member.name},`),
    "        ];",
    "    }",
    "}",
  ];

  return phpFile(ir, NS_MODEL, [], body.filter((line): line is string => line !== null).join("\n"));
}

// ---------------------------------------------------------------------------
// Namespaces and operations
// ---------------------------------------------------------------------------

interface Argument {
  php: string;
  native: string;
  doc: string;
  optional: boolean;
  description: string | undefined;
}

function parameterDescription(param: ParameterDef, scopeParam: string | null): string | undefined {
  if (!param.defaultable) return param.description;
  const base = param.description ? `${param.description.replace(/\.$/, "")}. ` : "";
  return `${base}Defaults to the \`${scopeParam ?? param.name}\` the client was constructed with.`;
}

interface OperationArguments {
  /** Call-site arguments paired with the parameter each one fills. */
  parameters: Array<{ param: ParameterDef; argument: Argument }>;
  body: Argument | null;
}

function operationArguments(op: OperationDef, ctx: TypeContext, ir: SdkIr): OperationArguments {
  const taken = new Set<string>(RESERVED_VARIABLES);

  const parameters = op.parameters.map((param) => {
    const base = camelCase(param.name);
    const safe = PHP_IDENTIFIER.test(base) ? base : `param${pascalCase(param.name) || "Value"}`;
    // A defaultable path parameter is required on the wire but optional here:
    // the transport fills it in from client configuration.
    const optional = param.defaultable || !param.required;
    return {
      param,
      argument: {
        php: uniqueName(safe, taken),
        native: nativeType(param.type, ctx, optional),
        doc: docType(param.type, ctx, { depth: 0, hydrated: true }, optional),
        optional,
        description: parameterDescription(param, ir.defaultablePathParam),
      },
    };
  });

  const body = op.body
    ? {
        php: uniqueName("body", taken),
        native: nativeType(op.body.type, ctx, !op.body.required),
        doc: docType(op.body.type, ctx, { depth: 0, hydrated: true }, !op.body.required),
        optional: !op.body.required,
        description:
          op.body.encoding === "multipart" ? "Sent as `multipart/form-data`." : undefined,
      }
    : null;

  return { parameters, body };
}

function returnType(op: OperationDef, ctx: TypeContext): { native: string; doc: string } {
  switch (op.response.encoding) {
    case "empty":
      return { native: "void", doc: "void" };
    case "binary":
      return { native: "string", doc: "string" };
    case "json":
      return op.response.type
        ? {
            native: nativeType(op.response.type, ctx),
            doc: docType(op.response.type, ctx, { depth: 0, hydrated: true }),
          }
        : { native: "mixed", doc: "mixed" };
  }
}

function emitOperation(op: OperationDef, ctx: TypeContext, ir: SdkIr): string {
  const { parameters, body } = operationArguments(op, ctx, ir);
  const requestOptions = ctx.imports.use(`${NS_ROOT}\\RequestOptions`);
  const requestSpec = ctx.imports.use(`${NS_INTERNAL}\\RequestSpec`);
  const coerce = ctx.imports.use(`${NS_INTERNAL}\\Coerce`);
  const ret = returnType(op, ctx);

  const all = [...parameters.map((entry) => entry.argument), ...(body ? [body] : [])];
  const ordered = [...all.filter((a) => !a.optional), ...all.filter((a) => a.optional)];

  const tags: string[] = [];
  for (const argument of ordered) {
    if (!docAddsInformation(argument.doc, argument.native) && !argument.description) continue;
    const suffix = argument.description ? ` ${argument.description}` : "";
    tags.push(`@param ${argument.doc} $${argument.php}${suffix}`);
  }
  if (op.response.encoding === "binary") tags.push("@return string Raw response bytes.");
  else if (op.response.encoding !== "empty" && docAddsInformation(ret.doc, ret.native)) {
    tags.push(`@return ${ret.doc}`);
  }
  tags.push(
    `@throws \\${NS_ROOT}\\ApiException on any non-2xx response.`,
    `@throws \\${NS_ROOT}\\MissingParameterException if a path parameter has no value.`,
  );

  const signature = ordered.map(
    (argument) => `${argument.native} $${argument.php}${argument.optional ? " = null" : ""}`,
  );
  signature.push(`?${requestOptions} $options = null`);

  const spec: string[] = [
    `                method: '${op.method.toUpperCase()}',`,
    `                path: '${op.path}',`,
  ];
  for (const where of ["path", "query"] as const) {
    const entries = parameters
      .filter((entry) => entry.param.in === where)
      .map((entry) => `'${entry.param.name}' => $${entry.argument.php}`);
    if (entries.length === 0) continue;
    spec.push(
      `                ${where === "path" ? "pathParams" : "query"}: [${entries.join(", ")}],`,
    );
  }
  if (op.body && body) {
    const encoded = encodeExpr(op.body.type, `$${body.php}`, ctx, body.optional);
    if (op.body.encoding === "multipart") {
      spec.push(`                form: ${encoded},`);
    } else {
      spec.push(
        `                body: ${encoded},`,
        // An omitted optional body must not go out as a literal `null`.
        `                hasBody: ${body.optional ? `$${body.php} !== null` : "true"},`,
      );
    }
  }
  if (op.response.encoding !== "json")
    spec.push(`                accept: '${op.response.encoding}',`);

  const lines: string[] = [
    `    public function ${methodName(op)}(${signature.join(", ")}): ${ret.native}`,
    "    {",
    `        ${op.response.encoding === "empty" ? "" : "$data = "}$this->transport->request(`,
    `            new ${requestSpec}(`,
    ...spec,
    "            ),",
    "            $options,",
    "        );",
  ];
  if (op.response.encoding === "binary") {
    lines.push("", `        return ${coerce}::toString($data);`);
  } else if (op.response.encoding === "json") {
    lines.push(
      "",
      `        return ${op.response.type ? decodeExpr(op.response.type, "$data", ctx) : "$data"};`,
    );
  }
  lines.push("    }");

  const doc = phpDoc(operationDocParts(op), tags, "    ");
  return doc ? `${doc}\n${lines.join("\n")}` : lines.join("\n");
}

function methodName(op: OperationDef): string {
  const base = camelCase(op.name) || camelCase(op.id);
  if (RESERVED_METHOD_NAMES.has(base.toLowerCase()) || !PHP_IDENTIFIER.test(base)) {
    return `call${pascalCase(op.name) || pascalCase(op.id)}`;
  }
  return base;
}

function propertyName(segment: string): string {
  const base = camelCase(segment);
  return PHP_IDENTIFIER.test(base) ? base : `ns${pascalCase(segment) || "Child"}`;
}

function emitNamespace(node: NamespaceDef, ir: SdkIr): string {
  const isRoot = node.path.length === 0;
  const namespace = isRoot ? NS_ROOT : NS_API;
  const imports = new Imports(namespace);
  const ctx: TypeContext = { registry: REGISTRY, imports };
  const className = REGISTRY.namespaceClass(node.path);
  const transport = imports.use(`${NS_INTERNAL}\\Transport`);

  const children = [...node.children.entries()].map(([segment, child]) => ({
    property: propertyName(segment),
    dotted: child.path.join("->"),
    className: imports.use(REGISTRY.namespaceFqcn(child.path)),
  }));

  // Rendered before the header so every import they need is registered by the
  // time `imports.lines()` is read.
  const operations = node.operations.map((op) => emitOperation(op, ctx, ir));

  const header: string[] = [];
  /** Class members as separate blocks, so exactly one blank line joins them. */
  const members: string[][] = [];
  const constructorSignature: string[] = [];
  const constructorBody: string[] = [];
  let constructorDoc: string | null = null;

  if (isRoot) {
    const example = ir.operations.find(
      (op) => op.namespace[0] === "accounts" && op.name === "list",
    );
    const call = example
      ? `$client->${[...example.namespace, example.name].join("->")}()`
      : "$client";
    const sender = imports.use(`${NS_HTTP}\\HttpSender`);

    header.push(
      phpDoc([
        `A client for the ${ir.title}.`,
        // One part, not four: `wrap` treats each part as its own paragraph and
        // would put a blank line between every line of the example.
        [
          "```php",
          `$client = new ${CLIENT_CLASS}(apiKey: getenv('INFRAWRENCH_API_KEY') ?: null, orgId: $orgId);`,
          `$accounts = ${call};`,
          "```",
        ].join("\n"),
        "Namespaces hang off plain readonly properties rather than a `__get` shim." +
          " A typo in `$client->acounts->list()` is then a static-analysis error" +
          " instead of a runtime one, and an editor can complete the tree, which" +
          " `__get` cannot offer at any price. The cost is one small object per" +
          " namespace, built once per client.",
      ])!,
      `final class ${className}`,
      "{",
    );
    members.push([
      phpDoc(
        [
          "Shared request plumbing.",
          "Public so a caller can read the resolved base URL, but not part of the stable surface.",
        ],
        [],
        "    ",
      )!,
      `    public readonly ${transport} $transport;`,
    ]);

    constructorDoc = phpDoc(
      [],
      [
        "@param string|null $apiKey API key or access token, sent as `Authorization: Bearer …`.",
        "@param string|null $orgId Default organization id. Every org-scoped call accepts" +
          " `orgId:`; set it once here and leave it off the call sites.",
        `@param string|null $baseUrl Deployment to talk to. Defaults to \`${ir.baseUrl}\`.`,
        "@param array<string, string> $headers Merged into every request; per-call headers win.",
        "@param float|null $timeout Seconds to wait per request. No limit by default.",
        `@param ${sender}|null $sender Replaces the HTTP layer — for proxies, or for tests.`,
      ],
      "    ",
    );
    constructorSignature.push(
      "    public function __construct(",
      "        ?string $apiKey = null,",
      "        ?string $orgId = null,",
      "        ?string $baseUrl = null,",
      "        array $headers = [],",
      "        ?float $timeout = null,",
      `        ?${sender} $sender = null,`,
      "    ) {",
    );
    constructorBody.push(
      `        $this->transport = new ${transport}(`,
      "            $apiKey,",
      "            $orgId,",
      "            $baseUrl,",
      "            $headers,",
      "            $timeout,",
      "            $sender,",
      "        );",
    );
  } else {
    header.push(
      phpDoc([`\`$client->${node.path.join("->")}\``])!,
      `final class ${className} extends ${imports.use(`${NS_INTERNAL}\\ApiNamespace`)}`,
      "{",
    );
    constructorSignature.push(`    public function __construct(${transport} $transport)`, "    {");
    constructorBody.push("        parent::__construct($transport);");
  }

  for (const child of children) {
    members.push([
      phpDoc([`\`$client->${child.dotted}\``], [], "    ")!,
      `    public readonly ${child.className} $${child.property};`,
    ]);
    constructorBody.push(
      `        $this->${child.property} = new ${child.className}($this->transport);`,
    );
  }

  // A leaf namespace's constructor would only forward to `ApiNamespace`, which
  // is exactly what inheriting it already does.
  if (isRoot || children.length > 0) {
    members.push([
      ...(constructorDoc === null ? [] : [constructorDoc]),
      ...constructorSignature,
      ...constructorBody,
      "    }",
    ]);
  }
  for (const operation of operations) members.push(operation.split("\n"));

  const lines = [
    ...header,
    ...members.flatMap((block, index) => (index === 0 ? block : ["", ...block])),
    "}",
  ];

  const rendered = lines.join("\n");
  return phpFile(ir, namespace, usedImports(imports, rendered), rendered);
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

/** Every emitted file has the same head: tag, banner, strict types, namespace. */
function phpFile(ir: SdkIr, namespace: string, imports: string[], body: string): string {
  const parts = [
    "<?php",
    "",
    fileBanner(ir, PHP_STYLE, PACKAGE_NAME).trimEnd(),
    "",
    "declare(strict_types=1);",
    "",
    `namespace ${namespace};`,
  ];
  if (imports.length > 0) parts.push("", ...imports);
  parts.push("", body);
  return `${parts.join("\n")}\n`;
}

/**
 * One runtime file, with its editing note stripped, the spec's values
 * substituted for the `@@TOKEN@@` placeholders, and the banner spliced in.
 *
 * The banner goes in by hand rather than through `phpFile` because these files
 * bring their own `namespace` and `use` lines — they are source, not output.
 */
async function loadRuntime(ir: SdkIr, source: string): Promise<string> {
  const text = await readFile(new URL(`./runtime/${source}`, import.meta.url), "utf8");
  const start = text.indexOf(RUNTIME_SENTINEL);
  if (start === -1) {
    throw new Error(`runtime/${source} is missing its "${RUNTIME_SENTINEL}" sentinel line`);
  }

  const body = text
    .slice(text.indexOf("\n", start) + 1)
    .trim()
    .replace(/@@BASE_URL@@/g, ir.baseUrl)
    .replace(/@@SCOPE_PARAM@@/g, ir.defaultablePathParam ?? "")
    .replace(/@@USER_AGENT@@/g, `infrawrench-sdk-php/${ir.apiVersion}`)
    .replace(/^declare\(strict_types=1\);\n+/, "");

  const banner = fileBanner(ir, PHP_STYLE, PACKAGE_NAME).trimEnd();
  return `<?php\n\n${banner}\n\ndeclare(strict_types=1);\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Package files
// ---------------------------------------------------------------------------

function composerJson(ir: SdkIr): string {
  return `${JSON.stringify(
    {
      name: PACKAGE_NAME,
      description: `Generated PHP client for the ${ir.title} (v${ir.apiVersion}).`,
      type: "library",
      keywords: [...KEYWORDS, "php"],
      homepage: HOMEPAGE,
      license: LICENSE,
      // No `version` key. Composer resolves a package's version from the VCS tag
      // it is published under, and a hardcoded one here would either disagree
      // with that tag or have to be kept in step by hand — `composer validate`
      // warns about it for exactly that reason. The API version this was built
      // from is in the README and at the top of every file.
      authors: [
        { name: AUTHOR.name, email: AUTHOR.email, homepage: AUTHOR.url, role: "Publisher" },
        ...CONTRIBUTORS.map((contributor) => ({
          name: contributor.name,
          email: contributor.email,
          role: "Developer",
        })),
      ],
      support: { issues: ISSUES_URL, source: REPOSITORY_URL, docs: HOMEPAGE, email: AUTHOR.email },
      // Nothing but the PHP runtime itself. `ext-curl` is only a suggestion
      // because `StreamSender` covers the case where it is absent.
      require: { php: PHP_CONSTRAINT, "ext-json": "*" },
      suggest: {
        "ext-curl": "Preferred HTTP backend. Without it the client falls back to stream wrappers.",
      },
      // PSR-4 prefixes end in a namespace separator. One backslash: `JSON.stringify`
      // does the doubling that the file on disk needs.
      autoload: { "psr-4": { [`${NS_ROOT}\\`]: "src/" } },
      config: { "sort-packages": true },
    },
    null,
    2,
  )}\n`;
}

function readme(ir: SdkIr): string {
  const example = ir.operations.find((op) => op.namespace[0] === "accounts" && op.name === "list");
  const call = example
    ? `$client->${[...example.namespace, example.name].join("->")}()`
    : "$client";

  return `# ${PACKAGE_NAME}

Generated PHP client for the ${ir.title} (API version \`${ir.apiVersion}\`).

**Do not edit this package by hand** — it is regenerated from \`openapi.json\` and
is not checked into the repository. Run
\`pnpm --filter @infrawrench/web generate:sdk\` to rebuild it; the generator lives
in [\`${GENERATOR_PATH}\`](${REPOSITORY_URL}/tree/main/${GENERATOR_PATH}).

Requires PHP ${PHP_CONSTRAINT.replace(">=", "")}+. No Composer dependencies: \`ext-curl\` is used when it is
loaded, and a stream-wrapper fallback when it is not.

## Versioning

There is no \`version\` field in \`composer.json\`, because Composer takes a
package's version from the git tag it was published under. The API version each
build was generated from is the one in the heading above, and it is repeated at
the top of every emitted file — tag releases to match it.

## Install

\`\`\`sh
composer require ${PACKAGE_NAME}
\`\`\`

## Usage

\`\`\`php
<?php

require __DIR__ . '/vendor/autoload.php';

use ${NS_ROOT}\\${CLIENT_CLASS};
use ${NS_ROOT}\\ApiException;

$client = new ${CLIENT_CLASS}(
    apiKey: getenv('INFRAWRENCH_API_KEY') ?: null,
    orgId: getenv('INFRAWRENCH_ORG_ID') ?: null,
);

try {
    foreach (${call} as $account) {
        echo $account->id, "\\n";
    }
} catch (ApiException $e) {
    echo $e->status, ' ', $e->errorCode ?? '(no code)', "\\n";
}
\`\`\`

Calls are namespaced to mirror the URL structure, so
\`POST /api/org/{orgId}/accounts/{id}/sync\` is \`$client->accounts->sync(id: $id)\`
and \`POST …/secret-versions/add\` is \`$client->resources->secretVersions->add(…)\`.

Set \`orgId\` once on the client and every org-scoped call can omit it; pass
\`orgId:\` on an individual call to override it. Omitting both raises
\`MissingParameterException\` before anything is sent.

### Named arguments, not an options array

Every call takes named arguments. An \`array $params\` would have been shorter to
generate, but it erases every argument's type, hides typos until runtime, and
gives an editor nothing to complete. Required arguments are declared first
because PHP requires it — with named arguments that ordering never shows up at a
call site.

Each method also takes a trailing \`RequestOptions\` for per-call headers and
timeouts:

\`\`\`php
$client->accounts->list(options: new RequestOptions(timeout: 5.0));
\`\`\`

## Models

Response bodies come back as classes under \`${NS_MODEL}\`, with
readonly properties, \`fromArray()\`, \`toArray()\` and \`JsonSerializable\`.

Schemas that are a fixed set of strings — plugin ids, permissions, resource
statuses — are classes of constants rather than PHP enums, so that a value added
by a newer API version still deserializes instead of raising. PHPDoc still pins
the exact set via \`PluginId::*\`, so static analysis loses nothing.

## Errors

Non-2xx responses throw \`ApiException\`, carrying \`status\`, the decoded \`body\`,
and \`errorCode\` — the API's machine-readable \`code\` field — when the response
has one. Branch on \`errorCode\`, never on the message.

Network failures and malformed payloads throw \`TransportException\`, which is
usually worth retrying where an \`ApiException\` is not.

## Testing

\`${NS_HTTP}\\HttpSender\` is the only seam between this client and the
network. Pass an implementation as \`sender:\` and every call runs through it with
path interpolation, query serialization, multipart encoding and error mapping
still applied:

\`\`\`php
$client = new ${CLIENT_CLASS}(orgId: 'org_1', sender: $recordingSender);
\`\`\`

## Scope

This package covers the published API surface only: ${ir.operations.length} operations across
${ir.schemas.length} schemas. Operations marked \`x-internal\` in the spec — the admin surface,
webhook receivers, desktop sync, push registration, and the browser auth
redirects — are not generated.

## License

${LICENSE} — see [\`LICENSE\`](./LICENSE). ${COPYRIGHT_NOTICE}.

Note that this client is more permissively licensed than the service it talks
to: the Infrawrench source is BUSL-1.1, but the generated clients are ${LICENSE} so you
can link one into your own software without inheriting those terms.

Issues: <${ISSUES_URL}>
`;
}

// ---------------------------------------------------------------------------

/**
 * Set once per `generate()` call.
 *
 * A module-level binding rather than a threaded argument: the emitters need the
 * registry from deep inside the recursion, and threading it through every
 * signature buys nothing when generation is single-pass and single-threaded.
 */
let REGISTRY: Registry;

export const phpTarget: SdkTarget = {
  id: "php",
  displayName: "PHP",
  packageName: PACKAGE_NAME,
  artifacts: [
    "composer.json",
    "LICENSE",
    "README.md",
    "src/APIV1Client.php",
    "src/Internal/Transport.php",
  ],

  async generate(ir: SdkIr, ctx: TargetContext): Promise<void> {
    REGISTRY = new Registry(ir);

    for (const file of RUNTIME_FILES)
      await ctx.write(file.target, await loadRuntime(ir, file.source));

    const declared = REGISTRY.declared();
    for (const entry of declared) {
      if (entry.kind === "model") {
        await ctx.write(`src/Model/${entry.className}.php`, emitModel(entry, ir));
      } else if (entry.kind === "constants") {
        await ctx.write(`src/Model/${entry.className}.php`, emitConstants(entry, ir));
      }
    }

    let namespaces = 0;
    const emit = async (node: NamespaceDef): Promise<void> => {
      const className = REGISTRY.namespaceClass(node.path);
      const path = node.path.length === 0 ? `src/${className}.php` : `src/Api/${className}.php`;
      await ctx.write(path, emitNamespace(node, ir));
      namespaces++;
      for (const child of node.children.values()) await emit(child);
    };
    await emit(ir.root);

    await ctx.write("composer.json", composerJson(ir));
    await ctx.write("README.md", readme(ir));
    // MIT requires the license text and copyright notice to travel with every
    // copy, so this is an artifact, not a nicety.
    await ctx.write("LICENSE", LICENSE_TEXT);

    for (const { from, to } of REGISTRY.renamed) ctx.log(`  renamed schema ${from} → ${to}`);
    ctx.log(
      `  ${RUNTIME_FILES.length} runtime + ${declared.length} model + ${namespaces} namespace classes`,
    );
  },
};
