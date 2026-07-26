/**
 * The Ruby SDK target.
 *
 * Emits a conventional gem layout rather than one file: `require
 * "infrawrench/sdk"` pulls in `version.rb`, the hand-written `transport.rb`
 * (inlined verbatim from `./runtime.rb`), and the generated `client.rb`, which
 * holds one class per namespace in the dotted call tree bottomed out by
 * `APIV1Client`.
 *
 * ## How much of `ir.schemas` becomes Ruby
 *
 * None of it, at runtime. Responses are the plain `Hash`/`Array` that
 * `JSON.parse` produces, with String keys exactly as the wire spells them.
 *
 * That is a deliberate choice, not a shortcut. 177 generated model classes
 * would be 177 places to drop a field the server started sending, and Ruby
 * callers reach for `account["id"]` anyway — an attribute wrapper buys nothing
 * a Hash does not already give them, and costs a round of allocation plus a
 * lossy re-serialization on the way back out.
 *
 * The shapes are not thrown away, though: every schema is emitted as an RBS
 * type alias in `sig/`, which is Ruby's own type language, and the generated
 * method signatures reference those aliases. Steep, TypeProf and RubyMine read
 * it; `ruby` itself never loads it, so it costs nothing at runtime. YARD
 * `@return` tags name the schema alongside the alias so `ri`/`yard` readers get
 * the same pointer without leaving the source.
 */
import { readFile } from "node:fs/promises";
import { docComment, fileBanner, HASH_STYLE, operationDocParts, wrap } from "../../emit";
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
  SchemaDef,
  SdkIr,
  TypeRef,
} from "../../types";

const PACKAGE_NAME = "infrawrench-sdk";
const MODULE_NAME = "Infrawrench";
const CLIENT_CLASS = "APIV1Client";
const RUNTIME_SENTINEL = "# --8<--";

/** Where each emitted file lands, so the gemspec and `artifacts` agree with reality. */
const FILES = {
  entry: "lib/infrawrench/sdk.rb",
  alias: "lib/infrawrench-sdk.rb",
  version: "lib/infrawrench/version.rb",
  transport: "lib/infrawrench/transport.rb",
  client: "lib/infrawrench/client.rb",
  sig: "sig/infrawrench/sdk.rbs",
  gemspec: `${PACKAGE_NAME}.gemspec`,
} as const;

/**
 * Names a generated method or attribute may not take.
 *
 * Only *public* `Object` instance methods are listed. Ruby's `Kernel#open`,
 * `#exec`, `#format` and friends are private, so a namespace class can define
 * `open` without breaking anything — and it must be able to, because
 * `client.agents.sessions.open` and `client.ssh_tunnels.exec` are exactly the
 * names the URLs ask for. Overriding a public one is a different story:
 * `def class` really does break `obj.class`, which is how `inspect`,
 * exceptions and `case` all find their footing.
 *
 * Ruby keywords are here too. `def if` parses and `obj.if` even calls it, but
 * nobody should have to know that.
 */
const RESERVED_METHOD_NAMES = new Set([
  // public Object instance methods
  "class",
  "clone",
  "define_singleton_method",
  "display",
  "dup",
  "enum_for",
  "eql?",
  "equal?",
  "extend",
  "freeze",
  "frozen?",
  "hash",
  "initialize",
  "inspect",
  "instance_eval",
  "instance_exec",
  "instance_of?",
  "instance_variable_defined?",
  "instance_variable_get",
  "instance_variable_set",
  "instance_variables",
  "is_a?",
  "itself",
  "kind_of?",
  "method",
  "methods",
  "nil?",
  "object_id",
  "private_methods",
  "public_method",
  "public_methods",
  "public_send",
  "respond_to?",
  "send",
  "singleton_class",
  "singleton_method",
  "singleton_methods",
  "tap",
  "then",
  "to_enum",
  "to_s",
  "yield_self",
  // keywords
  ...rubyKeywords(),
]);

function rubyKeywords(): string[] {
  return [
    "alias",
    "and",
    "begin",
    "break",
    "case",
    "def",
    "defined?",
    "do",
    "else",
    "elsif",
    "end",
    "ensure",
    "false",
    "for",
    "if",
    "in",
    "module",
    "next",
    "nil",
    "not",
    "or",
    "redo",
    "rescue",
    "retry",
    "return",
    "self",
    "super",
    "then",
    "true",
    "undef",
    "unless",
    "until",
    "when",
    "while",
    "yield",
    "__method__",
    "__dir__",
    "__FILE__",
    "__LINE__",
    "__ENCODING__",
    "BEGIN",
    "END",
  ];
}

/**
 * Keyword-argument names are plain locals, so they only have to dodge Ruby's
 * keywords and the two names every generated method already spends.
 */
const RESERVED_ARG_NAMES = new Set(["body", "request_options", ...rubyKeywords()]);

/**
 * Constants `module Infrawrench` already holds, plus the core ones a namespace
 * class must not shadow — a class called `Infrawrench::Hash` would win constant
 * lookup for every unqualified `Hash` inside the module.
 */
