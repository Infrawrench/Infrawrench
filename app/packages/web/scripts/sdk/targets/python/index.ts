/**
 * The Python SDK target.
 *
 * Emits an installable `src/`-layout distribution whose importable package is
 * `infrawrench_sdk`, made of four modules:
 *
 *   1. `_transport.py` — the hand-written request plumbing from `./runtime.py`,
 *      copied out verbatim with its three configuration tokens substituted,
 *   2. `models.py` — one declaration per `components.schemas` entry, plus the
 *      anonymous object shapes hoisted out of them,
 *   3. `client.py` — one class per namespace in the dotted call tree, bottomed
 *      out by `APIV1Client`,
 *   4. `__init__.py` — the public surface, re-exported flat.
 *
 * ## Why TypedDict and not dataclasses
 *
 * The wire format is JSON objects, and the transport hands back exactly what
 * `json.loads` produced. A `TypedDict` is a static overlay on that dict: it
 * costs nothing at runtime, needs no constructor or converter for 177 schemas,
 * tolerates fields this snapshot of the spec has never heard of, and lets a
 * caller write a request body as a literal. Dataclasses would mean a decode
 * step on every response — one that either drops unknown keys or raises on
 * them, both of which turn an additive server change into a client break.
 *
 * The cost is that `TypedDict` cannot express a key Python's grammar rejects,
 * and the spec has one (`CostQueryRequest.from`). Hence the functional
 * `TypedDict("Name", {...})` form throughout rather than the class form: it
 * takes its keys from a dict literal, so any string works. Schemas with both
 * required and optional keys get one functional dict per group and a class that
 * inherits both, which is the only spelling of "these keys are required and
 * those are not" that does not need `typing_extensions.NotRequired` — 3.11+ in
 * the standard library, and a dependency on 3.9.
 */
import { readFile } from "node:fs/promises";
import { pascalCase, snakeCase, uniqueName } from "../../naming";
import { HASH_STYLE, docComment, fileBanner, operationDocParts, wrap } from "../../emit";
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
/** The import name. Distribution names may contain a dash; module names may not. */
const MODULE_NAME = "infrawrench_sdk";
const CLIENT_CLASS = "APIV1Client";
const RUNTIME_SENTINEL = "# --8<--";
const PACKAGE_DIR = `src/${MODULE_NAME}`;
const PYTHON_REQUIRES = "3.9";

/** Keywords the grammar rejects as identifiers. Soft keywords are legal, so they stay. */
const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

/**
 * Module-level names the generated package already spends, so a schema that
 * wants one is declared under a `Model` suffix instead. `Error` is not a Python
 * builtin — but `Response` collides with `_transport.Response`, and every
 * typing constructor collides in `models.py`, where schema names and
 * annotations share one namespace.
 */
