/**
 * The Rust SDK target.
 *
 * Emits a small crate rather than one file, because Rust's module system is the
 * unit consumers navigate:
 *
 *   - `src/lib.rs`    — the hand-written request plumbing from `./runtime.rs`,
 *                       inlined verbatim, plus the module wiring.
 *   - `src/models.rs` — one declaration per `components.schemas` entry, plus the
 *                       named types hoisted out of inline shapes (see below).
 *   - `src/params.rs` — one `…Params` struct per operation.
 *   - `src/client.rs` — one struct per namespace in the dotted call tree,
 *                       bottomed out by `APIV1Client`.
 *
 * The interesting difference from the TypeScript target is that Rust has no
 * structural types. TypeScript can print `{ ts: number; value: number }` inline
 * wherever the schema puts one; Rust has to *name* it. So every anonymous object
 * and every inline string enum is hoisted into a real declaration named after
 * the path that reached it (`MetricSeriesPointsItem`), and the generator carries
 * a name table so those hoisted names can never collide with a schema name, a
 * namespace struct, or anything the runtime already declares.
 *
 * The other difference is that there is no compile step here: `cargo` is not a
 * dependency of this repo, so unlike the TypeScript target — which typechecks
 * its own output as part of generating it — the check that this file is correct
 * is `cargo build` in `sdk/rust/`. The emitted `tests/smoke.rs` exists so that
 * check has teeth.
 */
import { readFile } from "node:fs/promises";
import { C_STYLE, docComment, fileBanner, operationDocParts } from "../../emit";
import { pascalCase, snakeCase, uniqueName } from "../../naming";
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

const PACKAGE_NAME = "infrawrench-sdk";
const CLIENT_STRUCT = "APIV1Client";
const RUNTIME_SENTINEL = "// --8<--";

/** rustfmt's `max_width`. Signatures wider than this get one argument per line. */
const MAX_WIDTH = 100;

/**
 * rustfmt's `struct_lit_width`: a struct literal whose body is at most this wide
 * stays on one line, anything longer goes vertical. Matching it here is what
 * lets the emitted crate pass `cargo fmt --check` without the generator having
 * to shell out to rustfmt — which would make a Rust toolchain a build
 * dependency of a TypeScript repo.
 */
const STRUCT_LIT_WIDTH = 18;

/** rustfmt's `attr_fn_like_width`, measured across an attribute's meta list. */
const ATTR_WIDTH = 70;

/** rustfmt's `fn_call_width`, measured across a call's argument list. */
const FN_CALL_WIDTH = 60;

/**
 * Words that cannot be a bare identifier. Most can be written `r#name`; the four
 * in `UNRAWABLE_KEYWORDS` cannot, because they still mean something in raw form,
 * so those get a trailing underscore and a serde rename instead.
 */
const RUST_KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "become",
  "box",
  "break",
  "const",
  "continue",
  "do",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "final",
  "fn",
  "for",
  "gen",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "macro",
  "match",
  "mod",
  "move",
  "mut",
  "override",
  "priv",
  "pub",
  "ref",
  "return",
  "static",
  "struct",
  "trait",
  "true",
  "try",
  "type",
  "typeof",
  "unsafe",
  "unsized",
  "use",
  "virtual",
  "where",
  "while",
  "yield",
]);

const UNRAWABLE_KEYWORDS = new Set(["crate", "self", "Self", "super"]);

/**
 * Type names the emitted crate already uses. A schema whose spec name lands here
 * is declared under a `Model` suffix — `components.schemas.Error` cannot be
 * `Error` next to the crate's own `enum Error`, and a struct called `Ok` sitting
 * next to `Result::Ok` reads like a typo forever after.
 */
const RESERVED_NAMES = new Set([
  // declared by ./runtime.rs
  CLIENT_STRUCT,
  "Accept",
  "ApiError",
  "ClientConfig",
  "Error",
  "FileUpload",
  "FormValue",
  "IntoMultipart",
  "RequestSpec",
  "Transport",
  // imported by ./runtime.rs, so a model of the same name would shadow it
  "Deserialize",
  "DeserializeOwned",
  "Duration",
  "HeaderMap",
  "HeaderName",
  "HeaderValue",
  "Method",
  "Serialize",
  "StatusCode",
  "Url",
  // prelude
  "Box",
  "Clone",
  "Copy",
  "Debug",
  "Default",
  "Drop",
  "Err",
  "Fn",
  "FnMut",
  "FnOnce",
  "HashMap",
  "Into",
  "Iterator",
  "None",
  "Ok",
  "Option",
  "Result",
  "Some",
  "String",
  "ToString",
  "Vec",
]);

const RUST_TYPE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** A field, method or local name: snake_case, escaped if it hits a keyword. */
function valueIdent(name: string): string {
  let base = snakeCase(name);
  if (base === "") base = "value";
  if (/^[0-9]/.test(base)) base = `n${base}`;
  if (UNRAWABLE_KEYWORDS.has(base)) return `${base}_`;
  return RUST_KEYWORDS.has(base) ? `r#${base}` : base;
}

/** What serde sees: the derive strips `r#`, so `r#type` is the field `type`. */
function wireIdent(ident: string): string {
  return ident.startsWith("r#") ? ident.slice(2) : ident;
}

/** An enum variant name. Values are arbitrary strings (`sk-ssh-ed25519@…`). */
function variantIdent(value: string): string {
  const base = pascalCase(value);
  if (base === "") return "Empty";
  return /^[0-9]/.test(base) ? `V${base}` : base;
}

function optionOf(type: string): string {
  return type.startsWith("Option<") ? type : `Option<${type}>`;
}

function stripOption(type: string): string {
  return type.startsWith("Option<") && type.endsWith(">") ? type.slice(7, -1) : type;
}

/**
 * Fenced code in a doc comment is a doctest as far as rustdoc is concerned, and
 * a spec description is not Rust. Downgrade fences to inline code so nothing in
 * the spec can make `cargo test` try to compile prose.
 */