const RESERVED_CONSTANTS = new Set([
  // declared by ./runtime.rb and by the generated entry point
  "ApiError",
  "ConfigurationError",
  "DEFAULT_BASE_URL",
  "Error",
  "SCOPE_PARAM",
  "Transport",
  "Upload",
  "VERSION",
  CLIENT_CLASS,
  // core constants the emitted code resolves unqualified
  "Array",
  "Class",
  "Comparable",
  "Data",
  "Encoding",
  "Enumerable",
  "Exception",
  "File",
  "Float",
  "Hash",
  "IO",
  "Integer",
  "JSON",
  "Kernel",
  "Method",
  "Module",
  "Net",
  "Numeric",
  "Object",
  "Proc",
  "Range",
  "Regexp",
  "SecureRandom",
  "StandardError",
  "String",
  "Struct",
  "Symbol",
  "Time",
  "URI",
]);

/** RBS reserves these, so no type alias may be named after one. */
const RBS_KEYWORDS = new Set([
  "alias",
  "attr_accessor",
  "attr_reader",
  "attr_writer",
  "bool",
  "bot",
  "class",
  "def",
  "end",
  "extend",
  "false",
  "in",
  "include",
  "instance",
  "interface",
  "module",
  "nil",
  "out",
  "prepend",
  "private",
  "public",
  "self",
  "singleton",
  "top",
  "true",
  "type",
  "untyped",
  "unchecked",
  "use",
  "void",
]);

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Everything the emitter needs to know about one node of the call tree. */
interface NamespaceInfo {
  /** Ruby class name, unqualified — `AccountsCredentialsNamespace`. */
  className: string;
  /** Reader the parent exposes it under — `credentials`. Empty at the root. */
  attrName: string;
  /** Dotted snake_case path as a caller types it — `accounts.credentials`. */
  dotted: string;
  /** Reader name per child key, and method name per `op.id`. */
  members: Map<string, string>;
}

/**
 * Resolves IR names to the Ruby identifiers the gem actually declares.
 *
 * Method and reader names are allocated per class rather than globally: two
 * namespaces may both have a `list`, and only a collision *within* one class
 * matters.
 */
class NameTable {
  private readonly constants = new Set(RESERVED_CONSTANTS);
  private readonly nodes = new Map<string, NamespaceInfo>();
  private readonly aliases = new Map<string, string>();
  private readonly aliasesTaken = new Set<string>();
  readonly renamed: Array<{ from: string; to: string; why: string }> = [];

  registerSchema(specName: string): void {
    const base = snakeCase(specName) || "schema";
    const candidate = RBS_KEYWORDS.has(base) ? `${base}_model` : base;
    const resolved = uniqueName(candidate, this.aliasesTaken);
    if (resolved !== base) {
      this.renamed.push({ from: specName, to: resolved, why: "collides with an RBS keyword" });
    }
    this.aliases.set(specName, resolved);
  }

  registerNamespace(node: NamespaceDef): void {
    const isRoot = node.path.length === 0;
    const className = isRoot
      ? CLIENT_CLASS
      : uniqueName(`${node.path.map(pascalCase).join("")}Namespace`, this.constants);

    // The root's own `transport` reader is spent before anything else can claim it.
    const taken = new Set(RESERVED_METHOD_NAMES);
    if (isRoot) taken.add("transport");

    const members = new Map<string, string>();
    for (const key of node.children.keys()) {
      const base = snakeCase(key);
      const safe = RESERVED_METHOD_NAMES.has(base) ? `${base}_ns` : base;
      const resolved = uniqueName(safe, taken);
      if (resolved !== base) {
        this.renamed.push({ from: key, to: resolved, why: "collides with an Object method" });
      }
      members.set(`ns:${key}`, resolved);
    }
    for (const op of node.operations) {
      const base = snakeCase(op.name);
      // The IR already falls back to the operationId when a name is taken, so
      // reusing it here keeps a renamed method recognizable rather than
      // inventing a suffix nobody would guess.
      const candidate = RESERVED_METHOD_NAMES.has(base) ? snakeCase(op.id) : base;
      const safe = RESERVED_METHOD_NAMES.has(candidate) ? `${candidate}_op` : candidate;
      const resolved = uniqueName(safe, taken);
      if (resolved !== base) {
        this.renamed.push({ from: base, to: resolved, why: "collides with an Object method" });
      }
      members.set(`op:${op.id}`, resolved);
    }

    const parent = this.nodes.get(node.path.slice(0, -1).join("."));
    const attrName = isRoot ? "" : (parent?.members.get(`ns:${node.path.at(-1)!}`) ?? "");
    const dotted = isRoot ? "" : [parent?.dotted, attrName].filter(Boolean).join(".");

    this.nodes.set(node.path.join("."), { className, attrName, dotted, members });
  }

  node(path: string[]): NamespaceInfo {
    return (
      this.nodes.get(path.join(".")) ?? {
        className: CLIENT_CLASS,
        attrName: "",
        dotted: "",
        members: new Map(),
      }
    );
  }

  method(path: string[], op: OperationDef): string {
    return this.node(path).members.get(`op:${op.id}`) ?? snakeCase(op.name);
  }

  child(path: string[], key: string): string {
    return this.node(path).members.get(`ns:${key}`) ?? snakeCase(key);
  }

  alias(specName: string): string {
    return this.aliases.get(specName) ?? "untyped";
  }
}

/** A keyword-argument name for a wire parameter, kept clear of Ruby's keywords. */
function argName(param: ParameterDef, taken: Set<string>): string {
  const base = snakeCase(param.name) || "arg";
  return uniqueName(RESERVED_ARG_NAMES.has(base) ? `${base}_param` : base, taken);
}

