/**
 * The Go SDK target.
 *
 * Emits an importable module — `github.com/Infrawrench/infrawrench-go` — split
 * into three source files:
 *
 *   1. `client.go`, the hand-written request plumbing from `./runtime.go.txt`,
 *   2. `models.go`, one declaration per `components.schemas` entry plus every
 *      struct hoisted out of an inline object,
 *   3. `api.go`, one struct per namespace in the dotted call tree, bottomed out
 *      by `APIV1Client`.
 *
 * Two things drive most of the decisions here.
 *
 * **Go has no optional.** A zero value is indistinguishable from an absent one,
 * so anything the wire may omit or null is a pointer — see `fieldType`. That is
 * the difference between being able to send `enabled: false` and not being able
 * to say it at all.
 *
 * **Go has no sum type.** `anyOf` collapses to a single Go type when every
 * branch lowers to the same one and to `any` otherwise; `allOf` is flattened
 * into one struct rather than embedded, because embedding promotes fields and
 * two members with the same field name would silently drop both from the JSON
 * encoding.
 *
 * The output is emitted already gofmt-clean rather than piped through gofmt:
 * `alignRows` reproduces the column padding gofmt's tabwriter would apply, so a
 * layout bug fails `gofmt -l` here instead of being papered over at build time.
 */
import { readFile } from "node:fs/promises";
import { type CommentStyle, docComment, fileBanner, operationDocParts } from "../../emit";
import { uniqueName, words } from "../../naming";
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
  HttpMethod,
  NamespaceDef,
  OperationDef,
  PropertyDef,
  SchemaDef,
  SdkIr,
  TypeRef,
} from "../../types";

const MODULE_PATH = "github.com/Infrawrench/infrawrench-go";
const PACKAGE_NAME = "infrawrench";
const CLIENT_TYPE = "APIV1Client";
const CLIENT_CONSTRUCTOR = `New${CLIENT_TYPE}`;

/**
 * The language version in `go.mod`, not a toolchain pin: a client library has no
 * business forcing a patch release on anyone. Raise it only when the emitted
 * code starts using something newer.
 */
const GO_VERSION = "1.24";

const RUNTIME_SENTINEL = "// --8<--";

/** Go has no block comment convention worth using; everything is `//`. */
const GO_COMMENT: CommentStyle = { line: "//" };

const HTTP_METHOD_CONSTANT: Record<HttpMethod, string> = {
  get: "http.MethodGet",
  post: "http.MethodPost",
  put: "http.MethodPut",
  patch: "http.MethodPatch",
  delete: "http.MethodDelete",
};

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * Words Go spells in full caps. `go vet` does not enforce this, but every Go
 * reviewer does, and `OrgId` next to `URL` in the same struct reads as a bug.
 */
const INITIALISMS = new Set([
  "acl",
  "api",
  "ascii",
  "aws",
  "cpu",
  "css",
  "db",
  "dns",
  "eof",
  "gcp",
  "guid",
  "html",
  "http",
  "https",
  "id",
  "ip",
  "json",
  "kv",
  "mfa",
  "otp",
  "ovh",
  "ram",
  "rpc",
  "sftp",
  "smtp",
  "sql",
  "ssh",
  "ssl",
  "tcp",
  "tls",
  "totp",
  "ttl",
  "udp",
  "ui",
  "uid",
  "uri",
  "url",
  "utf8",
  "uuid",
  "vm",
  "xml",
  "yaml",
]);

/** Words whose Go spelling is neither title case nor all caps. */
const WORD_OVERRIDES = new Map([
  ["ids", "IDs"],
  ["nosql", "NoSQL"],
  ["oauth", "OAuth"],
  ["ok", "OK"],
]);

function goWord(word: string): string {
  const lower = word.toLowerCase();
  const override = WORD_OVERRIDES.get(lower);
  if (override !== undefined) return override;
  if (INITIALISMS.has(lower)) return lower.toUpperCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** `sshKeyId` → `SSHKeyID`. Every generated identifier is exported. */
function exported(name: string): string {
  return words(name).map(goWord).join("");
}

/**
 * Identifiers the emitted package already spends.
 *
 * The predeclared identifiers are all lower-case and so unreachable from
 * `exported`, but a hoisted name is built from spec text that nobody vetted, so
 * they are reserved rather than assumed safe.
 */
const RESERVED_NAMES = new Set([
  // declared by client.go
  "APIError",
  "APIVersion",
  "AsAPIError",
  "ClientOption",
  "DefaultBaseURL",
  "ErrMissingPathParam",
  "RequestOption",
  "WithAPIKey",
  "WithBaseURL",
  "WithHTTPClient",
  "WithHeader",
  "WithQueryParam",
  "WithRequestHeader",
  "WithUserAgent",
  CLIENT_TYPE,
  CLIENT_CONSTRUCTOR,
  // predeclared
  "any",
  "append",
  "bool",
  "byte",
  "cap",
  "clear",
  "close",
  "comparable",
  "complex",
  "complex64",
  "complex128",
  "copy",
  "delete",
  "error",
  "false",
  "float32",
  "float64",
  "imag",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "iota",
  "len",
  "make",
  "max",
  "min",
  "new",
  "nil",
  "panic",
  "print",
  "println",
  "real",
  "recover",
  "rune",
  "string",
  "true",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uintptr",
]);

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** A declaration line: either aligned cells, or something that breaks a run. */
type Row = { cells: string[] } | { raw: string };

/**
 * Lay out rows the way gofmt would.
 *
 * gofmt prints declarations through a tabwriter configured with space padding
 * and a padding of one, so within a run of consecutive multi-cell lines every
 * column but the last is widened to its longest cell plus a space. A comment or
 * a blank line has fewer cells and therefore ends the run — which is why a
 * struct where only some fields are documented gets several alignment groups.
 */
function alignRows(rows: Row[], indent: string): string[] {
  const out: string[] = [];
  let run: string[][] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const widths: number[] = [];
    for (const cells of run) {
      for (let i = 0; i < cells.length - 1; i++) {
        widths[i] = Math.max(widths[i] ?? 0, cells[i]!.length + 1);
      }
    }
    for (const cells of run) {
      const line = cells
        .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join("");
      out.push(`${indent}${line}`);
    }
    run = [];
  };

  for (const row of rows) {
    if ("raw" in row) {
      flush();
      out.push(row.raw === "" ? "" : `${indent}${row.raw}`);
      continue;
    }
    run.push(row.cells);
  }
  flush();
  return out;
}