function sanitizeDoc(text: string | undefined): string | undefined {
  return text === undefined ? undefined : text.replace(/```+/g, "`");
}

function doc(parts: Array<string | undefined>, indent: string): string | null {
  return docComment(parts.map(sanitizeDoc), C_STYLE, indent);
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

interface RustField {
  /** Identifier as written, `r#` and all. */
  ident: string;
  /** Wire name, or `""` for a flattened composition field. */
  wire: string;
  /** The type inside the `Option<…>` when `optional`; the whole type otherwise. */
  inner: string;
  optional: boolean;
  flatten: boolean;
  /** `format: binary` — becomes a multipart file part rather than a text field. */
  binary: boolean;
  doc?: string | undefined;
}

interface EnumVariant {
  ident: string;
  value: string;
}

interface UntaggedVariant {
  ident: string;
  type: string;
}

type Decl =
  | { kind: "struct"; name: string; doc?: string | undefined; fields: RustField[] }
  | { kind: "enum"; name: string; doc?: string | undefined; variants: EnumVariant[] }
  | { kind: "untagged"; name: string; doc?: string | undefined; variants: UntaggedVariant[] }
  | { kind: "alias"; name: string; doc?: string | undefined; target: string };

type StructDecl = Extract<Decl, { kind: "struct" }>;

/** Where a hoisted declaration gets its name from, and whether it may take it. */
interface Hint {
  base: string;
  /**
   * True only at the root of a named schema, where the name was reserved up
   * front and this declaration is the thing entitled to it.
   */
  own: boolean;
  doc?: string | undefined;
}

function child(hint: Hint, suffix: string): Hint {
  return { base: `${hint.base}${pascalCase(suffix)}`, own: false };
}

function fieldType(field: RustField): string {
  return field.optional ? optionOf(field.inner) : field.inner;
}

function dedupeIdents(fields: RustField[]): void {
  const seen = new Set<string>();
  for (const field of fields) field.ident = uniqueName(field.ident, seen);
}

// ---------------------------------------------------------------------------
// Name table
// ---------------------------------------------------------------------------

class Registry {
  private readonly taken = new Set(RESERVED_NAMES);
  private readonly schemas = new Map<string, string>();
  /**
   * Schemas whose top-level type is `X | null`. The declaration is emitted for
   * `X` and the nullability re-applied at every `$ref` to it, which keeps
   * `pub type Subscription = Option<Subscription>` from being a thing.
   */
  private readonly nullable = new Set<string>();
  /** Wire property names each schema contributes, for de-duplicating `allOf`. */
  private readonly wireNames = new Map<string, Set<string>>();
  readonly decls: Decl[] = [];
  readonly renamed: Array<{ from: string; to: string }> = [];

  constructor(ir: SdkIr) {
    for (const schema of ir.schemas) {
      const base = RUST_TYPE_IDENT.test(schema.name) ? schema.name : pascalCase(schema.name);
      const candidate = base === "" ? "Schema" : this.taken.has(base) ? `${base}Model` : base;
      const resolved = uniqueName(candidate, this.taken);
      if (resolved !== schema.name) this.renamed.push({ from: schema.name, to: resolved });
      this.schemas.set(schema.name, resolved);
      if (isTopLevelNullable(schema.type)) this.nullable.add(schema.name);
      this.wireNames.set(schema.name, collectWireNames(schema.type));
    }
  }

  /** Reserve a name outside the schema namespace (a namespace or params struct). */
  reserve(base: string): string {
    return uniqueName(base, this.taken);
  }

  /** The declared name of a schema, without any nullability wrapper. */
  schemaName(specName: string): string {
    return this.schemas.get(specName) ?? "serde_json::Value";
  }

  /** How a `$ref` to `specName` prints at a use site. */
  refType(specName: string): string {
    const name = this.schemaName(specName);
    return this.nullable.has(specName) ? `Option<${name}>` : name;
  }

  propertyNames(specName: string): Set<string> {
    return this.wireNames.get(specName) ?? new Set<string>();
  }

  private claim(hint: Hint): string {
    return hint.own ? hint.base : uniqueName(hint.base, this.taken);
  }

  declareStruct(hint: Hint, fields: RustField[]): string {
    const name = this.claim(hint);
    this.decls.push({ kind: "struct", name, doc: hint.doc, fields });
    return name;
  }

  declareEnum(hint: Hint, values: string[]): string {
    const name = this.claim(hint);
    const seen = new Set<string>();
    const variants = values.map((value) => ({
      ident: uniqueName(variantIdent(value), seen),
      value,
    }));
    this.decls.push({ kind: "enum", name, doc: hint.doc, variants });
    return name;
  }

  declareUntagged(hint: Hint, variants: UntaggedVariant[]): string {
    const name = this.claim(hint);
    this.decls.push({ kind: "untagged", name, doc: hint.doc, variants });
    return name;
  }

  declareAlias(name: string, target: string, description: string | undefined): void {
    this.decls.push({ kind: "alias", name, doc: description, target });
  }

  findStruct(name: string): StructDecl | undefined {
    return this.decls.find(
      (decl): decl is StructDecl => decl.kind === "struct" && decl.name === name,
    );
  }
}

// ---------------------------------------------------------------------------
// Type lowering
// ---------------------------------------------------------------------------

function isTopLevelNullable(ref: TypeRef): boolean {
  return ref.kind === "union" && ref.members.some((member) => member.kind === "null");
}

function withoutTopLevelNull(ref: TypeRef): TypeRef {
  if (ref.kind !== "union") return ref;
  const members = ref.members.filter((member) => member.kind !== "null");
  if (members.length === ref.members.length) return ref;
  return members.length === 1 ? members[0]! : { kind: "union", members };
}

/** Every wire property name a type contributes, following `allOf`/`anyOf`. */
function collectWireNames(ref: TypeRef): Set<string> {
  const out = new Set<string>();
  const visit = (node: TypeRef): void => {
    if (node.kind === "object") for (const prop of node.properties) out.add(prop.name);
    if (node.kind === "union" || node.kind === "intersection") node.members.forEach(visit);
  };
  visit(ref);
  return out;
}

/**
 * Does this member of an `allOf`/`anyOf` say anything? `{}` and `unknown` are
 * how zod-to-openapi spells "no further constraint", and folding one in would
 * turn a perfectly good type into `serde_json::Value`.
 */
function carriesInformation(ref: TypeRef): boolean {
  switch (ref.kind) {
    case "null":
    case "unknown":
      return false;
    case "object":
      return ref.properties.length > 0 || ref.additional !== null;
    case "union":
      return ref.members.some(carriesInformation);
    default:
      return true;
  }
}

function admitsNull(ref: TypeRef): boolean {
  if (ref.kind === "null") return true;
  return ref.kind === "union" && ref.members.some((member) => member.kind === "null");
}

function lowerType(ref: TypeRef, hint: Hint, reg: Registry): string {
  switch (ref.kind) {
    case "ref":
      return reg.refType(ref.name);
    case "string":
      return ref.enum ? reg.declareEnum(hint, ref.enum) : "String";
    case "number":
      return ref.integer ? "i64" : "f64";
    case "boolean":
      return "bool";
    case "null":
      return "Option<serde_json::Value>";
    case "unknown":
      return "serde_json::Value";
    case "binary":
      return "FileUpload";
    case "array":
      return `Vec<${lowerType(ref.items, child(hint, "item"), reg)}>`;
    case "object":
      return lowerObject(ref, hint, reg);
    case "union":
      return lowerUnion(ref, hint, reg);
    case "intersection":
      return lowerIntersection(ref, hint, reg);
  }
}

function lowerObject(ref: Extract<TypeRef, { kind: "object" }>, hint: Hint, reg: Registry): string {
  const additional =
    ref.additional === null
      ? null
      : `HashMap<String, ${lowerType(ref.additional, child(hint, "value"), reg)}>`;

  // A dictionary is a map, not a struct. An object with neither properties nor
  // an `additionalProperties` schema constrains nothing, so it stays dynamic.
  if (ref.properties.length === 0) return additional ?? "serde_json::Value";

  const fields = ref.properties.map((prop) => toField(prop, hint, reg));
  if (additional !== null) {
    fields.push({
      ident: "additional",
      wire: "",
      inner: additional,
      optional: false,
      flatten: true,
      binary: false,
      doc: "Properties beyond the ones the spec names.",
    });
  }
  dedupeIdents(fields);
  return reg.declareStruct(hint, fields);
}

function toField(prop: PropertyDef, hint: Hint, reg: Registry): RustField {
  const lowered = lowerType(prop.type, child(hint, prop.name), reg);
  // A property that is required but nullable stays `Option<T>` and is still
  // serialized: sending `null` and omitting the key are different things to a
  // server that declared the key required.
  const optional = !prop.required;
  const description =
    prop.deprecated === true ? `${prop.description ?? ""}\n\nDeprecated.` : prop.description;
  return {
    ident: valueIdent(prop.name),
    wire: prop.name,
    inner: optional ? stripOption(lowered) : lowered,
    optional,
    flatten: false,
    binary: prop.type.kind === "binary",
    doc: description === undefined ? undefined : description.trim(),
  };
}

function lowerUnion(ref: Extract<TypeRef, { kind: "union" }>, hint: Hint, reg: Registry): string {
  const members = ref.members.filter((member) => member.kind !== "null");
  const nullable = members.length !== ref.members.length;
  const wrap = (type: string): string => (nullable ? optionOf(type) : type);

  if (members.length === 0) return "Option<serde_json::Value>";
  // A branch that accepts anything makes every other branch redundant.
  if (members.some((member) => member.kind === "unknown")) return wrap("serde_json::Value");
  // The hint passes through unchanged so `Subscription = { … } | null` names its
  // struct `Subscription` rather than `SubscriptionVariant0`.
  if (members.length === 1) return wrap(lowerType(members[0]!, hint, reg));

  const seen = new Set<string>();
  const variants = members.map((member, index) => ({
    ident: uniqueName(unionVariantIdent(member, index), seen),
    type: lowerType(member, child(hint, `variant${index}`), reg),
  }));
  return wrap(reg.declareUntagged(hint, variants));
}

function unionVariantIdent(member: TypeRef, index: number): string {
  switch (member.kind) {
    case "ref":
      return pascalCase(member.name);
    case "string":
      return "Text";
    case "number":
      return "Number";
    case "boolean":
      return "Boolean";
    case "array":
      return "List";
    case "object":
      return "Object";
    default:
      return `Variant${index}`;
  }
}

/**
 * `allOf` — a composition when every part is an object or a `$ref`, and a
 * refinement otherwise.
 *
 * The composition case becomes one struct that flattens the referenced parts,
 * which is what serde needs to read `{…RoleSummary, permissions}` off a single
 * JSON object. The refinement case (`allOf: [ResourceId, string | null]`, where
 * the second member only restates the first) keeps the first informative member,
 * because merging a scalar into a struct would be nonsense.
 */
function lowerIntersection(
  ref: Extract<TypeRef, { kind: "intersection" }>,
  hint: Hint,
  reg: Registry,
): string {
  const nullable = ref.members.some(admitsNull);
  const members = ref.members.filter(carriesInformation);
  const wrap = (type: string): string => (nullable ? optionOf(type) : type);

  if (members.length === 0) return wrap("serde_json::Value");
  if (members.length === 1) return wrap(lowerType(members[0]!, hint, reg));
  if (!members.every((member) => member.kind === "ref" || member.kind === "object")) {
    return wrap(lowerType(members[0]!, hint, reg));
  }

  // Names the flattened parts already carry. An `allOf` that narrows a property
  // the base already declares (`CreateAccountRequest & { pluginId?: PluginId }`)
  // must not emit that key twice — serde would write it twice on the wire.
  const covered = new Set<string>();
  for (const member of members) {
    if (member.kind === "ref") for (const name of reg.propertyNames(member.name)) covered.add(name);
  }

  const flattened: RustField[] = [];
  const own: RustField[] = [];
  for (const member of members) {
    if (member.kind === "ref") {
      flattened.push({
        ident: valueIdent(member.name),
        wire: "",
        // Deliberately the bare name rather than `refType`: an `allOf` member is
        // a composition, and flattening an `Option` would mean "these fields may
        // all be absent", which is not what the spec said.
        inner: reg.schemaName(member.name),
        optional: false,
        flatten: true,
        binary: false,
        doc: `Everything \`${member.name}\` declares, read from the same JSON object.`,
      });
      continue;
    }
    for (const prop of member.properties) {
      if (covered.has(prop.name)) continue;
      own.push(toField(prop, hint, reg));
    }
  }

  // Everything the inline part said was already said by the referenced part, so
  // the composition is just the reference.
  if (own.length === 0 && flattened.length === 1) return wrap(flattened[0]!.inner);

  const fields = [...flattened, ...own];
  dedupeIdents(fields);
  return wrap(reg.declareStruct(hint, fields));
}

/**
 * Lower one named schema.
 *
 * When the schema's type hoists a declaration, that declaration takes the
 * schema's name and there is nothing more to emit. Otherwise the schema names
 * something Rust can already spell — `ResourceId` is a `String`, `JsonObject` is
 * a map — and becomes a type alias.
 */
function lowerSchema(schema: SchemaDef, reg: Registry): void {
  const name = reg.schemaName(schema.name);
  const nullable = isTopLevelNullable(schema.type);
  const description =
    [
      schema.description,
      name === schema.name ? undefined : `Spec schema: \`${schema.name}\`.`,
      nullable
        ? "The API may send `null` here, so every reference to it is an `Option`."
        : undefined,
    ]
      .filter((part): part is string => part !== undefined && part !== "")
      .join("\n\n") || undefined;

  const lowered = lowerType(
    nullable ? withoutTopLevelNull(schema.type) : schema.type,
    { base: name, own: true, doc: description },
    reg,
  );
  if (lowered !== name) reg.declareAlias(name, lowered, description);
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * A function signature, broken one argument per line when the single-line form
 * would exceed rustfmt's `max_width`.
 */
function signature(indent: string, head: string, args: string[], ret: string): string[] {
  const oneLine = `${indent}${head}(${args.join(", ")})${ret} {`;
  if (oneLine.length <= MAX_WIDTH) return [oneLine];
  return [`${indent}${head}(`, ...args.map((arg) => `${indent}    ${arg},`), `${indent})${ret} {`];
}

/** A struct literal, collapsed onto one line where rustfmt would collapse it. */
function structLiteral(indent: string, name: string, entries: string[]): string[] {
  if (entries.length === 0) return [`${indent}${name} {}`];
  const body = entries.join(", ");
  if (body.length <= STRUCT_LIT_WIDTH) return [`${indent}${name} { ${body} }`];
  return [`${indent}${name} {`, ...entries.map((entry) => `${indent}    ${entry},`), `${indent}}`];
}

function serdeAttribute(field: RustField): string | null {
  const parts: string[] = [];
  if (field.flatten) parts.push("flatten");
  else if (wireIdent(field.ident) !== field.wire) {
    parts.push(`rename = ${JSON.stringify(field.wire)}`);
  }
  // Only genuinely optional fields are skipped — see `toField`.
  if (field.optional) parts.push('skip_serializing_if = "Option::is_none"');
  if (parts.length === 0) return null;
  const body = parts.join(", ");
  // rustfmt's `attr_fn_like_width`: a meta list wider than this goes one item
  // per line, and — unlike an argument list — takes no trailing comma.
  if (body.length <= ATTR_WIDTH) return `    #[serde(${body})]`;
  return ["    #[serde(", `        ${parts.join(",\n        ")}`, "    )]"].join("\n");
}

/**
 * rustfmt's ordering for the items inside a `use` list: names that start
 * lowercase (functions, modules) come before names that start uppercase
 * (types), each group sorted on its own.
 */
function compareImports(a: string, b: string): number {
  const lower = (name: string): number => (/^[a-z_]/.test(name) ? 0 : 1);
  return lower(a) - lower(b) || (a < b ? -1 : a > b ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Model emission
// ---------------------------------------------------------------------------

function fallbackVariantIdent(variants: EnumVariant[]): string {
  const taken = new Set(variants.map((v) => v.ident));
  for (const candidate of ["Other", "Unrecognized", "UnrecognizedValue"]) {
    if (!taken.has(candidate)) return candidate;
  }
  let ident = "UnrecognizedValue";
  while (taken.has(ident)) ident += "_";
  return ident;
}

function emitDecl(decl: Decl): string {
  const lines: string[] = [];
  const header = doc([decl.doc], "");
  if (header) lines.push(header);

  switch (decl.kind) {
    case "alias":
      lines.push(`pub type ${decl.name} = ${decl.target};`);
      break;

    case "struct":
      lines.push("#[derive(Debug, Clone, Serialize, Deserialize)]", `pub struct ${decl.name} {`);
      for (const field of decl.fields) {
        const fieldDoc = doc([field.doc], "    ");
        if (fieldDoc) lines.push(fieldDoc);
        const attribute = serdeAttribute(field);
        if (attribute) lines.push(attribute);
        lines.push(`    pub ${field.ident}: ${fieldType(field)},`);
      }
      lines.push("}");
      break;

    case "enum":
      // `PartialEq`/`Eq` because a closed set of strings is something callers
      // match on and compare.
      lines.push(
        "#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]",
        `pub enum ${decl.name} {`,
      );
      for (const variant of decl.variants) {
        if (variant.ident !== variant.value) {
          lines.push(`    #[serde(rename = ${JSON.stringify(variant.value)})]`);
        }
        lines.push(`    ${variant.ident},`);
      }
      // Without this, one new value on the server turns every response carrying
      // this field into a deserialization error. It has to come last: serde
      // tries the named variants first and only then the untagged fallback.
      // The ident must not collide with a real variant (an enum with a literal
      // "other" member otherwise generates two `Other`s and the crate won't
      // compile); the name is local to each enum, so renaming is safe.
      lines.push(
        "    /// A value this build of the SDK predates — the API grew it after",
        "    /// this crate was generated.",
        "    #[serde(untagged)]",
        `    ${fallbackVariantIdent(decl.variants)}(String),`,
        "}",
      );
      break;

    case "untagged":
      lines.push(
        "#[derive(Debug, Clone, Serialize, Deserialize)]",
        "#[serde(untagged)]",
        `pub enum ${decl.name} {`,
      );
      for (const variant of decl.variants) lines.push(`    ${variant.ident}(${variant.type}),`);
      lines.push("}");
      break;
  }
  return lines.join("\n");
}

/**
 * `IntoMultipart` for the schemas the spec sends as `multipart/form-data`.
 *
 * Generated rather than derived because the field-to-part mapping has to know
 * which field is the file: serde would happily encode the bytes as a JSON array
 * of numbers, which is not what a multipart body is.
 */
function emitMultipart(decl: StructDecl): string {
  const key = (field: RustField): string => JSON.stringify(field.wire || wireIdent(field.ident));
  const entry = (field: RustField, source: string): string =>
    `(${key(field)}.to_owned(), ${field.binary ? `FormValue::File(${source})` : `form_text(&${source})`})`;

  // Fields that are always present seed the vector; only the ones that may be
  // absent need a conditional push. Building the certain ones up front is what
  // `clippy::vec_init_then_push` asks for, and it reads better besides.
  const split = decl.fields.findIndex((field) => field.optional);
  const certain = split === -1 ? decl.fields : decl.fields.slice(0, split);
  const rest = decl.fields.slice(certain.length);

  const seed = certain.map((field) => entry(field, `self.${field.ident}`));
  // With nothing conditional to add, the vector *is* the return value; binding
  // it first would only be a `clippy::let_and_return`.
  const head = rest.length === 0 ? "" : `let mut fields: Vec<(String, FormValue)> = `;
  const tail = rest.length === 0 ? "" : ";";
  const lines: string[] = [
    `impl IntoMultipart for ${decl.name} {`,
    "    fn into_multipart(self) -> Vec<(String, FormValue)> {",
  ];
  if (seed.length === 0) {
    lines.push(`        ${head}Vec::new()${tail}`);
  } else if (seed.join(", ").length <= FN_CALL_WIDTH) {
    // rustfmt's `array_width`, which happens to share `fn_call_width`'s value.
    lines.push(`        ${head}vec![${seed.join(", ")}]${tail}`);
  } else {
    lines.push(
      `        ${head}vec![`,
      ...seed.map((element) => `            ${element},`),
      `        ]${tail}`,
    );
  }

  for (const field of rest) {
    if (field.optional) {
      lines.push(
        `        if let Some(value) = self.${field.ident} {`,
        `            fields.push(${entry(field, "value")});`,
        "        }",
      );
    } else {
      lines.push(`        fields.push(${entry(field, `self.${field.ident}`)});`);
    }
  }
  if (rest.length > 0) lines.push("        fields");
  lines.push("    }", "}");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface OperationPlan {
  op: OperationDef;
  /** `snake_case` method name on the namespace struct. */
  method: string;
  /** `null` when the operation takes nothing at all. */
  paramsType: string | null;
  fields: RustField[];
  pathParams: Array<{ param: ParameterDef; field: RustField }>;
  queryParams: Array<{ param: ParameterDef; field: RustField }>;
  body: { field: RustField; multipart: boolean } | null;
  returnType: string;
  accept: "Json" | "Binary" | "Empty";
}

function parameterDoc(param: ParameterDef, scope: string | null): string | undefined {
  if (!param.defaultable) return param.description;
  const base = param.description ? `${param.description.replace(/\.$/, "")}. ` : "";
  return `${base}Defaults to the \`${valueIdent(scope ?? param.name)}\` the client was configured with.`;
}

function planOperation(op: OperationDef, reg: Registry, ir: SdkIr): OperationPlan {
  const base = [...op.namespace, op.name].map(pascalCase).join("");
  const hint = (suffix: string): Hint => ({ base: `${base}${suffix}`, own: false });

  const fields: RustField[] = [];
  const pathParams: OperationPlan["pathParams"] = [];
  const queryParams: OperationPlan["queryParams"] = [];

  for (const param of op.parameters) {
    const lowered = lowerType(param.type, hint(pascalCase(param.name)), reg);
    // A defaultable path parameter is required on the wire but optional here:
    // the transport fills it in from client configuration.
    const optional = param.defaultable || !param.required;
    const field: RustField = {
      ident: valueIdent(param.name),
      wire: param.name,
      inner: optional ? stripOption(lowered) : lowered,
      optional,
      flatten: false,
      binary: param.type.kind === "binary",
      doc: parameterDoc(param, ir.defaultablePathParam),
    };
    fields.push(field);
    (param.in === "path" ? pathParams : queryParams).push({ param, field });
  }

  let body: OperationPlan["body"] = null;
  if (op.body) {
    const lowered = lowerType(op.body.type, hint("Body"), reg);
    const optional = !op.body.required;
    const field: RustField = {
      ident: "body",
      wire: "body",
      inner: optional ? stripOption(lowered) : lowered,
      optional,
      flatten: false,
      binary: false,
      doc: op.body.encoding === "multipart" ? "Sent as `multipart/form-data`." : undefined,
    };
    fields.push(field);
    body = { field, multipart: op.body.encoding === "multipart" };
  }
  dedupeIdents(fields);

  let returnType: string;
  let accept: OperationPlan["accept"];
  switch (op.response.encoding) {
    case "binary":
      returnType = "Vec<u8>";
      accept = "Binary";
      break;
    case "empty":
      returnType = "()";
      accept = "Empty";
      break;
    case "json":
      returnType = op.response.type
        ? lowerType(op.response.type, hint("Response"), reg)
        : "serde_json::Value";
      accept = "Json";
      break;
  }

  return {
    op,
    method: valueIdent(op.name),
    paramsType: fields.length === 0 ? null : reg.reserve(`${base}Params`),
    fields,
    pathParams,
    queryParams,
    body,
    returnType,
    accept,
  };
}

/** The `…Params` struct, its `new`, and a builder setter per optional field. */
function emitParams(plan: OperationPlan): string {
  const name = plan.paramsType;
  if (name === null) return "";
  const required = plan.fields.filter((field) => !field.optional);
  const optional = plan.fields.filter((field) => field.optional);
  const allOptional = required.length === 0;

  const lines: string[] = [];
  const header = doc(
    [
      `Parameters for \`client.${[...plan.op.namespace.map(valueIdent), plan.method].join("().")}()\`.`,
      allOptional ? undefined : "Required values are arguments to `new`; the rest are setters.",
    ],
    "",
  );
  if (header) lines.push(header);
  lines.push(`#[derive(Debug, Clone${allOptional ? ", Default" : ""})]`, `pub struct ${name} {`);
  for (const field of plan.fields) {
    const fieldDoc = doc([field.doc], "    ");
    if (fieldDoc) lines.push(fieldDoc);
    lines.push(`    pub ${field.ident}: ${fieldType(field)},`);
  }
  lines.push("}", "");

  lines.push(
    `impl ${name} {`,
    ...signature(
      "    ",
      "pub fn new",
      required.map((field) => `${field.ident}: impl Into<${field.inner}>`),
      " -> Self",
    ),
    ...structLiteral(
      "        ",
      "Self",
      plan.fields.map((field) =>
        field.optional ? `${field.ident}: None` : `${field.ident}: ${field.ident}.into()`,
      ),
    ),
    "    }",
  );

  for (const field of optional) {
    const setterDoc = doc([field.doc], "    ");
    lines.push("");
    if (setterDoc) lines.push(setterDoc);
    lines.push(
      ...signature(
        "    ",
        `pub fn ${field.ident}`,
        ["mut self", `value: impl Into<${field.inner}>`],
        " -> Self",
      ),
      `        self.${field.ident} = Some(value.into());`,
      "        self",
      "    }",
    );
  }
  lines.push("}");
  return lines.join("\n");
}

function emitOperation(plan: OperationPlan, indent: string): string {
  const { op } = plan;
  const lines: string[] = [];
  const header = doc(operationDocParts(op), indent);
  if (header) lines.push(header);

  const args = ["&self"];
  if (plan.paramsType !== null) args.push(`params: ${plan.paramsType}`);
  lines.push(
    ...signature(
      indent,
      `pub async fn ${plan.method}`,
      args,
      ` -> Result<${plan.returnType}, Error>`,
    ),
  );

  const inner = `${indent}    `;
  const statements: string[] = [];
  const argument = (field: RustField): string =>
    field.optional ? `params.${field.ident}.as_ref()` : `Some(&params.${field.ident})`;
  for (const { param, field } of plan.pathParams) {
    statements.push(`${inner}spec.path_param(${JSON.stringify(param.name)}, ${argument(field)})?;`);
  }
  for (const { param, field } of plan.queryParams) {
    statements.push(
      `${inner}spec.query_param(${JSON.stringify(param.name)}, ${argument(field)})?;`,
    );
  }
  if (plan.body) {
    const { field, multipart } = plan.body;
    // `json_body` borrows and `multipart_body` consumes, which is why the body
    // is always the last thing read out of `params`.
    const send = multipart ? "spec.multipart_body(value);" : "spec.json_body(&value)?;";
    if (field.optional) {
      statements.push(
        `${inner}if let Some(value) = params.${field.ident} {`,
        `${inner}    ${send}`,
        `${inner}}`,
      );
    } else {
      statements.push(`${inner}let value = params.${field.ident};`, `${inner}${send}`);
    }
  }

  const method = JSON.stringify(op.method.toUpperCase());
  const path = JSON.stringify(op.path);
  const chain = plan.accept === "Json" ? "" : `.accept(Accept::${plan.accept})`;
  const binding = `${inner}${statements.length === 0 ? "let" : "let mut"} spec = `;
  const call = `RequestSpec::new(${method}, ${path})${chain};`;
  // The same retreat rustfmt makes. Arguments wider than `fn_call_width` go
  // vertical outright; otherwise the call stays whole and, if the line is still
  // too long, drops below the `=`.
  const argsFit = `${method}, ${path}`.length <= FN_CALL_WIDTH;
  if (argsFit && `${binding}${call}`.length <= MAX_WIDTH) {
    lines.push(`${binding}${call}`);
  } else if (argsFit && `${inner}    ${call}`.length <= MAX_WIDTH) {
    lines.push(binding.trimEnd(), `${inner}    ${call}`);
  } else {
    lines.push(
      `${binding}RequestSpec::new(`,
      `${inner}    ${method},`,
      `${inner}    ${path},`,
      chain === "" ? `${inner});` : `${inner})`,
      ...(chain === "" ? [] : [`${inner}${chain};`]),
    );
  }
  lines.push(...statements);

  const send = plan.accept === "Binary" ? "bytes" : plan.accept === "Empty" ? "empty" : "json";
  lines.push(`${inner}self.transport.${send}(spec).await`, `${indent}}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/**
 * Emit `node` and every namespace beneath it, children first.
 *
 * Rust has no properties, so `client.accounts.credentials.get(…)` cannot be
 * spelled literally. Two ways to keep the dotted shape:
 *
 *   1. public fields holding a shared handle — `client.accounts.credentials`
 *      reads exactly like the other SDKs, but every one of the ~50 namespace
 *      structs has to be built and stored the moment a client is constructed,
 *      and each needs its own `Arc<Transport>`, because a field cannot borrow
 *      from the struct that owns it;
 *   2. accessor methods returning a borrowing view — one extra `()` per hop.
 *
 * This target takes (2). A namespace is a `&Transport` and nothing else, so
 * `client.accounts().credentials()` allocates nothing, builds nothing until it
 * is called, and the borrow checker guarantees the view cannot outlive the
 * client. The cost is `()`, which Rust callers read as "takes no arguments"
 * rather than as noise.
 */
function emitNamespaces(
  node: NamespaceDef,
  names: Map<string, string>,
  plans: Map<string, OperationPlan>,
): string[] {
  const out: string[] = [];
  for (const branch of node.children.values()) out.push(...emitNamespaces(branch, names, plans));

  const isRoot = node.path.length === 0;
  const struct = names.get(node.path.join("."))!;
  const dotted = (path: string[]): string => path.map((part) => `${valueIdent(part)}()`).join(".");
  const lines: string[] = [];

  if (isRoot) {
    lines.push(
      "/// A client for the Infrawrench API.",
      "///",
      "/// Namespaces hang off accessor methods, mirroring the URL structure:",
      "/// `client.accounts().credentials().get(…)`.",
      `pub struct ${struct} {`,
      "    transport: Transport,",
      "}",
      "",
      `impl ${struct} {`,
      "    /// Build a client. Fails only when the configuration itself is unusable —",
      "    /// a base URL that will not parse, a header name that is not one.",
      "    pub fn new(config: ClientConfig) -> Result<Self, Error> {",
      "        Ok(Self {",
      "            transport: Transport::new(config)?,",
      "        })",
      "    }",
      "",
      "    /// The base URL every call resolves against.",
      "    pub fn base_url(&self) -> &str {",
      "        self.transport.base_url()",
      "    }",
      "",
      "    /// The shared request plumbing. Reach for this only to inspect it.",
      "    pub fn transport(&self) -> &Transport {",
      "        &self.transport",
      "    }",
    );
  } else {
    lines.push(
      `/// \`client.${dotted(node.path)}\``,
      `pub struct ${struct}<'a> {`,
      "    transport: &'a Transport,",
      "}",
      "",
      `impl<'a> ${struct}<'a> {`,
    );
  }

  // The IR already guarantees an operation never shares a name with a child
  // namespace; this only guards the snake_casing on the way out.
  const taken = new Set<string>(isRoot ? ["new", "base_url", "transport"] : []);
  // The root's `impl` already has members, so it needs the separator; an empty
  // one must not open with a blank line.
  let separated = isRoot;
  const separate = (): string[] => (separated ? [""] : ((separated = true), []));

  for (const [key, branch] of node.children) {
    const childStruct = names.get(branch.path.join("."))!;
    lines.push(
      ...separate(),
      `    /// \`client.${dotted(branch.path)}\``,
      `    pub fn ${uniqueName(valueIdent(key), taken)}(&self) -> ${childStruct}<'_> {`,
      ...structLiteral("        ", childStruct, [
        `transport: ${isRoot ? "&self.transport" : "self.transport"}`,
      ]),
      "    }",
    );
  }

  for (const op of node.operations) {
    lines.push(...separate(), emitOperation(plans.get(op.id)!, "    "));
  }

  lines.push("}");
  out.push(lines.join("\n"));
  return out;
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

async function loadRuntime(ir: SdkIr): Promise<string> {
  const source = await readFile(new URL("./runtime.rs", import.meta.url), "utf8");
  const start = source.indexOf(RUNTIME_SENTINEL);
  if (start === -1) {
    throw new Error(`runtime.rs is missing its "${RUNTIME_SENTINEL}" sentinel line`);
  }
  const scope =
    ir.defaultablePathParam === null ? "None" : `Some(${JSON.stringify(ir.defaultablePathParam)})`;
  return source
    .slice(source.indexOf("\n", start) + 1)
    .replace('"@@BASE_URL@@"', JSON.stringify(ir.baseUrl))
    .replace('Some("@@SCOPE_PARAM@@")', scope)
    .trim();
}

/** `use` lines for only the symbols a file actually mentions. */
function imports(body: string, candidates: Array<{ path: string; symbols: string[] }>): string[] {
  const out: string[] = [];
  for (const { path, symbols } of candidates) {
    const used = symbols
      .filter((symbol) => new RegExp(`\\b${symbol}\\b`).test(body))
      .sort(compareImports);
    if (used.length === 0) continue;
    out.push(
      used.length === 1 ? `use ${path}::${used[0]!};` : `use ${path}::{${used.join(", ")}};`,
    );
  }
  return out;
}

function libRs(ir: SdkIr, runtime: string): string {
  const crateName = PACKAGE_NAME.replace(/-/g, "_");
  return `${[
    fileBanner(ir, C_STYLE, PACKAGE_NAME).trimEnd(),
    [
      `//! Generated Rust client for the ${ir.title}.`,
      "//!",
      `//! API version: ${ir.apiVersion}`,
      `//! Default base URL: ${ir.baseUrl}`,
      `//! Operations: ${ir.operations.length}`,
      "//!",
      "//! ```no_run",
      `//! use ${crateName}::{${CLIENT_STRUCT}, AccountsListParams, ClientConfig, Error};`,
      "//!",
      "//! # async fn example() -> Result<(), Error> {",
      `//! let client = ${CLIENT_STRUCT}::new(ClientConfig::new().api_key("iw_…").org_id("org"))?;`,
      "//!",
      "//! match client.accounts().list(AccountsListParams::new()).await {",
      '//!     Ok(accounts) => println!("{} accounts", accounts.len()),',
      '//!     Err(error) => eprintln!("{:?} {error}", error.status()),',
      "//! }",
      "//! # Ok(())",
      "//! # }",
      "//! ```",
    ].join("\n"),
    ["pub mod client;", "pub mod models;", "pub mod params;"].join("\n"),
    [
      "// Re-exported flat so callers can `use infrawrench_sdk::{APIV1Client, Account};`",
      "// without knowing which module a name happens to live in. The generator's name",
      "// table guarantees the three modules never declare the same name twice.",
      "pub use client::*;",
      "pub use models::*;",
      "pub use params::*;",
    ].join("\n"),
    runtime,
    [
      "/// Render a value as a `multipart/form-data` text field. Used only by the",
      "/// generated `IntoMultipart` impls.",
      "pub fn form_text<T: Serialize>(value: &T) -> FormValue {",
      "    let rendered = serde_json::to_value(value)",
      "        .ok()",
      "        .and_then(|value| scalar_to_string(&value))",
      "        .unwrap_or_default();",
      "    FormValue::Text(rendered)",
      "}",
    ].join("\n"),
  ].join("\n\n")}\n`;
}

function moduleFile(
  ir: SdkIr,
  header: string[],
  useCandidates: Array<{ path: string; symbols: string[] }>,
  sections: string[],
): string {
  const body = sections.join("\n\n");
  const use = imports(body, useCandidates);
  return `${[
    fileBanner(ir, C_STYLE, PACKAGE_NAME).trimEnd(),
    header.join("\n"),
    ...(use.length > 0 ? [use.join("\n")] : []),
    body,
  ].join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Package files
// ---------------------------------------------------------------------------

function cargoToml(ir: SdkIr): string {
  const authors = [AUTHOR, ...CONTRIBUTORS].map((person) => `${person.name} <${person.email}>`);
  // Cargo allows at most five keywords, each at most twenty characters.
  const keywords = KEYWORDS.filter((keyword) => keyword.length <= 20).slice(0, 5);
  const quote = (value: string): string => JSON.stringify(value);
  const list = (values: readonly string[]): string => `[${values.map(quote).join(", ")}]`;

  return `[package]
name = ${quote(PACKAGE_NAME)}
version = ${quote(ir.apiVersion)}
edition = "2021"
rust-version = "1.70"
description = ${quote(`Generated Rust client for the ${ir.title} (v${ir.apiVersion}).`)}
authors = ${list(authors)}
# ${LICENSE}, not the BUSL-1.1 the generator itself is under — see LICENSE.
license = ${quote(LICENSE)}
repository = ${quote(REPOSITORY_URL)}
homepage = ${quote(HOMEPAGE)}
documentation = ${quote(`https://docs.rs/${PACKAGE_NAME}`)}
readme = "README.md"
keywords = ${list(keywords)}
categories = ["api-bindings", "web-programming::http-client"]
include = ["src/**/*.rs", "tests/**/*.rs", "Cargo.toml", "README.md", "LICENSE"]

[dependencies]
# Rust ships no HTTP client, so this is the one unavoidable dependency. Async
# rather than blocking: \`reqwest::blocking\` spins up its own runtime and panics
# outright when called from inside an existing one, which would make this crate
# unusable from any async program — the common case for something that talks to
# an HTTP API. A caller who wants blocking calls can drive these on a runtime of
# their own; a caller who wants async cannot unwrap a blocking client.
#
# rustls rather than the default native-tls: no OpenSSL headers to find at build
# time, which is the difference between this crate building everywhere and this
# crate building wherever someone remembered to install libssl-dev.
reqwest = { version = "0.12", default-features = false, features = [
    "charset",
    "http2",
    "json",
    "multipart",
    "rustls-tls",
] }
serde = { version = "1.0.190", features = ["derive"] }
serde_json = "1.0.108"

[dev-dependencies]
# Only \`tests/smoke.rs\` needs a runtime; consumers bring their own.
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
`;
}

function readme(ir: SdkIr): string {
  const crateName = PACKAGE_NAME.replace(/-/g, "_");
  return `# ${PACKAGE_NAME}

Generated Rust client for the ${ir.title} (API version \`${ir.apiVersion}\`).

**Do not edit this crate by hand** — it is regenerated from \`openapi.json\` and is
not checked into the repository. Run
\`pnpm --filter @infrawrench/web generate:sdk\` to rebuild it; the generator lives
in [\`${GENERATOR_PATH}\`](${REPOSITORY_URL}/tree/main/${GENERATOR_PATH}).

## Usage

\`\`\`rust
use ${crateName}::{${CLIENT_STRUCT}, AccountsListParams, ClientConfig, Error};

#[tokio::main]
async fn main() -> Result<(), Error> {
    let client = ${CLIENT_STRUCT}::new(
        ClientConfig::new()
            .api_key(std::env::var("INFRAWRENCH_API_KEY").unwrap())
            .org_id(std::env::var("INFRAWRENCH_ORG_ID").unwrap()),
    )?;

    for account in client.accounts().list(AccountsListParams::new()).await? {
        println!("{} ({})", account.display_name, account.plugin_id);
    }
    Ok(())
}
\`\`\`

Calls are namespaced to mirror the URL structure, so
\`POST /api/org/{orgId}/accounts/{id}/sync\` is \`client.accounts().sync(…)\`. Each
hop is a method rather than a field because a Rust struct field cannot borrow
from the struct that owns it — \`client.accounts()\` hands back a view that
borrows the client's transport, which allocates nothing and cannot outlive it.

Every operation takes one \`…Params\` struct. Required values are arguments to
\`new\`; optional ones — including \`org_id\` — are builder setters:

\`\`\`rust
client
    .accounts()
    .resources(AccountsResourcesParams::new("account-id").org_id("another-org"))
    .await?;
\`\`\`

Set \`org_id\` once on the \`ClientConfig\` and every org-scoped call can leave it
off; set it on an individual call to override it. Leave it off both and the call
returns \`Error::MissingPathParam\` before anything is sent.

## Errors

Nothing panics on a network or API failure — everything returns
\`Result<T, Error>\`. A non-2xx response is \`Error::Api(ApiError)\`, which carries
the HTTP \`status\`, the parsed \`body\`, and the machine-readable \`code\` when the
API sends one. Branch on \`code\`, not on the message:

\`\`\`rust
match client.accounts().list(AccountsListParams::new()).await {
    Ok(accounts) => println!("{} accounts", accounts.len()),
    Err(error) if error.code() == Some("reauthentication_required") => { /* step up */ }
    Err(error) => eprintln!("{error}"),
}
\`\`\`

## Forward compatibility

Enumerated string fields deserialize an unrecognized value into an untagged
fallback variant — \`Other(String)\`, or \`Unrecognized(String)\` where the enum
has a real \`Other\` member — instead of failing, so a value the API adds after
this crate was generated does not break calls that never look at it.

## Scope

This crate covers the published API surface only. Operations marked
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

export const rustTarget: SdkTarget = {
  id: "rust",
  displayName: "Rust",
  packageName: PACKAGE_NAME,
  artifacts: [
    "Cargo.toml",
    "src/lib.rs",
    "src/models.rs",
    "src/params.rs",
    "src/client.rs",
    "tests/smoke.rs",
    "README.md",
    "LICENSE",
  ],

  async generate(ir: SdkIr, ctx: TargetContext): Promise<void> {
    const reg = new Registry(ir);

    // Namespace struct names are reserved before anything is hoisted, so a
    // hoisted inline type can never take a name a namespace is going to need.
    const namespaceNames = new Map<string, string>();
    const registerNamespaces = (node: NamespaceDef): void => {
      namespaceNames.set(
        node.path.join("."),
        node.path.length === 0
          ? CLIENT_STRUCT
          : reg.reserve(`${node.path.map(pascalCase).join("")}Namespace`),
      );
      for (const branch of node.children.values()) registerNamespaces(branch);
    };
    registerNamespaces(ir.root);

    for (const schema of ir.schemas) lowerSchema(schema, reg);

    const plans = new Map<string, OperationPlan>();
    for (const op of ir.operations) plans.set(op.id, planOperation(op, reg, ir));

    // Which structs need an `IntoMultipart` impl. Resolved after planning, so
    // the body type has already been lowered to whatever it ends up being.
    const multipart = new Set<string>();
    for (const plan of plans.values()) {
      if (plan.body?.multipart !== true) continue;
      const name = stripOption(plan.body.field.inner);
      if (reg.findStruct(name) === undefined) {
        throw new Error(
          `${plan.op.method.toUpperCase()} ${plan.op.path} sends multipart/form-data, but its ` +
            `body lowered to \`${name}\`, which is not a struct this generator can turn into ` +
            "form fields.",
        );
      }
      multipart.add(name);
    }

    const modelSections = reg.decls.map(emitDecl);
    for (const name of multipart) modelSections.push(emitMultipart(reg.findStruct(name)!));

    await ctx.write("src/lib.rs", libRs(ir, await loadRuntime(ir)));
    await ctx.write(
      "src/models.rs",
      moduleFile(
        ir,
        [
          "//! Every type the API sends or receives.",
          "//!",
          "//! Rust has no structural types, so the inline shapes the spec nests inside",
          "//! its schemas are hoisted into named declarations here, each named after",
          "//! the path that reached it.",
        ],
        [
          { path: "crate", symbols: ["FileUpload", "FormValue", "IntoMultipart", "form_text"] },
          { path: "serde", symbols: ["Deserialize", "Serialize"] },
          { path: "std::collections", symbols: ["HashMap"] },
        ],
        modelSections,
      ),
    );
    await ctx.write(
      "src/params.rs",
      moduleFile(
        ir,
        [
          "//! One struct per operation, holding its path parameters, query parameters",
          "//! and request body.",
          "//!",
          "//! Required values are arguments to `new`; everything optional — including",
          "//! the org id, which the client can supply — is a builder setter.",
          "#[allow(unused_imports)]",
          "use crate::models::*;",
        ],
        [
          { path: "crate", symbols: ["FileUpload"] },
          { path: "std::collections", symbols: ["HashMap"] },
        ],
        [...plans.values()].map(emitParams).filter((section) => section !== ""),
      ),
    );
    await ctx.write(
      "src/client.rs",
      moduleFile(
        ir,
        [
          "//! The dotted call tree.",
          "//!",
          "//! One struct per namespace, each borrowing the client's transport, plus",
          "//! `APIV1Client` at the root.",
          "#[allow(unused_imports)]",
          "use crate::models::*;",
          "#[allow(unused_imports)]",
          "use crate::params::*;",
        ],
        [
          {
            path: "crate",
            symbols: ["Accept", "ClientConfig", "Error", "FileUpload", "RequestSpec", "Transport"],
          },
          { path: "std::collections", symbols: ["HashMap"] },
        ],
        emitNamespaces(ir.root, namespaceNames, plans),
      ),
    );
    await ctx.write(
      "tests/smoke.rs",
      await readFile(new URL("./tests.rs", import.meta.url), "utf8"),
    );
    await ctx.write("Cargo.toml", cargoToml(ir));
    await ctx.write("README.md", readme(ir));
    // MIT requires the license text and copyright notice to travel with every
    // copy, so this is an artifact, not a nicety.
    await ctx.write("LICENSE", LICENSE_TEXT);

    for (const { from, to } of reg.renamed) {
      ctx.log(`  renamed schema ${from} → ${to} (collides with a reserved name)`);
    }
    ctx.log(
      `  ${reg.decls.length} declarations, ${plans.size} operations, ` +
        `${namespaceNames.size - 1} namespaces`,
    );
  },
};