// ---------------------------------------------------------------------------
// RBS type printing
// ---------------------------------------------------------------------------

/**
 * Join RBS union/intersection members, breaking one per line when long.
 *
 * Unlike TypeScript, RBS has no leading-separator form — `type x = | A | B` is a
 * syntax error — so the first member stays on the opening line.
 */
function joinRbs(parts: string[], separator: "|" | "&", indent: string): string {
  const oneLine = parts.join(` ${separator} `);
  if (oneLine.length <= 90 && !oneLine.includes("\n")) return oneLine;
  const [head, ...rest] = parts;
  return [head, ...rest.map((part) => `${indent}  ${separator} ${part}`)].join("\n");
}

function parenthesize(member: TypeRef, printed: string, within: "union" | "intersection"): string {
  const needs = within === "union" ? member.kind === "intersection" : member.kind === "union";
  return needs ? `(${printed})` : printed;
}

function printRbs(ref: TypeRef, names: NameTable, indent: string): string {
  switch (ref.kind) {
    case "ref":
      return names.alias(ref.name);
    case "string":
      return ref.enum
        ? joinRbs(
            ref.enum.map((value) => JSON.stringify(value)),
            "|",
            indent,
          )
        : "String";
    case "number":
      // JSON numbers land as Integer or Float; `Numeric` is the only honest
      // supertype for a schema that does not promise an integer.
      return ref.integer ? "Integer" : "Numeric";
    case "boolean":
      return "bool";
    case "null":
      return "nil";
    case "unknown":
      return "untyped";
    case "binary":
      // Only ever an input: a file field accepts bytes, an IO, or an Upload.
      return "(Upload | _Readable | String)";
    case "array":
      return `Array[${printRbs(ref.items, names, indent)}]`;
    // Members are printed one level deeper so a record inside a multi-line
    // union lines its braces up under its own `|` rather than under the alias.
    case "union":
      return joinRbs(
        ref.members.map((m) => parenthesize(m, printRbs(m, names, `${indent}  `), "union")),
        "|",
        indent,
      );
    case "intersection":
      return joinRbs(
        ref.members.map((m) => parenthesize(m, printRbs(m, names, `${indent}  `), "intersection")),
        "&",
        indent,
      );
    case "object":
      return printRbsObject(ref, names, indent);
  }
}

function printRbsObject(
  ref: Extract<TypeRef, { kind: "object" }>,
  names: NameTable,
  indent: string,
): string {
  // RBS record types are closed by construction, so a schema that is both
  // shaped and open cannot be spelled as one. The open half is the part that
  // would make a checker reject valid code, so it wins.
  if (ref.properties.length === 0 || ref.additional !== null) {
    const value = ref.additional === null ? "untyped" : printRbs(ref.additional, names, indent);
    return ref.properties.length === 0 && ref.additional !== null
      ? `Hash[String, ${value}]`
      : "Hash[String, untyped]";
  }

  const inner = `${indent}  `;
  const fields = ref.properties.map(
    (prop) =>
      `${inner}${prop.required ? "" : "?"}${JSON.stringify(prop.name)} => ${printRbs(prop.type, names, inner)}`,
  );
  const oneLine = `{ ${fields.map((f) => f.trim()).join(", ")} }`;
  if (oneLine.length + indent.length <= 96 && !oneLine.includes("\n")) return oneLine;
  return `{\n${fields.join(",\n")}\n${indent}}`;
}

// ---------------------------------------------------------------------------
// Doc printing
// ---------------------------------------------------------------------------

/**
 * A YARD type for a doc comment — Ruby class names, not RBS.
 *
 * `$ref`s are resolved rather than named, because YARD would read `Account` as
 * a constant this gem does not declare. The schema name still reaches the
 * reader, via {@link shapeString} in the `@return` prose.
 */
function yardType(ref: TypeRef, schemas: Map<string, SchemaDef>, depth = 0): string {
  if (depth > 4) return "Object";
  switch (ref.kind) {
    case "ref": {
      const target = schemas.get(ref.name);
      return target ? yardType(target.type, schemas, depth + 1) : "Object";
    }
    case "string":
      return "String";
    case "number":
      return ref.integer ? "Integer" : "Numeric";
    case "boolean":
      return "Boolean";
    case "null":
      return "nil";
    case "unknown":
      return "Object";
    case "binary":
      return "Upload, IO, String";
    case "array":
      return `Array<${yardType(ref.items, schemas, depth + 1)}>`;
    case "object":
      return "Hash";
    case "intersection":
      return "Hash";
    case "union": {
      const seen = new Set(ref.members.map((m) => yardType(m, schemas, depth + 1)));
      return [...seen].join(", ");
    }
  }
}

/** A spec-level description of a shape, keeping `$ref`s as their spec names. */
function shapeString(ref: TypeRef, depth = 0): string {
  if (depth > 3) return "…";
  switch (ref.kind) {
    case "ref":
      return ref.name;
    case "string":
      return ref.enum ? "String (enum)" : "String";
    case "number":
      return ref.integer ? "Integer" : "Numeric";
    case "boolean":
      return "Boolean";
    case "null":
      return "nil";
    case "unknown":
      return "Object";
    case "binary":
      return "file";
    case "array":
      return `Array<${shapeString(ref.items, depth + 1)}>`;
    case "object":
      return "Hash";
    case "union":
      return ref.members.map((m) => shapeString(m, depth + 1)).join(" | ");
    case "intersection":
      return ref.members.map((m) => shapeString(m, depth + 1)).join(" & ");
  }
}