const RESERVED_NAMES = new Set([
  // exported by ./runtime.py
  "ApiError",
  "ApiTransport",
  "ClientOptions",
  "FileUpload",
  "RequestOptions",
  "Response",
  CLIENT_CLASS,
  // declared by models.py itself
  "JsonAny",
  // typing constructors the emitted annotations name
  "Any",
  "Dict",
  "List",
  "Literal",
  "Mapping",
  "Optional",
  "Tuple",
  "TypedDict",
  "Union",
  // builtins an annotation could plausibly mean
  "None",
  "bool",
  "bytes",
  "dict",
  "float",
  "int",
  "list",
  "str",
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** snake_case, plus PEP 8's trailing-underscore escape for a name the grammar owns. */
function safeIdentifier(name: string): string {
  const base = snakeCase(name) || "value";
  const prefixed = /^[0-9]/.test(base) ? `_${base}` : base;
  return PYTHON_KEYWORDS.has(prefixed) ? `${prefixed}_` : prefixed;
}

/** Python's string escapes are a superset of JSON's, so this is exact. */
function pyString(value: string): string {
  return JSON.stringify(value);
}

function pyLiteral(value: string | null): string {
  return value === null ? "None" : pyString(value);
}

function alphabetical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Resolves spec names to the identifiers `models.py` actually declares. */
class NameTable {
  private readonly taken = new Set(RESERVED_NAMES);
  private readonly schemas = new Map<string, string>();
  private readonly namespaces = new Map<string, string>();
  readonly renamed: Array<{ from: string; to: string }> = [];

  registerSchema(specName: string): void {
    const base = IDENTIFIER.test(specName) ? specName : pascalCase(specName) || "Schema";
    const candidate = this.taken.has(base) ? `${base}Model` : base;
    const resolved = uniqueName(candidate, this.taken);
    if (resolved !== specName) this.renamed.push({ from: specName, to: resolved });
    this.schemas.set(specName, resolved);
  }

  registerNamespace(path: string[]): void {
    const key = path.join(".");
    if (this.namespaces.has(key)) return;
    const base = path.length === 0 ? CLIENT_CLASS : `${path.map(pascalCase).join("")}Namespace`;
    this.namespaces.set(key, path.length === 0 ? base : uniqueName(base, this.taken));
  }

  /** Claim a name for an anonymous object shape lifted into its own TypedDict. */
  hoist(hint: string): string {
    return uniqueName(pascalCase(hint) || "Model", this.taken);
  }

  schema(specName: string): string {
    return this.schemas.get(specName) ?? "Any";
  }

  namespace(path: string[]): string {
    return this.namespaces.get(path.join(".")) ?? CLIENT_CLASS;
  }
}

// ---------------------------------------------------------------------------
// Type printing
// ---------------------------------------------------------------------------

/**
 * Prints `TypeRef`s as Python annotations, lifting every anonymous object it
 * meets into a named `TypedDict` so that nothing degrades to `Dict[str, Any]`
 * for want of a name.
 *
 * References to models print *quoted*. Python evaluates a type alias eagerly,
 * so `A = List[B]` would need `B` declared first and the schema graph does not
 * promise an order that satisfies that; `List["B"]` is a forward reference the
 * type checkers resolve and the interpreter never has to.
 */
class ModelEmitter {
  private readonly declarations: string[] = [];
  /** Bare-ref aliases, appended last: `A = B` is the one form that must resolve now. */
  private readonly aliases: string[] = [];
  private readonly schemaTypes = new Map<string, TypeRef>();
  /** Every public name `models.py` declares, in declaration order. */
  readonly declared: string[] = [];

  constructor(
    private readonly names: NameTable,
    schemas: readonly SchemaDef[],
  ) {
    for (const schema of schemas) this.schemaTypes.set(schema.name, schema.type);
  }

  body(): string {
    return [...this.declarations, ...this.aliases].join("\n\n");
  }

  print(ref: TypeRef, hint: string): string {
    switch (ref.kind) {
      case "ref":
        return pyString(this.names.schema(ref.name));
      case "string":
        return ref.enum ? `Literal[${ref.enum.map(pyString).join(", ")}]` : "str";
      case "number":
        return ref.integer ? "int" : "float";
      case "boolean":
        return "bool";
      case "null":
        return "None";
      case "unknown":
        return "Any";
      case "binary":
        return "FileUpload";
      case "array":
        return `List[${this.print(ref.items, `${hint}Item`)}]`;
      case "object":
        return this.printObject(ref, hint);
      case "union":
        return this.printUnion(ref.members, hint);
      case "intersection":
        return this.printIntersection(ref.members, hint);
    }
  }

  private printObject(ref: Extract<TypeRef, { kind: "object" }>, hint: string): string {
    if (ref.properties.length === 0) {
      return ref.additional
        ? `Dict[str, ${this.print(ref.additional, `${hint}Value`)}]`
        : "JsonAny";
    }
    const name = this.names.hoist(hint);
    this.declareTypedDict(name, ref.properties, []);
    return pyString(name);
  }

  private printUnion(members: readonly TypeRef[], hint: string): string {
    const printed: string[] = [];
    let nullable = false;
    members.forEach((member, index) => {
      const text = this.print(member, `${hint}Variant${index + 1}`);
      if (text === "None") nullable = true;
      else if (!printed.includes(text)) printed.push(text);
    });
    if (printed.length === 0) return "None";
    const joined = printed.length === 1 ? printed[0]! : `Union[${printed.join(", ")}]`;
    return nullable ? `Optional[${joined}]` : joined;
  }

  /**
   * Drop the `allOf` members that constrain nothing, and pull any `null` branch
   * out as nullability. `X & unknown` and `X & {}` are both just `X`.
   */
  private flattenIntersection(members: readonly TypeRef[]): {
    kept: TypeRef[];
    nullable: boolean;
  } {
    let nullable = false;
    const kept: TypeRef[] = [];
    for (const member of members) {
      for (const branch of member.kind === "union" ? member.members : [member]) {
        if (branch.kind === "null") nullable = true;
        else if (branch.kind === "unknown") continue;
        else if (branch.kind === "object" && branch.properties.length === 0 && !branch.additional) {
          continue;
        } else kept.push(branch);
      }
    }
    return { kept, nullable };
  }

  /**
   * The properties of every member combined, or `null` when some member is not
   * a closed object and the combination therefore isn't a `TypedDict`. Later
   * members win, which matches how `allOf` narrows.
   */
  private mergeObjects(members: readonly TypeRef[]): PropertyDef[] | null {
    const merged = new Map<string, PropertyDef>();
    for (const member of members) {
      const object = this.asClosedObject(member);
      if (!object) return null;
      for (const prop of object.properties) merged.set(prop.name, prop);
    }
    return [...merged.values()];
  }

  /** Python has no intersection type, so `allOf` is flattened structurally. */
  private printIntersection(members: readonly TypeRef[], hint: string): string {
    const { kept, nullable } = this.flattenIntersection(members);
    const wrapNull = (text: string): string => (nullable ? `Optional[${text}]` : text);
    if (kept.length === 0) return wrapNull("JsonAny");
    if (kept.length === 1) return wrapNull(this.print(kept[0]!, hint));

    const merged = this.mergeObjects(kept);
    if (merged) {
      const name = this.names.hoist(hint);
      this.declareTypedDict(name, merged, []);
      return wrapNull(pyString(name));
    }

    // Not mergeable — the narrowing member is the most useful thing left to
    // say, and a named one says more than an inline shape.
    const preferred = kept.find((part) => part.kind === "ref") ?? kept[0]!;
    return wrapNull(this.print(preferred, hint));
  }

  /**
   * The closed object a member denotes, following refs; `null` when it isn't
   * one. A nullable schema (`{object} | null`) counts: intersecting it with
   * another object is what rules the `null` branch out.
   */
  private asClosedObject(
    ref: TypeRef,
    seen = new Set<string>(),
  ): Extract<TypeRef, { kind: "object" }> | null {
    if (ref.kind === "ref") {
      if (seen.has(ref.name)) return null;
      seen.add(ref.name);
      const target = this.schemaTypes.get(ref.name);
      return target ? this.asClosedObject(target, seen) : null;
    }
    if (ref.kind === "union") {
      const branches = ref.members.filter((member) => member.kind !== "null");
      return branches.length === 1 ? this.asClosedObject(branches[0]!, seen) : null;
    }
    if (ref.kind !== "object") return null;
    return ref.additional === null && ref.properties.length > 0 ? ref : null;
  }

  /** Declare one `components.schemas` entry under its registered name. */
  declareSchema(schema: SchemaDef): void {
    const name = this.names.schema(schema.name);
    const doc = [
      schema.description,
      name === schema.name ? undefined : `Spec schema: \`${schema.name}\`.`,
    ];

    if (schema.type.kind === "object" && schema.type.additional === null) {
      this.declareTypedDict(name, schema.type.properties, doc);
      return;
    }
    // A mergeable `allOf` is declared under the schema's own name rather than
    // hoisted and aliased, so `Role` is the TypedDict instead of pointing at one.
    if (schema.type.kind === "intersection") {
      const { kept, nullable } = this.flattenIntersection(schema.type.members);
      const merged = kept.length > 1 && !nullable ? this.mergeObjects(kept) : null;
      if (merged) {
        this.declareTypedDict(name, merged, doc);
        return;
      }
    }
    const rhs = this.print(schema.type, name);
    const header = docComment(doc, HASH_STYLE);
    this.declared.push(name);
    const declaration = `${header ? `${header}\n` : ""}${name} = ${rhs}`;
    // `A = "B"` would bind a string rather than alias a type, so unquote it —
    // and defer it to the end of the module, past every name it could mean.
    if (/^"[A-Za-z_][A-Za-z0-9_]*"$/.test(rhs)) {
      this.aliases.push(declaration.replace(rhs, rhs.slice(1, -1)));
    } else {
      this.declarations.push(declaration);
    }
  }

  private fields(owner: string, properties: readonly PropertyDef[]): string[] {
    const lines: string[] = [];
    for (const prop of properties) {
      const doc = docComment(
        [prop.description, prop.deprecated === true ? "Deprecated." : undefined],
        HASH_STYLE,
        "        ",
        88,
      );
      if (doc) lines.push(doc);
      lines.push(
        `        ${pyString(prop.name)}: ${this.print(prop.type, `${owner}${pascalCase(prop.name)}`)},`,
      );
    }
    return lines;
  }

  private declareTypedDict(
    name: string,
    properties: readonly PropertyDef[],
    doc: Array<string | undefined>,
  ): void {
    const header = docComment(doc, HASH_STYLE);
    const prefix = header ? `${header}\n` : "";
    const required = properties.filter((prop) => prop.required);
    const optional = properties.filter((prop) => !prop.required);
    this.declared.push(name);

    const literal = (dictName: string, props: readonly PropertyDef[], total: boolean): string =>
      [
        `${dictName} = TypedDict(`,
        `    ${pyString(dictName)},`,
        "    {",
        ...this.fields(name, props),
        `    },${total ? "" : "\n    total=False,"}`,
        ")",
      ].join("\n");

    if (optional.length === 0) {
      this.declarations.push(prefix + literal(name, required, true));
    } else if (required.length === 0) {
      this.declarations.push(prefix + literal(name, optional, false));
    } else {
      // Two dicts and a class: a functional TypedDict cannot declare a base,
      // and a class-form TypedDict cannot declare a key like `from`. Inheriting
      // one of each is the only spelling that supports both.
      this.declarations.push(
        [
          literal(`_${name}Required`, required, true),
          literal(`_${name}Optional`, optional, false),
          `${prefix}class ${name}(_${name}Required, _${name}Optional):\n    pass`,
        ].join("\n\n"),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Docstrings
// ---------------------------------------------------------------------------

/** Make prose safe inside a non-raw `"""` literal. */
function escapeDocstring(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
}

/**
 * A docstring for one declaration. `prose` is wrapped; `literal` lines are
 * appended verbatim, because a code sample that gets re-flowed is worse than
 * no code sample.
 */
function docstring(
  prose: Array<string | undefined>,
  indent: string,
  literal: readonly string[] = [],
): string[] {
  const blocks = prose.filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  if (blocks.length === 0 && literal.length === 0) return [];
  const wrapped = wrap(escapeDocstring(blocks.join("\n\n")), 88 - indent.length).map((line) =>
    line.trimEnd(),
  );
  const lines =
    literal.length === 0
      ? wrapped
      : [...wrapped, "", ...literal.map((line) => escapeDocstring(line))];
  if (lines.length === 1 && !lines[0]!.endsWith('"')) return [`${indent}"""${lines[0]}"""`];
  return [
    `${indent}"""${lines[0] ?? ""}`,
    ...lines.slice(1).map((line) => (line === "" ? "" : `${indent}${line}`)),
    `${indent}"""`,
  ];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

interface Argument {
  /** Call-site name. */
  name: string;
  type: string;
  optional: boolean;
  doc?: string | undefined;
}

function parameterDoc(param: ParameterDef, scopeKwarg: string | null): string | undefined {
  if (param.defaultable) {
    const base = param.description ? `${param.description.replace(/\.$/, "")}. ` : "";
    return `${base}Defaults to the \`${scopeKwarg}\` the client was constructed with.`;
  }
  return param.description;
}

interface OperationArgs {
  args: Argument[];
  /** Wire parameter name → call-site name. */
  callSite: Map<string, string>;
  requestOptions: string;
  /** Local the response is bound to. */
  result: string;
}

function operationArguments(
  op: OperationDef,
  emitter: ModelEmitter,
  scopeKwarg: string | null,
): OperationArgs {
  const taken = new Set(["self"]);
  const callSite = new Map<string, string>();
  const hint = `${op.namespace.map(pascalCase).join("")}${pascalCase(op.name)}`;

  const args: Argument[] = op.parameters.map((param) => {
    const name = uniqueName(safeIdentifier(param.name), taken);
    callSite.set(param.name, name);
    return {
      name,
      type: emitter.print(param.type, `${hint}${pascalCase(param.name)}`),
      // A defaultable path parameter is required on the wire but optional here:
      // the transport fills it in from client configuration.
      optional: param.defaultable || !param.required,
      doc: parameterDoc(param, scopeKwarg),
    };
  });

  if (op.body) {
    args.push({
      name: uniqueName("body", taken),
      type: emitter.print(
        op.body.type,
        `${hint}${op.body.encoding === "multipart" ? "Form" : "Body"}`,
      ),
      optional: !op.body.required,
      doc:
        op.body.encoding === "multipart"
          ? "Sent as `multipart/form-data`. A binary field takes bytes, or a `(filename, bytes)` tuple."
          : undefined,
    });
  }
  return {
    args,
    callSite,
    requestOptions: uniqueName("request_options", taken),
    result: uniqueName("result", taken),
  };
}

function returnType(op: OperationDef, emitter: ModelEmitter): string {
  switch (op.response.encoding) {
    case "binary":
      return "bytes";
    case "empty":
      return "None";
    case "json": {
      const hint = `${op.namespace.map(pascalCase).join("")}${pascalCase(op.name)}Response`;
      return op.response.type ? emitter.print(op.response.type, hint) : "Any";
    }
  }
}

function emitOperation(
  op: OperationDef,
  emitter: ModelEmitter,
  scopeKwarg: string | null,
  transportExpr: string,
  methodName: string,
): string {
  const { args, callSite, requestOptions, result } = operationArguments(op, emitter, scopeKwarg);
  const resultType = returnType(op, emitter);

  // Keyword-only throughout: every argument is then named at the call site, so
  // adding a parameter can never silently re-bind an existing one, and the
  // required/optional split stops being a constraint on signature order.
  const ordered = [...args.filter((arg) => !arg.optional), ...args.filter((arg) => arg.optional)];
  // The bare `*` goes in even when there is nothing but `request_options`, so
  // that no argument of any method is ever positional.
  const lines: string[] = ["    def " + methodName + "(", "        self,", "        *,"];
  for (const arg of ordered) {
    lines.push(
      arg.optional
        ? `        ${arg.name}: Optional[${arg.type}] = None,`
        : `        ${arg.name}: ${arg.type},`,
    );
  }
  lines.push(`        ${requestOptions}: Optional[RequestOptions] = None,`);
  lines.push(`    ) -> ${resultType}:`);

  // Field lists are pre-wrapped with a hanging indent and passed through as
  // literal lines: re-flowing them would put a continuation in column zero,
  // where every docstring convention reads it as the start of a new field.
  const fieldList = [
    ...ordered.filter((arg) => arg.doc).map((arg) => `:param ${arg.name}: ${arg.doc}`),
    ":raises ApiError: on any non-2xx response.",
  ].flatMap((entry) => {
    const [head, ...rest] = wrap(entry.replace(/\s+/g, " "), 76);
    return [head!, ...rest.map((line) => `    ${line}`)];
  });
  lines.push(...docstring(operationDocParts(op), "        ", fieldList));

  // Bound to an annotated local rather than returned straight out: `request`
  // is typed `Any` because only the call site knows the shape, and returning
  // `Any` from an annotated function is exactly what `mypy --strict` objects to.
  lines.push(
    `        ${result}: ${resultType} = ${transportExpr}.request(`,
    `            method=${pyString(op.method.toUpperCase())},`,
    `            path=${pyString(op.path)},`,
  );
  for (const where of ["path", "query"] as const) {
    const chosen = op.parameters.filter((param) => param.in === where);
    if (chosen.length === 0) continue;
    const keyword = where === "path" ? "path_params" : "query";
    const entries = chosen.map((p) => `${pyString(p.name)}: ${callSite.get(p.name)!}`);
    const inline = `            ${keyword}={${entries.join(", ")}},`;
    if (inline.length <= 96) lines.push(inline);
    else {
      lines.push(
        `            ${keyword}={`,
        ...entries.map((entry) => `                ${entry},`),
        "            },",
      );
    }
  }
  if (op.body) {
    const keyword = op.body.encoding === "multipart" ? "form" : "body";
    lines.push(`            ${keyword}=${args[args.length - 1]!.name},`);
  }
  if (op.response.encoding !== "json") {
    lines.push(`            accept=${pyString(op.response.encoding)},`);
  }
  lines.push(`            options=${requestOptions},`, "        )", `        return ${result}`);
  return lines.join("\n");
}

/** The example call the client docstring and the README both show. */
function exampleCall(ir: SdkIr): string {
  const op = ir.operations.find((each) => each.namespace[0] === "accounts" && each.name === "list");
  if (!op) return "client";
  return `client.${[...op.namespace, op.name].map(safeIdentifier).join(".")}()`;
}

function emitClientInit(ir: SdkIr, scopeKwarg: string | null): string[] {
  const scoped = scopeKwarg !== null;
  return [
    "    def __init__(",
    "        self,",
    "        *,",
    "        base_url: Optional[str] = None,",
    "        api_key: Optional[str] = None,",
    ...(scoped ? [`        ${scopeKwarg}: Optional[str] = None,`] : []),
    "        headers: Optional[Mapping[str, str]] = None,",
    "        timeout: Optional[float] = None,",
    "        opener: Optional[OpenerDirector] = None,",
    "        options: Optional[ClientOptions] = None,",
    "    ) -> None:",
    ...docstring(
      [
        "Configure a client.",
        "`api_key` is sent as `Authorization: Bearer <key>`." +
          (scoped
            ? ` \`${scopeKwarg}\` is filled in for every org-scoped call that does not pass its own.`
            : ""),
        `\`base_url\` defaults to ${ir.baseUrl}, and \`timeout\` is in seconds.`,
        "Pass a prebuilt `ClientOptions` as `options` to set several at once; explicit keyword arguments win over it.",
      ],
      "        ",
    ),
    "        self.transport = ApiTransport(",
    "            options,",
    "            base_url=base_url,",
    "            api_key=api_key,",
    ...(scoped ? [`            org_id=${scopeKwarg},`] : []),
    "            headers=headers,",
    "            timeout=timeout,",
    "            opener=opener,",
    "        )",
  ];
}

/** Emit `node` and every namespace beneath it, children first. */
function emitNamespaces(
  node: NamespaceDef,
  emitter: ModelEmitter,
  names: NameTable,
  ir: SdkIr,
  scopeKwarg: string | null,
): string[] {
  const out: string[] = [];
  for (const child of node.children.values()) {
    out.push(...emitNamespaces(child, emitter, names, ir, scopeKwarg));
  }

  const isRoot = node.path.length === 0;
  // The root exposes its transport: it is the only handle on the resolved base
  // URL, and the seam a test replaces to intercept every call.
  const transportAttr = isRoot ? "self.transport" : "self._transport";
  const lines: string[] = [`class ${names.namespace(node.path)}:`];

  lines.push(
    ...docstring(
      isRoot
        ? ["A client for the Infrawrench API."]
        : [`\`client.${node.path.map(safeIdentifier).join(".")}\``],
      "    ",
      isRoot
        ? [
            "Example:",
            `    client = ${CLIENT_CLASS}(api_key=..., ${scopeKwarg ?? "base_url"}=...)`,
            `    accounts = ${exampleCall(ir)}`,
          ]
        : [],
    ),
    "",
  );

  // Attribute names come from the same casing pass as everything else, so the
  // dotted path a caller writes matches the tree the IR describes.
  const children = [...node.children.entries()].map(([key, child]) => ({
    attribute: safeIdentifier(key),
    className: names.namespace(child.path),
  }));

  lines.push(
    ...(isRoot
      ? emitClientInit(ir, scopeKwarg)
      : [
          "    def __init__(self, transport: ApiTransport) -> None:",
          "        self._transport = transport",
        ]),
  );
  for (const child of children) {
    lines.push(`        self.${child.attribute} = ${child.className}(${transportAttr})`);
  }

  // Methods share the class namespace with the child-namespace attributes, so
  // both go through one uniqueness pass.
  const taken = new Set(["transport", "_transport", ...children.map((child) => child.attribute)]);
  for (const op of node.operations) {
    lines.push("");
    const methodName = uniqueName(safeIdentifier(op.name), taken);
    lines.push(emitOperation(op, emitter, scopeKwarg, transportAttr, methodName));
  }

  out.push(lines.join("\n"));
  return out;
}

// ---------------------------------------------------------------------------
// Module assembly
// ---------------------------------------------------------------------------

const TYPING_NAMES = [
  "Any",
  "Dict",
  "List",
  "Literal",
  "Mapping",
  "Optional",
  "TypedDict",
  "Union",
] as const;

/** Import only the typing names a module body actually mentions. */
function typingImport(body: string): string {
  const used = TYPING_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(body));
  return used.length > 0 ? `from typing import ${used.join(", ")}` : "";
}

function moduleHeader(ir: SdkIr, prose: string[], literal: string[] = []): string {
  return `${fileBanner(ir, HASH_STYLE, PACKAGE_NAME)}${docstring(prose, "", literal).join("\n")}\n`;
}

async function transportModule(ir: SdkIr, scopeKwarg: string | null): Promise<string> {
  const source = await readFile(new URL("./runtime.py", import.meta.url), "utf8");
  const start = source.indexOf(RUNTIME_SENTINEL);
  if (start === -1) {
    throw new Error(`runtime.py is missing its "${RUNTIME_SENTINEL}" sentinel line`);
  }
  const body = source
    .slice(source.indexOf("\n", start) + 1)
    .replace('"@@BASE_URL@@"', pyString(ir.baseUrl))
    .replace('"@@SCOPE_PARAM@@"', pyLiteral(ir.defaultablePathParam))
    .replace('"@@SCOPE_KWARG@@"', pyLiteral(scopeKwarg))
    .trim();

  return [
    moduleHeader(ir, [
      "HTTP plumbing shared by every namespace.",
      "This is the only module that touches the network, and the only one the generator does not write from the spec — see the target's `runtime.py`.",
    ]),
    "",
    body,
    "",
  ].join("\n");
}

function modelsModule(ir: SdkIr, body: string): string {
  return [
    moduleHeader(ir, [
      "Request and response shapes for every `components.schemas` entry, plus the anonymous object shapes hoisted out of them.",
      "These are `TypedDict`s, so at runtime each one is a plain `dict`: a response can be used exactly as `json.loads` returned it, and a request body can be written as a literal.",
    ]),
    "",
    // `Dict[str, Any]` is needed by JsonAny below even when no schema prints it.
    typingImport(`${body} Dict Any`),
    ...(body.includes("FileUpload") ? ["", "from ._transport import FileUpload"] : []),
    "",
    // Reached by any object the spec declines to describe: no properties, and
    // no constraint on the ones it might have.
    "JsonAny = Dict[str, Any]",
    "",
    body,
    "",
  ].join("\n");
}

function clientModule(ir: SdkIr, classes: string[], allModels: readonly string[]): string {
  const body = classes.join("\n\n\n");
  const runtime = ["ApiTransport", "ClientOptions", "RequestOptions"];
  if (body.includes("FileUpload")) runtime.splice(2, 0, "FileUpload");
  // Every model reference in a signature is printed quoted, so matching on the
  // quoted name is exact — and narrower than "everything the emitter touched
  // while printing these classes", which counts the models that only appear
  // inside another model's fields.
  const models = allModels.filter((name) => body.includes(`"${name}"`));

  return [
    moduleHeader(ir, [
      `The dotted call tree, rooted at \`${CLIENT_CLASS}\`.`,
      "Each namespace mirrors a run of URL segments, so `POST /api/org/{orgId}/resources/{pluginId}/{typeId}/secret-versions/add` is `client.resources.secret_versions.add(...)`.",
    ]),
    // Annotations stay unevaluated, which keeps forward references to models
    // free and stops a method named `list` from shadowing the builtin in an
    // annotation resolved in class scope.
    "from __future__ import annotations",
    "",
    typingImport(body),
    "",
    "from urllib.request import OpenerDirector",
    "",
    `from ._transport import ${runtime.join(", ")}`,
    ...(models.length > 0
      ? ["from .models import (", ...models.map((name) => `    ${name},`), ")"]
      : []),
    "",
    "",
    body,
    "",
  ].join("\n");
}

function initModule(ir: SdkIr, models: readonly string[], scopeKwarg: string | null): string {
  const runtimeExports = [
    "ApiError",
    "ApiTransport",
    "ClientOptions",
    "FileUpload",
    "RequestOptions",
    "Response",
  ];
  const exported = [CLIENT_CLASS, ...runtimeExports, ...models].sort(alphabetical);

  return [
    moduleHeader(
      ir,
      [`${PACKAGE_NAME} — a generated client for the ${ir.title} (v${ir.apiVersion}).`],
      [
        "Example:",
        `    from ${MODULE_NAME} import ${CLIENT_CLASS}, ApiError`,
        "",
        `    client = ${CLIENT_CLASS}(api_key="...", ${scopeKwarg ?? "base_url"}="...")`,
      ],
    ),
    "",
    `from ._transport import (\n${runtimeExports.map((name) => `    ${name},`).join("\n")}\n)`,
    `from .client import ${CLIENT_CLASS}`,
    ...(models.length > 0
      ? [`from .models import (\n${models.map((name) => `    ${name},`).join("\n")}\n)`]
      : []),
    "",
    `__version__ = ${pyString(ir.apiVersion)}`,
    "",
    `__all__ = [\n${exported.map((name) => `    ${pyString(name)},`).join("\n")}\n]`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Package files
// ---------------------------------------------------------------------------

/** TOML basic strings escape the same way JSON strings do. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return values.length === 0
    ? "[]"
    : `[\n${values.map((v) => `  ${tomlString(v)},`).join("\n")}\n]`;
}

function tomlPeople(people: ReadonlyArray<{ name: string; email: string }>): string {
  const rows = people.map(
    (person) => `  { name = ${tomlString(person.name)}, email = ${tomlString(person.email)} },`,
  );
  return `[\n${rows.join("\n")}\n]`;
}

function pyproject(ir: SdkIr): string {
  return `${fileBanner(ir, HASH_STYLE, PACKAGE_NAME)}
[build-system]
requires = ["hatchling>=1.21"]
build-backend = "hatchling.build"

[project]
name = ${tomlString(PACKAGE_NAME)}
version = ${tomlString(ir.apiVersion)}
description = ${tomlString(`Generated Python client for the ${ir.title} (v${ir.apiVersion}).`)}
readme = "README.md"
requires-python = ${tomlString(`>=${PYTHON_REQUIRES}`)}
license = { text = ${tomlString(LICENSE)} }
authors = ${tomlPeople([AUTHOR])}
maintainers = ${tomlPeople(CONTRIBUTORS)}
keywords = ${tomlArray(KEYWORDS)}
classifiers = ${tomlArray([
    "Development Status :: 4 - Beta",
    "Intended Audience :: Developers",
    "License :: OSI Approved :: MIT License",
    "Programming Language :: Python :: 3",
    "Programming Language :: Python :: 3.9",
    "Programming Language :: Python :: 3.10",
    "Programming Language :: Python :: 3.11",
    "Programming Language :: Python :: 3.12",
    "Programming Language :: Python :: 3.13",
    "Programming Language :: Python :: Implementation :: CPython",
    "Topic :: Software Development :: Libraries :: Python Modules",
    "Typing :: Typed",
  ])}

# Deliberately empty: the client speaks HTTP through urllib and JSON through
# the json module, so installing it never pulls a tree in behind it.
dependencies = []

[project.urls]
Homepage = ${tomlString(HOMEPAGE)}
Repository = ${tomlString(REPOSITORY_URL)}
Issues = ${tomlString(ISSUES_URL)}

[tool.hatch.build.targets.wheel]
packages = [${tomlString(PACKAGE_DIR)}]

[tool.hatch.build.targets.sdist]
include = ["src", "README.md", "LICENSE", "pyproject.toml"]
`;
}

function readme(ir: SdkIr, scopeKwarg: string | null): string {
  const orgKwarg = scopeKwarg ?? "org_id";
  return `# ${PACKAGE_NAME}

Generated Python client for the ${ir.title} (API version \`${ir.apiVersion}\`).

**Do not edit this package by hand** — it is regenerated from \`openapi.json\` and
is not checked into the repository. Run
\`pnpm --filter @infrawrench/web generate:sdk\` to rebuild it; the generator lives
in [\`${GENERATOR_PATH}\`](${REPOSITORY_URL}/tree/main/${GENERATOR_PATH}).

## Install

\`\`\`sh
pip install ${PACKAGE_NAME}
\`\`\`

Requires Python ${PYTHON_REQUIRES}+ and nothing else: the client is built on
\`urllib.request\` and \`json\` from the standard library.

## Usage

\`\`\`python
import os

from ${MODULE_NAME} import ${CLIENT_CLASS}, ApiError

client = ${CLIENT_CLASS}(
    api_key=os.environ["INFRAWRENCH_API_KEY"],
    ${orgKwarg}=os.environ["INFRAWRENCH_ORG_ID"],
)

try:
    accounts = ${exampleCall(ir)}
except ApiError as error:
    print(error.status, error.code, error.body)
\`\`\`

Calls are namespaced to mirror the URL structure, so
\`POST /api/org/{orgId}/accounts/{id}/sync\` is \`client.accounts.sync(id=...)\`.
Every argument is keyword-only. Set \`${orgKwarg}\` once on the client and every
org-scoped call can omit it; pass \`${orgKwarg}=\` on an individual call to
override it there.

Every method also takes \`request_options=RequestOptions(...)\` for per-call
\`headers\` and \`timeout\`. Non-2xx responses raise \`ApiError\`, which carries
\`status\`, the parsed \`body\`, and the machine-readable \`code\` when the API sends
one.

## Types

Models are \`TypedDict\`s, so responses are ordinary dicts and request bodies can
be written as literals:

\`\`\`python
client.resources.secret_versions.add(
    plugin_id="aws",
    type_id="s3_bucket",
    body={"resourceId": resource_id, "value": "..."},
)
\`\`\`

The package ships \`py.typed\` (PEP 561), so mypy and pyright check those calls
against the spec without a stub package.

## Scope

This package covers the published API surface only. Operations marked
\`x-internal\` in the spec — the admin surface, webhook receivers, desktop sync,
push registration, and the browser auth redirects — are not generated.

## License

${LICENSE} — see [\`LICENSE\`](./LICENSE). ${COPYRIGHT_NOTICE}.

Note that this client is more permissively licensed than the service it talks
to: the Infrawrench source is BUSL-1.1, but the generated clients are ${LICENSE}
so you can link one into your own software without inheriting those terms.

Issues: <${ISSUES_URL}>
`;
}

// ---------------------------------------------------------------------------

export const pythonTarget: SdkTarget = {
  id: "python",
  displayName: "Python",
  packageName: PACKAGE_NAME,
  artifacts: [
    "pyproject.toml",
    "README.md",
    "LICENSE",
    `${PACKAGE_DIR}/__init__.py`,
    `${PACKAGE_DIR}/_transport.py`,
    `${PACKAGE_DIR}/client.py`,
    `${PACKAGE_DIR}/models.py`,
    `${PACKAGE_DIR}/py.typed`,
  ],

  async generate(ir: SdkIr, ctx: TargetContext): Promise<void> {
    const scopeKwarg = ir.defaultablePathParam ? safeIdentifier(ir.defaultablePathParam) : null;

    const names = new NameTable();
    for (const schema of ir.schemas) names.registerSchema(schema.name);
    const registerNamespaces = (node: NamespaceDef): void => {
      names.registerNamespace(node.path);
      for (const child of node.children.values()) registerNamespaces(child);
    };
    registerNamespaces(ir.root);

    // Schemas first, so they keep their spec names; the anonymous shapes lifted
    // out of the operations take whatever is left.
    const emitter = new ModelEmitter(names, ir.schemas);
    for (const schema of ir.schemas) emitter.declareSchema(schema);

    // Emitting the namespaces hoists more models, so this has to run before
    // `models.py` is serialized.
    const classes = emitNamespaces(ir.root, emitter, names, ir, scopeKwarg);
    const allModels = [...emitter.declared].sort(alphabetical);

    await ctx.write("pyproject.toml", pyproject(ir));
    await ctx.write("README.md", readme(ir, scopeKwarg));
    // MIT requires the license text and copyright notice to travel with every
    // copy, so this is an artifact, not a nicety.
    await ctx.write("LICENSE", LICENSE_TEXT);
    await ctx.write(`${PACKAGE_DIR}/_transport.py`, await transportModule(ir, scopeKwarg));
    await ctx.write(`${PACKAGE_DIR}/models.py`, modelsModule(ir, emitter.body()));
    await ctx.write(`${PACKAGE_DIR}/client.py`, clientModule(ir, classes, allModels));
    await ctx.write(`${PACKAGE_DIR}/__init__.py`, initModule(ir, allModels, scopeKwarg));
    // PEP 561: without this marker every annotation in the package is invisible
    // to type checkers, and the PEP asks for exactly an empty file.
    await ctx.write(`${PACKAGE_DIR}/py.typed`, "");

    for (const { from, to } of names.renamed) {
      ctx.log(`  renamed schema ${from} → ${to} (collides with a reserved name)`);
    }
    ctx.log(`  ${emitter.declared.length} models, ${ir.operations.length} operations`);
  },
};