/** A wrapped line that would read as a list item or heading to `go/doc`. */
const DOC_MARKER = /^(?:[-*+•]|#{1,6}|\d+[.)])(?:\s|$)/;

/**
 * A Go doc comment, as lines.
 *
 * gofmt reformats doc comments: a line opening with `-`, `#` or `1.` is a list
 * item or a heading and gets re-indented and spaced out. Spec prose contains
 * plenty of stray hyphens, and one landing on a line break would leave the file
 * failing `gofmt -l`. Rejoining such a line with the one above it keeps the
 * prose byte-for-byte and the marker away from column zero.
 */
function goDoc(parts: Array<string | undefined>, width = 78): string[] {
  const rendered = docComment(parts, GO_COMMENT, "", width);
  if (rendered === null) return [];
  const out: string[] = [];
  for (const line of rendered.split("\n")) {
    const text = line.startsWith("// ") ? line.slice(3) : "";
    const previous = out[out.length - 1];
    if (DOC_MARKER.test(text) && previous !== undefined && previous !== "//") {
      out[out.length - 1] = `${previous} ${text}`;
      continue;
    }
    out.push(line);
  }
  return out;
}

/** Go string literals and JSON string literals agree on everything we emit. */
function quote(value: string): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GoType {
  /** How the type is spelled, without any pointer indirection. */
  text: string;
  /**
   * The spelling an alias stands for, so `ResourceID` compares equal to
   * `string` when deciding whether a union's branches agree.
   */
  underlying: string;
  /** True when the spelling already has a nil value: slice, map, `any`. */
  nilable: boolean;
  /** True when the wire value may be JSON null. */
  nullable: boolean;
}

const ANY_TYPE: GoType = { text: "any", underlying: "any", nilable: true, nullable: false };

function scalarType(text: string): GoType {
  return { text, underlying: text, nilable: false, nullable: false };
}

function nilableType(text: string): GoType {
  return { text, underlying: text, nilable: true, nullable: false };
}

/**
 * `allOf` branches that carry no information: a bare `{}` (which is what
 * `.and()` on an open object produces) and an unconstrained branch. Dropping
 * them is what turns `AgentSettings & {}` back into plain `AgentSettings`
 * instead of a pointless one-field struct.
 */
function informativeMembers(members: TypeRef[]): TypeRef[] {
  return members.filter(
    (member) =>
      member.kind !== "unknown" &&
      !(member.kind === "object" && member.properties.length === 0 && member.additional === null),
  );
}

/** The enum a type pins, looking through a nullable wrapper. */
function stringEnum(type: TypeRef): string[] | null {
  if (type.kind === "string") return type.enum ?? null;
  if (type.kind === "union") {
    const rest = type.members.filter((member) => member.kind !== "null");
    return rest.length === 1 ? stringEnum(rest[0]!) : null;
  }
  return null;
}

interface HoistedStruct {
  name: string;
  doc: Array<string | undefined>;
  properties: PropertyDef[];
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

class GoEmitter {
  private readonly ir: SdkIr;
  private readonly log: (message: string) => void;
  private readonly taken = new Set(RESERVED_NAMES);
  private readonly schemas = new Map<string, SchemaDef>();
  private readonly schemaNames = new Map<string, string>();
  /** Schemas that become `type X struct`; every other schema becomes an alias. */
  private readonly structSchemas = new Set<string>();
  /** Schemas whose value may be null, so a field referencing one gets a pointer. */
  private readonly nullableSchemas = new Set<string>();
  /** Structs discovered while printing inline objects, emitted after the schemas. */
  private readonly hoisted: HoistedStruct[] = [];

  constructor(ir: SdkIr, log: (message: string) => void) {
    this.ir = ir;
    this.log = log;

    for (const schema of ir.schemas) {
      this.schemas.set(schema.name, schema);
      if (schema.type.kind === "union" && schema.type.members.some((m) => m.kind === "null")) {
        this.nullableSchemas.add(schema.name);
      }
    }
    for (const schema of ir.schemas) {
      if (this.isStruct(schema.type)) this.structSchemas.add(schema.name);
    }
    // Schemas claim their names before anything generated does, so the Go
    // spelling of a spec name survives unless the runtime already spends it.
    // Re-casing (`SshKey` → `SSHKey`) is expected and silent; a suffix is not,
    // because it means the package grew a name nobody would guess.
    for (const schema of ir.schemas) {
      const wanted = exported(schema.name) || "Schema";
      const resolved = uniqueName(wanted, this.taken);
      if (resolved !== wanted) {
        this.log(`  ! schema ${schema.name} wanted ${wanted}, which is taken — using ${resolved}`);
      }
      this.schemaNames.set(schema.name, resolved);
    }
  }

  // -- classification ------------------------------------------------------

  /** Whether a schema is worth declaring as a struct rather than an alias. */
  private isStruct(type: TypeRef): boolean {
    switch (type.kind) {
      case "object":
        return type.properties.length > 0;
      case "union": {
        const rest = type.members.filter((member) => member.kind !== "null");
        return rest.length === 1 && this.isStruct(rest[0]!);
      }
      case "intersection":
        return this.flatten(type) !== null;
      default:
        return false;
    }
  }

  /**
   * The property list an `allOf` collapses to, or null when it does not.
   *
   * Merging beats embedding here. Go promotes an embedded struct's fields, so
   * `A & B` with a field name in common compiles but marshals neither — a
   * silent wire bug. Copying the properties makes the collision visible to
   * `uniqueName` instead.
   */
  private flatten(type: TypeRef, seen: ReadonlySet<string> = new Set()): PropertyDef[] | null {
    switch (type.kind) {
      case "object":
        return type.properties.length > 0 ? type.properties : null;
      case "ref": {
        const schema = this.schemas.get(type.name);
        if (!schema || seen.has(type.name)) return null;
        return this.flatten(schema.type, new Set([...seen, type.name]));
      }
      case "union": {
        const rest = type.members.filter((member) => member.kind !== "null");
        return rest.length === 1 ? this.flatten(rest[0]!, seen) : null;
      }
      case "intersection": {
        const members = informativeMembers(type.members);
        if (members.length === 0) return null;
        const merged = new Map<string, PropertyDef>();
        for (const member of members) {
          const properties = this.flatten(member, seen);
          if (properties === null) return null;
          for (const property of properties) merged.set(property.name, property);
        }
        return merged.size > 0 ? [...merged.values()] : null;
      }
      default:
        return null;
    }
  }

  /**
   * The Go spelling a type reduces to, or null when answering would mean
   * inventing a struct.
   *
   * This exists so a union can be judged *before* its branches are printed:
   * printing them would hoist a named struct for every object branch, and a
   * union that collapses to `any` throws all but one away. A dead exported type
   * in the package is worse than the extra pass.
   */
  private underlyingOf(type: TypeRef, seen: ReadonlySet<string> = new Set()): string | null {
    switch (type.kind) {
      case "ref": {
        const name = this.schemaNames.get(type.name);
        if (name === undefined) return null;
        if (this.structSchemas.has(type.name)) return name;
        const schema = this.schemas.get(type.name);
        if (!schema || seen.has(type.name)) return null;
        return this.underlyingOf(schema.type, new Set([...seen, type.name]));
      }
      case "string":
        return "string";
      case "number":
        return type.integer ? "int64" : "float64";
      case "boolean":
        return "bool";
      case "null":
      case "unknown":
        return "any";
      case "binary":
        return "io.Reader";
      case "array": {
        const items = this.underlyingOf(type.items, seen);
        return items === null ? null : `[]${items}`;
      }
      case "object": {
        if (type.properties.length > 0) return null;
        const value = type.additional ? this.underlyingOf(type.additional, seen) : "any";
        return value === null ? null : `map[string]${value}`;
      }
      case "union":
      case "intersection": {
        const members =
          type.kind === "union"
            ? type.members.filter((member) => member.kind !== "null")
            : informativeMembers(type.members);
        if (members.length === 0) return "any";
        const keys = members.map((member) => this.underlyingOf(member, seen));
        const first = keys[0];
        return first !== null && first !== undefined && keys.every((key) => key === first)
          ? first
          : null;
      }
    }
  }

  // -- type printing -------------------------------------------------------

  private resolve(type: TypeRef, hint: string): GoType {
    switch (type.kind) {
      case "ref":
        return this.resolveRef(type.name);
      case "string":
        return scalarType("string");
      case "number":
        return scalarType(type.integer ? "int64" : "float64");
      case "boolean":
        return scalarType("bool");
      case "null":
        return { ...ANY_TYPE, nullable: true };
      case "unknown":
        return ANY_TYPE;
      // `format: binary` is a file. Requests take one as a stream so a caller
      // can hand over an *os.File without reading it into memory first;
      // responses are handled by the operation, which returns io.ReadCloser.
      case "binary":
        return nilableType("io.Reader");
      case "array": {
        const items = this.resolve(type.items, hint);
        return nilableType(`[]${this.fieldType(items, true)}`);
      }
      case "object": {
        if (type.properties.length === 0) {
          const value = type.additional ? this.resolve(type.additional, `${hint}Value`) : ANY_TYPE;
          return nilableType(`map[string]${this.fieldType(value, true)}`);
        }
        return this.hoist(hint, type.properties, []);
      }
      case "union":
        return this.resolveUnion(type, hint);
      case "intersection":
        return this.resolveIntersection(type, hint);
    }
  }

  private resolveRef(specName: string): GoType {
    const name = this.schemaNames.get(specName);
    const schema = this.schemas.get(specName);
    if (name === undefined || schema === undefined) return ANY_TYPE;
    const nullable = this.nullableSchemas.has(specName);
    if (this.structSchemas.has(specName)) {
      return { text: name, underlying: name, nilable: false, nullable };
    }
    // An alias is transparent, so it inherits whether the thing it aliases has
    // a nil value: `map[string]any` needs no pointer, `string` does.
    const underlying = this.underlyingOf(schema.type) ?? "any";
    return { text: name, underlying, nilable: isNilable(underlying), nullable };
  }

  private resolveUnion(type: Extract<TypeRef, { kind: "union" }>, hint: string): GoType {
    const nullable = type.members.some((member) => member.kind === "null");
    const rest = type.members.filter((member) => member.kind !== "null");
    if (rest.length === 0) return { ...ANY_TYPE, nullable: true };
    if (rest.length === 1) {
      const only = this.resolve(rest[0]!, hint);
      return { ...only, nullable: only.nullable || nullable };
    }
    // Every branch has to lower to the same Go type for the union to survive as
    // anything more specific than `any`; `string | number` genuinely is `any`.
    if (this.underlyingOf(type) === null) return { ...ANY_TYPE, nullable: true };
    const first = this.resolve(rest[0]!, hint);
    return { ...first, nullable: first.nullable || nullable };
  }

  private resolveIntersection(
    type: Extract<TypeRef, { kind: "intersection" }>,
    hint: string,
  ): GoType {
    const members = informativeMembers(type.members);
    if (members.length === 0) return ANY_TYPE;
    if (members.length === 1) return this.resolve(members[0]!, hint);

    const merged = this.flatten(type);
    if (merged !== null) return this.hoist(hint, merged, []);

    // Not an object intersection, so it is a scalar narrowed by a second
    // branch — `ResourceId & (string | null)`. Both agree on the Go type; the
    // second branch only contributes nullability.
    if (this.underlyingOf(type) === null) return ANY_TYPE;
    const resolved = members.map((member) => this.resolve(member, hint));
    return { ...resolved[0]!, nullable: resolved.some((member) => member.nullable) };
  }

  /**
   * Whether a value needs a pointer.
   *
   * This is the one decision Go forces that TypeScript does not. `omitempty`
   * alone cannot express optionality: it drops `false`, `0` and `""` on the way
   * out, so a caller could never turn a flag off or set a count to zero. A
   * pointer separates "absent" from "present and zero" at the cost of one
   * dereference, which is the right trade for a wire format. Slices, maps and
   * `any` already have a nil, so they are left alone.
   */
  private fieldType(type: GoType, required: boolean): string {
    return !type.nilable && (type.nullable || !required) ? `*${type.text}` : type.text;
  }

  private hoist(hint: string, properties: PropertyDef[], doc: Array<string | undefined>): GoType {
    const name = uniqueName(exported(hint) || "Struct", this.taken);
    this.hoisted.push({ name, doc, properties });
    return { text: name, underlying: name, nilable: false, nullable: false };
  }

  // -- declarations --------------------------------------------------------

  private structDecl(
    name: string,
    doc: Array<string | undefined>,
    properties: PropertyDef[],
    tagged: boolean,
  ): string[] {
    const rows: Row[] = [];
    const taken = new Set<string>();
    for (const property of properties) {
      const fieldName = uniqueName(exported(property.name) || "Field", taken);
      const type = this.resolve(property.type, `${name}${fieldName}`);
      const notes: string[] = [];
      if (property.description) notes.push(property.description);
      const values = stringEnum(property.type);
      if (values) notes.push(`One of ${values.map(quote).join(", ")}.`);
      if (property.deprecated === true) notes.push("Deprecated.");
      if (notes.length > 0) {
        for (const line of goDoc([`${fieldName}: ${notes[0]!}`, ...notes.slice(1)], 74)) {
          rows.push({ raw: line });
        }
      }
      const cells = [fieldName, this.fieldType(type, property.required)];
      if (tagged) {
        cells.push(`\`json:"${property.name}${property.required ? "" : ",omitempty"}"\``);
      }
      rows.push({ cells });
    }
    if (rows.length === 0) return [...goDoc(doc), `type ${name} struct{}`];
    return [...goDoc(doc), `type ${name} struct {`, ...alignRows(rows, "\t"), "}"];
  }

  /** The properties a struct-shaped schema declares, looking through wrappers. */
  private structProperties(type: TypeRef): PropertyDef[] {
    switch (type.kind) {
      case "object":
        return type.properties;
      case "union": {
        const rest = type.members.filter((member) => member.kind !== "null");
        return rest.length === 1 ? this.structProperties(rest[0]!) : [];
      }
      case "intersection":
        return this.flatten(type) ?? [];
      default:
        return [];
    }
  }

  private schemaDecl(schema: SchemaDef): string[] {
    const name = this.schemaNames.get(schema.name)!;
    const doc: Array<string | undefined> = [
      schema.description
        ? `${name}: ${schema.description}`
        : `${name} is the \`${schema.name}\` schema.`,
      name === schema.name ? undefined : `Spec schema: \`${schema.name}\`.`,
      this.nullableSchemas.has(schema.name) ? "The API may send null in its place." : undefined,
    ];

    if (this.structSchemas.has(schema.name)) {
      return this.structDecl(name, doc, this.structProperties(schema.type), true);
    }

    // Everything else is an alias rather than a defined type. `type PluginID =
    // string` keeps a plain string assignable to it, which matters because most
    // of these are ids a caller reads out of the environment; a defined type
    // would demand a conversion at every call site for no safety a spec-derived
    // enum can actually enforce.
    const alias = this.resolve(schema.type, name);
    const lines = [...goDoc(doc), `type ${name} = ${alias.text}`];
    const values = stringEnum(schema.type);
    if (values && values.length > 0) lines.push("", ...this.enumConsts(name, values));
    return lines;
  }

  private enumConsts(typeName: string, values: string[]): string[] {
    const rows: Row[] = values.map((value) => ({
      cells: [
        uniqueName(`${typeName}${exported(value) || "Value"}`, this.taken),
        typeName,
        `= ${quote(value)}`,
      ],
    }));
    return [`// The values ${typeName} takes.`, "const (", ...alignRows(rows, "\t"), ")"];
  }

  // -- operations ----------------------------------------------------------

  private namespaceType(path: string[]): string {
    return path.length === 0 ? CLIENT_TYPE : `${path.map(exported).join("")}Namespace`;
  }

  /**
   * One namespace: its struct, its constructor, and its calls.
   *
   * Children are wired up with statements rather than a composite literal on
   * purpose — gofmt aligns the values in a keyed literal, and reproducing that
   * alignment for a construct with no other reason to exist is not worth it.
   */
  private namespaceDecls(node: NamespaceDef): string[] {
    const isRoot = node.path.length === 0;
    const typeName = this.namespaceType(node.path);
    const receiver = isRoot ? "c" : "n";
    const dotted = ["client", ...node.path].join(".");

    const taken = new Set<string>();
    const children = [...node.children.entries()].map(([key, child]) => ({
      field: uniqueName(exported(key), taken),
      type: this.namespaceType(child.path),
      dotted: `${dotted}.${key}`,
    }));

    const rows: Row[] = [{ cells: ["t", "*transport"] }];
    if (children.length > 0) rows.push({ raw: "" });
    for (const child of children) {
      rows.push({ raw: `// ${child.field}: \`${child.dotted}\`.` });
      rows.push({ cells: [child.field, `*${child.type}`] });
    }

    const doc = isRoot
      ? [
          `${CLIENT_TYPE} is a client for the ${this.ir.title}.`,
          "Calls hang off the namespace fields below, which mirror the URL" +
            " structure — `client.Accounts.Credentials.Get(ctx, …)`. The zero" +
            ` value is not usable; build one with ${CLIENT_CONSTRUCTOR}.`,
        ]
      : [`${typeName} is \`${dotted}\`.`];

    const lines = [...goDoc(doc), `type ${typeName} struct {`, ...alignRows(rows, "\t"), "}", ""];

    if (isRoot) {
      lines.push(
        ...goDoc([
          `${CLIENT_CONSTRUCTOR} builds a client. With no options it talks to` +
            ` ${this.ir.baseUrl} anonymously, which is rarely what you want:` +
            " pass WithAPIKey, and WithOrgID if you would rather not repeat the" +
            " organization id on every call.",
        ]),
        `func ${CLIENT_CONSTRUCTOR}(opts ...ClientOption) *${CLIENT_TYPE} {`,
        "\tt := newTransport(opts)",
        `\t${receiver} := &${CLIENT_TYPE}{t: t}`,
      );
    } else {
      lines.push(
        `func new${typeName}(t *transport) *${typeName} {`,
        `\t${receiver} := &${typeName}{t: t}`,
      );
    }
    for (const child of children) {
      lines.push(`\t${receiver}.${child.field} = new${child.type}(t)`);
    }
    lines.push(`\treturn ${receiver}`, "}");

    if (isRoot) {
      lines.push(
        "",
        "// BaseURL reports the normalized base URL every call is sent to.",
        `func (${receiver} *${CLIENT_TYPE}) BaseURL() string {`,
        `\treturn ${receiver}.t.baseURL()`,
        "}",
      );
    }

    for (const op of node.operations) {
      lines.push("", ...this.operationDecls(op, typeName, receiver, taken, dotted));
    }
    return lines;
  }

  private operationDecls(
    op: OperationDef,
    receiverType: string,
    receiver: string,
    taken: Set<string>,
    dotted: string,
  ): string[] {
    const wanted = exported(op.name);
    const methodName = uniqueName(wanted, taken);
    if (methodName !== wanted) {
      this.log(`  ! ${dotted}.${op.name} collides with a sibling — calling it ${methodName}`);
    }
    const base = `${op.namespace.map(exported).join("")}${methodName}`;

    // Field names, statements and the params struct are built together: the
    // statement has to reference whatever name the field ended up with.
    const fieldTaken = new Set<string>();
    const rows: Row[] = [];
    const statements: string[] = [];
    let required = 0;

    for (const param of op.parameters) {
      const fieldName = uniqueName(exported(param.name), fieldTaken);
      const type = this.resolve(param.type, `${base}${fieldName}`);
      // A defaultable path parameter is required on the wire and optional here:
      // the transport fills it in from client configuration.
      const optional = param.defaultable || !param.required;
      if (!optional) required++;
      const notes: string[] = [];
      if (param.description) notes.push(param.description);
      if (param.defaultable) {
        notes.push(`Falls back to the client's \`${param.name}\` when omitted.`);
      }
      const values = stringEnum(param.type);
      if (values) notes.push(`One of ${values.map(quote).join(", ")}.`);
      if (notes.length > 0) {
        for (const line of goDoc([`${fieldName}: ${notes[0]!}`, ...notes.slice(1)], 74)) {
          rows.push({ raw: line });
        }
      }
      rows.push({ cells: [fieldName, this.fieldType(type, !optional)] });
      statements.push(
        `r.${param.in === "path" ? "setPath" : "addQuery"}(${quote(param.name)}, params.${fieldName})`,
      );
    }

    if (op.body) {
      const fieldName = uniqueName("Body", fieldTaken);
      const type = this.resolve(op.body.type, `${base}Request`);
      if (op.body.required) required++;
      const note =
        op.body.encoding === "multipart"
          ? `${fieldName}: sent as \`multipart/form-data\`; the \`io.Reader\` field is the file.`
          : `${fieldName}: the JSON request body.`;
      for (const line of goDoc([note], 74)) rows.push({ raw: line });
      rows.push({ cells: [fieldName, this.fieldType(type, op.body.required)] });
      statements.push(
        `r.${op.body.encoding === "multipart" ? "setFormBody" : "setJSONBody"}(params.${fieldName})`,
      );
    }

    const hasParams = rows.length > 0;
    // Params go by value when something in them is mandatory and by pointer
    // when nothing is, so `List(ctx, nil)` stays available for the calls that
    // need no arguments at all without making a required id look optional.
    const byPointer = hasParams && required === 0;

    const [lead, ...rest] = operationDocParts(op);
    const decls: string[] = [];
    let paramsName = "";
    if (hasParams) {
      paramsName = uniqueName(`${base}Params`, this.taken);
      decls.push(
        ...goDoc([
          `${paramsName} holds the parameters for \`${dotted}.${op.name}\`.`,
          byPointer ? "Every field is optional; pass nil to take the defaults." : undefined,
        ]),
        `type ${paramsName} struct {`,
        ...alignRows(rows, "\t"),
        "}",
        "",
      );
    }

    const args = ["ctx context.Context"];
    if (hasParams) args.push(`params ${byPointer ? "*" : ""}${paramsName}`);
    args.push("opts ...RequestOption");

    const body: string[] = [
      `\tr := newRequest(${HTTP_METHOD_CONSTANT[op.method]}, ${quote(op.path)})`,
    ];
    if (byPointer) {
      body.push("\tif params != nil {");
      for (const statement of statements) body.push(`\t\t${statement}`);
      body.push("\t}");
    } else {
      for (const statement of statements) body.push(`\t${statement}`);
    }

    let returns: string;
    switch (op.response.encoding) {
      case "empty":
        returns = "error";
        body.push(`\treturn ${receiver}.t.do(ctx, r, nil, opts)`);
        break;
      case "binary":
        returns = "(io.ReadCloser, error)";
        body.push(`\treturn ${receiver}.t.stream(ctx, r, opts)`);
        break;
      case "json": {
        const type = op.response.type
          ? this.resolve(op.response.type, `${base}Response`)
          : ANY_TYPE;
        // A struct comes back as a pointer so "no response yet" and "an
        // all-zero response" stay distinguishable at the call site.
        const goType = type.nilable ? type.text : `*${type.text}`;
        returns = `(${goType}, error)`;
        body.push(
          `\tvar out ${goType}`,
          `\tif err := ${receiver}.t.do(ctx, r, &out, opts); err != nil {`,
          "\t\treturn out, err",
          "\t}",
          "\treturn out, nil",
        );
        break;
      }
    }

    decls.push(
      // Go doc comments open with the identifier they document, so the spec's
      // summary is re-headed rather than dropped.
      ...goDoc([`${methodName}: ${lead ?? ""}`, ...rest]),
      `func (${receiver} *${receiverType}) ${methodName}(${args.join(", ")}) ${returns} {`,
      ...body,
      "}",
    );
    return decls;
  }

  private allNamespaces(node: NamespaceDef): string[] {
    const out = [...this.namespaceDecls(node)];
    for (const child of node.children.values()) out.push("", ...this.allNamespaces(child));
    return out;
  }

  // -- files ---------------------------------------------------------------

  /** The banner + package clause every generated file opens with. */
  private header(imports: string[]): string[] {
    const banner = fileBanner(this.ir, GO_COMMENT, MODULE_PATH).trimEnd();
    const lines = [banner, "", `package ${PACKAGE_NAME}`];
    if (imports.length > 0) {
      lines.push("", "import (", ...imports.map((name) => `\t${quote(name)}`), ")");
    }
    return lines;
  }

  /**
   * `models.go` — every named schema, then every struct hoisted out of an
   * inline object. The hoisted ones from the call tree are passed in because
   * printing the calls is what discovers them, and that happens first.
   */
  modelsFile(hoistedFromCalls: string[]): string {
    const sections: string[] = [];
    for (const schema of this.ir.schemas) sections.push("", ...this.schemaDecl(schema));

    const body = [...sections, ...this.drainHoisted(), ...hoistedFromCalls];
    const imports = usesSymbol(body, "io.Reader") ? ["io"] : [];
    return [
      ...this.header(imports),
      "",
      ...goDoc([
        "Wire models.",
        "A field is a pointer whenever the wire may omit it or send null." +
          " `omitempty` alone would not do: it also drops false, 0 and the empty" +
          " string, so a caller could never turn a flag off or send an explicit" +
          " zero. Slices and maps keep their own nil instead of gaining a second" +
          " one.",
        "Fields carry the spec's own property names in their json tags, so the" +
          " Go spelling is free to follow Go's conventions.",
      ]),
      ...body,
      "",
    ].join("\n");
  }

  /**
   * `api.go` — the option that carries the scoping parameter, then the client
   * and every namespace beneath it.
   */
  apiFile(): { source: string; hoisted: string[] } {
    const namespaces = this.allNamespaces(this.ir.root);

    // The runtime knows the scoping parameter only as a string constant; the
    // option that sets it is generated here so it can be named after the
    // parameter the spec actually declares, rather than after `orgId` forever.
    const scope = this.ir.defaultablePathParam;
    const scopeOption: string[] = [];
    if (scope) {
      const option = `With${exported(scope)}`;
      const argument = exported(scope).replace(/^./, (c) => c.toLowerCase());
      scopeOption.push(
        "",
        ...goDoc([
          `${option} sets the ${scope} every scoped call falls back to, so it can` +
            " be left out of the parameters. A call that passes its own wins; a" +
            " call that has neither returns ErrMissingPathParam.",
        ]),
        `func ${option}(${argument} string) ClientOption {`,
        `\treturn withScope(${argument})`,
        "}",
      );
    }

    const body = [...scopeOption, "", ...namespaces];
    const imports = ["context"];
    if (usesSymbol(body, "io.ReadCloser")) imports.push("io");
    imports.push("net/http");

    // Hoisting happens while the calls are printed, so the structs an inline
    // request or response body produced are only known now.
    const hoisted = this.drainHoisted();
    return { source: [...this.header(imports), ...body, ""].join("\n"), hoisted };
  }

  /** Emit every struct hoisted so far, including any hoisted while emitting. */
  drainHoisted(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.hoisted.length; i++) {
      const struct = this.hoisted[i]!;
      const doc =
        struct.doc.length > 0
          ? struct.doc
          : [`${struct.name} is an object the spec declares inline.`];
      out.push("", ...this.structDecl(struct.name, doc, struct.properties, true));
    }
    this.hoisted.length = 0;
    return out;
  }
}

/**
 * Whether emitted code actually names a symbol, which is what decides the
 * import block. Comments are excluded: an unused import is a compile error in
 * Go, so a doc comment mentioning `io.Reader` must not conjure one.
 */
function usesSymbol(lines: string[], symbol: string): boolean {
  return lines.some((line) => !line.trimStart().startsWith("//") && line.includes(symbol));
}

function isNilable(text: string): boolean {
  return (
    text === "any" ||
    text === "io.Reader" ||
    text.startsWith("*") ||
    text.startsWith("[]") ||
    text.startsWith("map[")
  );
}

// ---------------------------------------------------------------------------
// Runtime + package files
// ---------------------------------------------------------------------------

async function loadRuntime(ir: SdkIr): Promise<string> {
  const source = await readFile(new URL("./runtime.go.txt", import.meta.url), "utf8");
  const start = source.indexOf(RUNTIME_SENTINEL);
  if (start === -1) {
    throw new Error(`runtime.go.txt is missing its "${RUNTIME_SENTINEL}" sentinel line`);
  }
  const scope = ir.defaultablePathParam;
  return source
    .slice(source.indexOf("\n", start) + 1)
    .replace('"@@BASE_URL@@"', quote(ir.baseUrl))
    .replace('"@@API_VERSION@@"', quote(ir.apiVersion))
    .replace('"@@SCOPE_PARAM@@"', quote(scope ?? ""))
    .replace('"@@SCOPE_OPTION@@"', quote(scope ? `With${exported(scope)}` : ""))
    .trim();
}

function goMod(): string {
  return `module ${MODULE_PATH}

go ${GO_VERSION}
`;
}

function readme(ir: SdkIr): string {
  // The example has to compile, so it is only used when its parameters are all
  // optional — which is what makes `nil` a legal second argument.
  const example = ir.operations.find(
    (op) =>
      op.namespace[0] === "accounts" &&
      op.name === "list" &&
      op.parameters.every((param) => param.defaultable || !param.required) &&
      op.body === null,
  );
  const call = example
    ? `client.${[...example.namespace, example.name].map(exported).join(".")}(ctx, nil)`
    : "client.BaseURL(), error(nil)";

  const scope = ir.defaultablePathParam;
  const scopeOption = scope ? `With${exported(scope)}` : null;
  const scopeField = scope ? exported(scope) : null;
  const scopeLine = scopeOption
    ? `\n\t\t${PACKAGE_NAME}.${scopeOption}(os.Getenv("INFRAWRENCH_ORG_ID")),`
    : "";
  const scopeBullet = scopeOption
    ? `- **Organization id.** Pass \`${scopeOption}\` once when constructing the
  client and every scoped call can leave \`${scopeField}\` unset; set
  \`${scopeField}\` on an individual call to override it. With neither, the call
  returns an error wrapping \`ErrMissingPathParam\` rather than sending a
  malformed URL.\n`
    : "";

  return `# ${MODULE_PATH}

Generated Go client for the ${ir.title}.

**API version \`${ir.apiVersion}\`.** A Go module takes its version from a VCS
tag rather than from a manifest field, so the API version lives in this README
and in the \`APIVersion\` constant — check that constant, not the module tag,
when you need to know which API shape you have.

**Do not edit this module by hand** — it is regenerated from \`openapi.json\` and
is not checked into the repository. Run
\`pnpm --filter @infrawrench/web generate:sdk\` to rebuild it; the generator lives
in [\`${GENERATOR_PATH}\`](${REPOSITORY_URL}/tree/main/${GENERATOR_PATH}).

## Install

\`\`\`sh
go get ${MODULE_PATH}
\`\`\`

Go ${GO_VERSION} or newer. No dependencies: the module requires nothing but the
standard library, and \`go.mod\` has no \`require\` block at all.

## Usage

\`\`\`go
package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"${MODULE_PATH}"
)

func main() {
	ctx := context.Background()
	client := ${PACKAGE_NAME}.${CLIENT_CONSTRUCTOR}(
		${PACKAGE_NAME}.WithAPIKey(os.Getenv("INFRAWRENCH_API_KEY")),${scopeLine}
	)

	accounts, err := ${call}
	if err != nil {
		var apiErr *${PACKAGE_NAME}.APIError
		if errors.As(err, &apiErr) {
			fmt.Println(apiErr.StatusCode, apiErr.Code, string(apiErr.Body))
		}
		return
	}
	fmt.Println(len(accounts))
}
\`\`\`

## Conventions

- **Context first.** Every call takes a \`context.Context\` as its first
  argument and a variadic \`...RequestOption\` as its last. Timeouts and
  cancellation belong on the context, so there is no per-call timeout option.
- **Dotted namespaces.** Calls mirror the URL structure, so
  \`POST /api/org/{orgId}/accounts/{id}/sync\` is \`client.Accounts.Sync(...)\`.
- **Parameters.** A call with at least one mandatory parameter takes its params
  struct by value; a call where everything is optional takes a pointer, so
  \`nil\` means "no arguments". A call with no parameters at all takes neither.
${scopeBullet}- **Optional fields are pointers.** Go cannot tell an omitted \`false\` from a
  deliberate one, so anything the wire may omit or null is a \`*T\`. Slices and
  maps keep their own nil.
- **Errors are returned, never panicked.** Any non-2xx response comes back as
  \`*APIError\`, carrying \`StatusCode\`, the raw \`Body\`, the decoded \`Data\`
  and the machine-readable \`Code\` when the API sends one. Use \`errors.As\`, or
  the \`AsAPIError\` shorthand.
- **Downloads stream.** An endpoint that returns a file returns an
  \`io.ReadCloser\`; close it.

## Scope

This module covers the published API surface only. Operations marked
\`x-internal\` in the spec — the admin surface, webhook receivers, desktop sync,
push registration, and the browser auth redirects — are not generated, so there
is no namespace for them to be called through.

Topics: ${KEYWORDS.join(", ")}.

## License

${LICENSE} — see [\`LICENSE\`](./LICENSE). ${COPYRIGHT_NOTICE}.

Note that this client is more permissively licensed than the service it talks
to: the Infrawrench source is BUSL-1.1, but the generated clients are ${LICENSE}
so you can link one into your own software without inheriting those terms.

Maintained by ${AUTHOR.name} <${AUTHOR.email}>. Documentation: <${HOMEPAGE}>.
Issues: <${ISSUES_URL}>
`;
}

// ---------------------------------------------------------------------------

export const goTarget: SdkTarget = {
  id: "go",
  displayName: "Go",
  packageName: MODULE_PATH,
  artifacts: ["go.mod", "client.go", "models.go", "api.go", "README.md", "LICENSE"],

  async generate(ir: SdkIr, ctx: TargetContext): Promise<void> {
    const emitter = new GoEmitter(ir, ctx.log);

    // The call tree is printed before the models file is assembled: printing it
    // is what discovers the structs an inline request or response body needs.
    const api = emitter.apiFile();

    const runtime = `${fileBanner(ir, GO_COMMENT, MODULE_PATH)}\n${await loadRuntime(ir)}\n`;

    await ctx.write("go.mod", goMod());
    await ctx.write("client.go", runtime);
    await ctx.write("models.go", emitter.modelsFile(api.hoisted));
    await ctx.write("api.go", api.source);
    await ctx.write("README.md", readme(ir));
    // MIT requires the license text and the copyright notice to travel with
    // every copy, so this is an artifact rather than a courtesy.
    await ctx.write("LICENSE", LICENSE_TEXT);

    ctx.log(`  ${ir.operations.length} calls, ${ir.schemas.length} schemas → 3 Go files`);
  },
};