/**
 * One YARD tag, wrapped with a hanging indent.
 *
 * `docComment` from `../../emit` handles prose, but YARD reads an unindented
 * continuation line as the start of the next paragraph — so tags get their own
 * renderer and everything above them still goes through the shared helper.
 */
function yardTag(text: string, indent: string, width = 96): string[] {
  const lines = wrap(text, width - indent.length - 2);
  return lines.map((line, i) => `${indent}# ${i === 0 ? "" : "  "}${line}`.trimEnd());
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface Argument {
  /** Ruby keyword-argument name. */
  name: string;
  /** Wire name, for the request hashes. */
  wire: string;
  optional: boolean;
  yard: string;
  doc: string | undefined;
}

function parameterDoc(param: ParameterDef, scopeArg: string): string | undefined {
  if (param.defaultable) {
    const base = param.description ? `${param.description.replace(/\.$/, "")}. ` : "";
    return `${base}Defaults to the \`${scopeArg}\` the client was constructed with.`;
  }
  return param.description;
}

function operationArgs(
  op: OperationDef,
  schemas: Map<string, SchemaDef>,
  scopeArg: string,
): Argument[] {
  const taken = new Set<string>();
  return op.parameters.map((param) => ({
    name: argName(param, taken),
    wire: param.name,
    // A defaultable path parameter is required on the wire but optional here —
    // the transport fills it in from client configuration.
    optional: param.defaultable || !param.required,
    yard: yardType(param.type, schemas),
    doc: parameterDoc(param, scopeArg),
  }));
}

/**
 * Which fields of a multipart body are files.
 *
 * The transport cannot tell a String of bytes from a String of text, so the
 * generator hands it the answer the spec already knows.
 */
function binaryFields(ref: TypeRef, schemas: Map<string, SchemaDef>, depth = 0): string[] {
  if (depth > 4) return [];
  switch (ref.kind) {
    case "ref": {
      const target = schemas.get(ref.name);
      return target ? binaryFields(target.type, schemas, depth + 1) : [];
    }
    case "object":
      return ref.properties
        .filter((prop) => containsBinary(prop.type, schemas, depth))
        .map((prop) => prop.name);
    case "intersection":
    case "union":
      return [...new Set(ref.members.flatMap((m) => binaryFields(m, schemas, depth + 1)))];
    default:
      return [];
  }
}

function containsBinary(ref: TypeRef, schemas: Map<string, SchemaDef>, depth = 0): boolean {
  if (depth > 4) return false;
  if (ref.kind === "binary") return true;
  if (ref.kind === "ref") {
    const target = schemas.get(ref.name);
    return target ? containsBinary(target.type, schemas, depth + 1) : false;
  }
  if (ref.kind === "union" || ref.kind === "intersection") {
    return ref.members.some((m) => containsBinary(m, schemas, depth + 1));
  }
  return false;
}

function returnYard(op: OperationDef, schemas: Map<string, SchemaDef>): string {
  switch (op.response.encoding) {
    case "binary":
      return "String";
    case "empty":
      return "nil";
    case "json":
      return op.response.type ? yardType(op.response.type, schemas) : "Object";
  }
}

/**
 * A type as it appears inside a `def` line.
 *
 * Flattened to one line, because RBS method signatures do not tolerate the
 * multi-line unions the alias section uses, and parenthesized when it is a
 * union or intersection, because `-> A | B` cannot be told from the start of
 * the next declaration.
 */
function inlineRbs(ref: TypeRef, names: NameTable): string {
  const printed = printRbs(ref, names, "").replace(/\s*\n\s*/g, " ");
  return ref.kind === "union" || ref.kind === "intersection" ? `(${printed})` : printed;
}

function returnRbs(op: OperationDef, names: NameTable): string {
  switch (op.response.encoding) {
    case "binary":
      return "String";
    case "empty":
      return "nil";
    case "json":
      return op.response.type ? inlineRbs(op.response.type, names) : "untyped";
  }
}

function returnDoc(op: OperationDef): string {
  switch (op.response.encoding) {
    case "binary":
      return "Raw response bytes.";
    case "empty":
      return "This endpoint returns no content.";
    case "json":
      return op.response.type
        ? `Parsed JSON, shaped as \`${shapeString(op.response.type)}\` — see \`${FILES.sig}\`.`
        : "Parsed JSON.";
  }
}

function emitOperation(
  op: OperationDef,
  names: NameTable,
  schemas: Map<string, SchemaDef>,
  scopeArg: string,
): string {
  const indent = "    ";
  const args = operationArgs(op, schemas, scopeArg);
  const files = op.body?.encoding === "multipart" ? binaryFields(op.body.type, schemas) : [];

  const lines: string[] = [];
  const prose = docComment(operationDocParts(op), HASH_STYLE, indent);
  if (prose) lines.push(prose, `${indent}#`);

  for (const arg of args) {
    const type = arg.optional ? `${arg.yard}, nil` : arg.yard;
    lines.push(...yardTag(`@param ${arg.name} [${type}] ${arg.doc ?? ""}`.trimEnd(), indent));
  }
  if (op.body) {
    const type = op.body.required ? "Hash" : "Hash, nil";
    const how =
      op.body.encoding === "multipart"
        ? `Sent as \`multipart/form-data\`; ${files.map((f) => `\`${f}\``).join(", ") || "no field"} carries the file bytes.`
        : `Request body, shaped as \`${shapeString(op.body.type)}\`.`;
    lines.push(...yardTag(`@param body [${type}] ${how}`, indent));
  }
  lines.push(
    ...yardTag(
      "@param request_options [Hash, nil] Per-call `:headers`, `:timeout` and `:open_timeout`.",
      indent,
    ),
    ...yardTag(`@return [${returnYard(op, schemas)}] ${returnDoc(op)}`, indent),
    ...yardTag(`@raise [${MODULE_NAME}::ApiError] On any non-2xx response.`, indent),
  );

  const signature: string[] = [
    ...args.filter((arg) => !arg.optional).map((arg) => `${arg.name}:`),
    ...(op.body?.required === true ? ["body:"] : []),
    ...args.filter((arg) => arg.optional).map((arg) => `${arg.name}: nil`),
    ...(op.body && !op.body.required ? ["body: nil"] : []),
    "request_options: nil",
  ];

  const method = names.method(op.namespace, op);
  const oneLine = `${indent}def ${method}(${signature.join(", ")})`;
  if (oneLine.length <= 100) {
    lines.push(oneLine);
  } else {
    // No trailing comma: Ruby allows one in a call but not in a `def`.
    lines.push(
      `${indent}def ${method}(`,
      ...signature.map((part, i) => `${indent}  ${part}${i === signature.length - 1 ? "" : ","}`),
      `${indent})`,
    );
  }

  const call: string[] = [
    `${indent}  @transport.request(`,
    `${indent}    http_method: ${JSON.stringify(op.method.toUpperCase())},`,
    `${indent}    path: ${JSON.stringify(op.path)},`,
  ];
  const hash = (label: string, params: Argument[]): string[] => {
    const entries = params.map((p) => `${JSON.stringify(p.wire)} => ${p.name}`);
    const oneLine = `${indent}    ${label}: { ${entries.join(", ")} },`;
    if (oneLine.length <= 100) return [oneLine];
    return [
      `${indent}    ${label}: {`,
      ...entries.map((entry, i) => `${indent}      ${entry}${i === entries.length - 1 ? "" : ","}`),
      `${indent}    },`,
    ];
  };
  const pathArgs = args.filter((_, i) => op.parameters[i]?.in === "path");
  const queryArgs = args.filter((_, i) => op.parameters[i]?.in === "query");
  if (pathArgs.length > 0) call.push(...hash("path_params", pathArgs));
  if (queryArgs.length > 0) call.push(...hash("query", queryArgs));
  if (op.body?.encoding === "multipart") {
    call.push(
      `${indent}    form: body,`,
      `${indent}    form_files: [${files.map((f) => JSON.stringify(f)).join(", ")}],`,
    );
  } else if (op.body) {
    call.push(`${indent}    body: body,`);
  }
  if (op.response.encoding !== "json") {
    call.push(`${indent}    accept: :${op.response.encoding},`);
  }
  call.push(`${indent}    request_options: request_options`, `${indent}  )`, `${indent}end`);

  return [...lines, ...call].join("\n");
}

// ---------------------------------------------------------------------------
// Namespace classes
// ---------------------------------------------------------------------------

/** Emit `node` and every namespace beneath it, children first. */
function emitNamespaces(
  node: NamespaceDef,
  ir: SdkIr,
  names: NameTable,
  schemas: Map<string, SchemaDef>,
  scopeArg: string,
): string[] {
  const out: string[] = [];
  for (const child of node.children.values()) {
    out.push(...emitNamespaces(child, ir, names, schemas, scopeArg));
  }

  const info = names.node(node.path);
  const isRoot = node.path.length === 0;
  const first = [...ir.root.children.keys()][0];
  const lines: string[] = [];

  if (isRoot) {
    const example = first ? `client.${names.child([], first)}` : "client";
    lines.push(
      "  # A client for the Infrawrench API.",
      "  #",
      `  #     client = ${MODULE_NAME}::${CLIENT_CLASS}.new(`,
      '  #       api_key: ENV.fetch("INFRAWRENCH_API_KEY"),',
      `  #       ${scopeArg}: ENV.fetch("INFRAWRENCH_ORG_ID")`,
      "  #     )",
      `  #     ${example}`,
      "  #",
      `  class ${CLIENT_CLASS}`,
      "    # @return [Transport] Shared request plumbing. Reach for this only to",
      "    #   inspect the resolved base URL.",
      "    attr_reader :transport",
    );
  } else {
    lines.push(`  # \`client.${info.dotted}\``, `  class ${info.className}`);
  }

  for (const [key, child] of node.children) {
    const attr = names.child(node.path, key);
    const childInfo = names.node(child.path);
    lines.push(
      `    # @return [${childInfo.className}] \`client.${childInfo.dotted}\``,
      `    attr_reader :${attr}`,
    );
  }

  if (node.children.size > 0) lines.push("");
  if (isRoot) {
    lines.push(
      "    # @param options [Hash] Client configuration — `:base_url`, `:api_key`,",
      `    #   \`:${scopeArg}\`, \`:headers\`, \`:timeout\`, \`:open_timeout\` and \`:http_handler\`.`,
      "    #   See {Transport#initialize}, which owns the list.",
      "    def initialize(**options)",
      "      @transport = Transport.new(**options)",
    );
  } else {
    lines.push(
      "    # @api private",
      "    # @param transport [Transport]",
      "    def initialize(transport)",
      "      @transport = transport",
    );
  }
  for (const [key, child] of node.children) {
    lines.push(
      `      @${names.child(node.path, key)} = ${names.node(child.path).className}.new(@transport)`,
    );
  }
  lines.push("    end");

  for (const op of node.operations) {
    lines.push("");
    lines.push(emitOperation(op, names, schemas, scopeArg));
  }

  lines.push("  end");
  out.push(lines.join("\n"));
  return out;
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

function header(ir: SdkIr): string {
  // The magic comment goes above the banner: Ruby accepts it anywhere in the
  // leading comment block, but every linter and every reader looks at line one.
  return `# frozen_string_literal: true\n\n${fileBanner(ir, HASH_STYLE, PACKAGE_NAME)}`;
}

async function loadRuntime(ir: SdkIr): Promise<string> {
  const source = await readFile(new URL("./runtime.rb", import.meta.url), "utf8");
  const start = source.indexOf(RUNTIME_SENTINEL);
  if (start === -1) {
    throw new Error(`runtime.rb is missing its "${RUNTIME_SENTINEL}" sentinel line`);
  }
  const newline = source.indexOf("\n", start);
  return source
    .slice(newline + 1)
    .replace('"@@BASE_URL@@"', JSON.stringify(ir.baseUrl))
    .replace(
      '"@@SCOPE_PARAM@@"',
      ir.defaultablePathParam === null ? "nil" : JSON.stringify(ir.defaultablePathParam),
    )
    .trim();
}

function versionFile(ir: SdkIr): string {
  return `${header(ir)}
# Kept in its own file so the gemspec can read the version without loading the
# client — a gemspec that pulls in net/http is a gemspec that can fail to parse.
module ${MODULE_NAME}
  VERSION = ${JSON.stringify(ir.apiVersion)}
end
`;
}

function entryFile(ir: SdkIr): string {
  return `${header(ir)}
require_relative "version"
require_relative "transport"
require_relative "client"
`;
}

function aliasFile(ir: SdkIr): string {
  return `${header(ir)}
# The gem is called "${PACKAGE_NAME}" but its code lives under infrawrench/, so
# \`require "${PACKAGE_NAME}"\` would otherwise fail for anyone who typed the
# gem name they installed.
require_relative "infrawrench/sdk"
`;
}

function clientFile(
  ir: SdkIr,
  names: NameTable,
  schemas: Map<string, SchemaDef>,
  scopeArg: string,
): string {
  const classes = emitNamespaces(ir.root, ir, names, schemas, scopeArg);
  return `${header(ir)}
module ${MODULE_NAME}
${classes.join("\n\n")}
end
`;
}

// ---------------------------------------------------------------------------
// RBS
// ---------------------------------------------------------------------------

function emitRbsNamespaces(node: NamespaceDef, names: NameTable): string[] {
  const out: string[] = [];
  for (const child of node.children.values()) out.push(...emitRbsNamespaces(child, names));

  const info = names.node(node.path);
  const isRoot = node.path.length === 0;
  const lines = [`  class ${info.className}`];
  if (isRoot) lines.push("    attr_reader transport: Transport");
  for (const [key, child] of node.children) {
    lines.push(
      `    attr_reader ${names.child(node.path, key)}: ${names.node(child.path).className}`,
    );
  }
  lines.push(
    isRoot ? "    def initialize: (**untyped) -> void" : "    def initialize: (Transport) -> void",
  );

  for (const op of node.operations) {
    const signature = rbsArgs(op, names).join(", ");
    lines.push(`    def ${names.method(node.path, op)}: (${signature}) -> ${returnRbs(op, names)}`);
  }

  lines.push("  end");
  out.push(lines.join("\n"));
  return out;
}

/**
 * The RBS keyword list for one operation, required arguments first.
 *
 * Ruby does not care about keyword order, but a signature that reads
 * `(id: String, ?org_id: String?)` matches the `def` line above it.
 */
function rbsArgs(op: OperationDef, names: NameTable): string[] {
  const typed = operationArgs(op, new Map(), "").map((arg, i) => ({
    arg,
    type: inlineRbs(op.parameters[i]!.type, names),
  }));
  const body = op.body ? inlineRbs(op.body.type, names) : null;
  return [
    ...typed.filter((e) => !e.arg.optional).map((e) => `${e.arg.name}: ${e.type}`),
    ...(body !== null && op.body?.required === true ? [`body: ${body}`] : []),
    ...typed.filter((e) => e.arg.optional).map((e) => `?${e.arg.name}: ${e.type}?`),
    ...(body !== null && op.body?.required !== true ? [`?body: ${body}?`] : []),
    "?request_options: Hash[Symbol, untyped]?",
  ];
}

function sigFile(ir: SdkIr, names: NameTable): string {
  const models = ir.schemas.map((schema) => {
    // The spec name is repeated on every alias, not just the renamed ones: it
    // is what the OpenAPI document and the YARD `@return` tags both say, and it
    // is the only thread back from `type ok` to `components.schemas.Ok`.
    const doc = docComment(
      [schema.description, `Spec schema: \`${schema.name}\`.`],
      HASH_STYLE,
      "  ",
    );
    const head = doc === null ? "" : `${doc}\n`;
    return `${head}  type ${names.alias(schema.name)} = ${printRbs(schema.type, names, "  ")}`;
  });

  return `${fileBanner(ir, HASH_STYLE, PACKAGE_NAME)}
# RBS signatures for the whole gem.
#
# Ruby never loads this; steep, TypeProf and RubyMine do. Every
# \`components.schemas\` entry is a type alias here, which is where the schema
# shapes live — the runtime deliberately returns plain Hashes, so this file is
# the only place the field names are written down.

module ${MODULE_NAME}
  VERSION: String
  DEFAULT_BASE_URL: String
  SCOPE_PARAM: String?

  # Anything that can hand over bytes — File, StringIO, or a custom reader.
  interface _Readable
    def read: () -> String
  end

  class Error < StandardError
  end

  class ConfigurationError < Error
  end

  class ApiError < Error
    attr_reader status: Integer
    attr_reader code: String?
    attr_reader body: untyped
    attr_reader http_method: String
    attr_reader url: String

    def initialize: (
      status: Integer,
      message: String,
      code: String?,
      body: untyped,
      http_method: String,
      url: String
    ) -> void
  end

  class Upload
    attr_reader bytes: String
    attr_reader filename: String
    attr_reader content_type: String

    def initialize: (Upload | _Readable | String, ?filename: String, ?content_type: String) -> void
    def self.coerce: (Upload | _Readable | String) -> Upload
  end

  class Transport
    attr_reader base_url: String

    def initialize: (
      ?base_url: String?,
      ?api_key: String?,
      ?org_id: String?,
      ?headers: Hash[String, String],
      ?timeout: Numeric?,
      ?open_timeout: Numeric?,
      ?http_handler: untyped
    ) -> void

    def request: (
      http_method: String,
      path: String,
      ?path_params: Hash[String, untyped]?,
      ?query: Hash[String, untyped]?,
      ?body: untyped,
      ?form: Hash[String, untyped]?,
      ?form_files: Array[String],
      ?accept: Symbol,
      ?request_options: Hash[Symbol, untyped]?
    ) -> untyped
  end

${models.join("\n\n")}

${emitRbsNamespaces(ir.root, names).join("\n\n")}
end
`;
}

// ---------------------------------------------------------------------------
// Package files
// ---------------------------------------------------------------------------

function gemspec(ir: SdkIr, files: string[]): string {
  const summary = `Generated Ruby client for the ${ir.title} (v${ir.apiVersion}).`;
  const list = files
    .slice()
    .sort()
    .map((file) => `    ${JSON.stringify(file)}`)
    .join(",\n");
  return `# frozen_string_literal: true

${fileBanner(ir, HASH_STYLE, PACKAGE_NAME).trimEnd()}

require_relative "lib/infrawrench/version"

Gem::Specification.new do |spec|
  spec.name = ${JSON.stringify(PACKAGE_NAME)}
  spec.version = ${MODULE_NAME}::VERSION
  spec.summary = ${JSON.stringify(summary)}
  spec.description = ${JSON.stringify(
    `${summary} Covers the published API surface only — operations marked x-internal in the spec are not generated. No runtime dependencies.`,
  )}
  spec.authors = [${JSON.stringify(AUTHOR.name)}${CONTRIBUTORS.map((c) => `, ${JSON.stringify(c.name)}`).join("")}]
  spec.email = [${JSON.stringify(AUTHOR.email)}]
  spec.homepage = ${JSON.stringify(HOMEPAGE)}
  spec.license = ${JSON.stringify(LICENSE)}
  spec.required_ruby_version = ">= 3.0.0"

  spec.metadata = {
    "homepage_uri" => ${JSON.stringify(HOMEPAGE)},
    "source_code_uri" => ${JSON.stringify(REPOSITORY_URL)},
    "bug_tracker_uri" => ${JSON.stringify(ISSUES_URL)},
    # No documentation_uri: it would repeat homepage_uri, and \`gem build\`
    # warns when two metadata keys point at the same page.
    # RubyGems has no first-class keywords field, so they ride in metadata
    # rather than being dropped on the floor.
    "keywords" => ${JSON.stringify([...KEYWORDS].join(","))},
    "rubygems_mfa_required" => "true"
  }

  # Listed rather than globbed: this gem is build output, and a \`git ls-files\`
  # shell-out would break the moment someone packaged it outside a checkout.
  spec.files = [
${list}
  ]
  spec.require_paths = ["lib"]
  spec.extra_rdoc_files = ["README.md", "LICENSE"]

  # Deliberately none: the client is net/http, uri and json from the standard
  # library, so the gem can be dropped into any project without pulling a tree.
end
`;
}

function readme(ir: SdkIr, names: NameTable, scopeArg: string): string {
  const example = ir.operations.find((op) => op.namespace[0] === "accounts" && op.name === "list");
  const call = example
    ? `client.${[...example.namespace.map(snakeCase), names.method(example.namespace, example)].join(".")}`
    : "client";
  // The deepest call the spec produces, so the README shows how far nesting goes.
  const deep = ir.operations.reduce<OperationDef | null>(
    (best, op) => (best === null || op.namespace.length > best.namespace.length ? op : best),
    null,
  );
  const deepCall = deep
    ? `client.${[...deep.namespace.map(snakeCase), names.method(deep.namespace, deep)].join(".")}`
    : call;

  return `# ${PACKAGE_NAME}

Generated Ruby client for the ${ir.title} (API version \`${ir.apiVersion}\`).

**Do not edit this gem by hand** — it is regenerated from \`openapi.json\` and is
not checked into the repository. Run
\`pnpm --filter @infrawrench/web generate:sdk\` to rebuild it; the generator lives
in [\`${GENERATOR_PATH}\`](${REPOSITORY_URL}/tree/main/${GENERATOR_PATH}).

Requires Ruby 3.0+. No runtime dependencies — \`net/http\`, \`uri\` and \`json\`
from the standard library, nothing else.

## Usage

\`\`\`ruby
require "infrawrench/sdk"

client = ${MODULE_NAME}::${CLIENT_CLASS}.new(
  api_key: ENV.fetch("INFRAWRENCH_API_KEY"),
  ${scopeArg}: ENV.fetch("INFRAWRENCH_ORG_ID")
)

begin
  accounts = ${call}
rescue ${MODULE_NAME}::ApiError => e
  warn "\#{e.status} \#{e.code}: \#{e.body}"
end
\`\`\`

Calls are namespaced to mirror the URL structure, so
\`POST /api/org/{${ir.defaultablePathParam ?? "orgId"}}/accounts/{id}/sync\` is
\`client.accounts.sync(id: id)\`, and nesting goes as deep as the paths do —
\`${deepCall}\`. Set \`${scopeArg}:\` once on the client and every org-scoped call can
omit it; pass \`${scopeArg}:\` on an individual call to override it.

Every method takes an optional trailing \`request_options:\` hash (\`:headers\`,
\`:timeout\`, \`:open_timeout\`).

## Responses and errors

Responses are the plain \`Hash\`/\`Array\` that \`JSON.parse\` returns, with String
keys spelled exactly as the wire spells them. There are no model classes — see
[\`${FILES.sig}\`](./${FILES.sig}) for the shape of every one of the
${ir.schemas.length} schemas, as RBS type aliases that steep and TypeProf can read.

Non-2xx responses raise \`${MODULE_NAME}::ApiError\`, which carries \`#status\`,
the parsed \`#body\`, and the machine-readable \`#code\` when the API sends one —
branch on \`#code\`, not on the message. A missing \`${scopeArg}\` raises
\`${MODULE_NAME}::ConfigurationError\` before anything is sent.

## Uploads

File fields accept a String of bytes, any IO, or an \`${MODULE_NAME}::Upload\` when
you want to control the filename and content type:

\`\`\`ruby
client.storage.upload(
  body: {
    "accountId" => account_id,
    "bucket" => bucket,
    "key" => "logs/today.txt",
    "file" => File.open("today.txt")
  }
)
\`\`\`

## Testing

\`http_handler:\` replaces the network call. It receives \`(URI, Net::HTTPRequest)\`
and returns anything that answers \`code\`, \`body\` and \`[]\`:

\`\`\`ruby
client = ${MODULE_NAME}::${CLIENT_CLASS}.new(
  api_key: "test",
  ${scopeArg}: "org_1",
  http_handler: ->(uri, req) { recorded << [req.method, uri.to_s]; fake_response }
)
\`\`\`

## Scope

This gem covers the published API surface only. Operations marked
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

const ARTIFACTS = [
  FILES.gemspec,
  FILES.entry,
  FILES.version,
  FILES.transport,
  FILES.client,
  FILES.sig,
  "LICENSE",
  "README.md",
] as const;

export const rubyTarget: SdkTarget = {
  id: "ruby",
  displayName: "Ruby",
  packageName: PACKAGE_NAME,
  artifacts: ARTIFACTS,

  async generate(ir: SdkIr, ctx: TargetContext): Promise<void> {
    const names = new NameTable();
    for (const schema of ir.schemas) names.registerSchema(schema.name);
    const registerNamespaces = (node: NamespaceDef): void => {
      names.registerNamespace(node);
      for (const child of node.children.values()) registerNamespaces(child);
    };
    registerNamespaces(ir.root);

    const schemas = new Map(ir.schemas.map((schema) => [schema.name, schema]));
    const scopeArg = snakeCase(ir.defaultablePathParam ?? "") || "org_id";

    await ctx.write(FILES.version, versionFile(ir));
    await ctx.write(FILES.transport, `${header(ir)}${await loadRuntime(ir)}\n`);
    await ctx.write(FILES.client, clientFile(ir, names, schemas, scopeArg));
    await ctx.write(FILES.entry, entryFile(ir));
    await ctx.write(FILES.alias, aliasFile(ir));
    await ctx.write(FILES.sig, sigFile(ir, names));
    await ctx.write(FILES.gemspec, gemspec(ir, [...Object.values(FILES), "README.md", "LICENSE"]));
    await ctx.write("README.md", readme(ir, names, scopeArg));
    // MIT requires the license text and copyright notice to travel with every
    // copy, so this is an artifact, not a nicety.
    await ctx.write("LICENSE", LICENSE_TEXT);

    for (const { from, to, why } of names.renamed) {
      ctx.log(`  renamed ${from} → ${to} (${why})`);
    }
  },
};
