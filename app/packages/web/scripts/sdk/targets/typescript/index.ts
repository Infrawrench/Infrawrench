/**
 * The TypeScript SDK target.
 *
 * Emits a single self-contained module — `index.ts` — made of three parts:
 *
 *   1. the hand-written request plumbing from `./runtime.ts`, inlined verbatim,
 *   2. one declaration per `components.schemas` entry,
 *   3. one class per namespace in the dotted call tree, bottomed out by
 *      `APIV1Client`, which owns the transport and the top-level namespaces.
 *
 * That module is then compiled with the TypeScript compiler API and deleted,
 * leaving the four files the package ships: `index.js`, `index.js.map`,
 * `index.d.ts`, and a `package.json` with no dependencies at all — the map
 * inlines its sources, so nothing is lost by dropping the `.ts`. Compiling
 * (rather than emitting
 * `.js` and `.d.ts` from two separate printers) is what guarantees the runtime
 * and the types can't drift apart, and it typechecks the generated code as a
 * side effect — a bug in this file fails the build instead of shipping.
 */
import { readFile, rm } from "node:fs/promises";
import ts from "typescript";
import { pascalCase, uniqueName } from "../../naming";
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

const PACKAGE_NAME = "@infrawrench/sdk";
const CLIENT_CLASS = "APIV1Client";
const RUNTIME_SENTINEL = "// --8<--";

/**
 * Names the generated module already uses, plus the globals it relies on.
 * A schema whose spec name lands here is declared under a `Model` suffix —
 * `components.schemas.Error` cannot be `Error` next to `class ApiError extends
 * Error`, and silently shadowing it produces code that does not compile.
 */
const RESERVED_NAMES = new Set([
  // emitted by ./runtime.ts
  "ClientOptions",
  "RequestOptions",
  "RequestSpec",
  "ApiError",
  "ApiTransport",
  CLIENT_CLASS,
  // globals the emitted code names
  "Array",
  "ArrayBuffer",
  "Blob",
  "Boolean",
  "Date",
  "Error",
  "File",
  "FormData",
  "Function",
  "Headers",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "RegExp",
  "Request",
  "Response",
  "Set",
  "String",
  "Symbol",
  "URL",
  "URLSearchParams",
  // utility types a consumer would expect to mean the TS built-in
  "Awaited",
  "Exclude",
  "Extract",
  "NonNullable",
  "Omit",
  "Parameters",
  "Partial",
  "Pick",
  "Readonly",
  "Record",
  "Required",
  "ReturnType",
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Resolves spec names to the identifiers the module actually declares.
 * Schemas are registered first so they keep their spec names wherever possible;
 * namespace classes take what's left.
 */
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

  schema(specName: string): string {
    return this.schemas.get(specName) ?? "unknown";
  }

  namespace(path: string[]): string {
    return this.namespaces.get(path.join(".")) ?? CLIENT_CLASS;
  }
}

// ---------------------------------------------------------------------------
// Type printing
// ---------------------------------------------------------------------------

/** Join union/intersection members, breaking onto one line each when long. */
function joinMembers(parts: string[], separator: "|" | "&", indent: string): string {
  const oneLine = parts.join(` ${separator} `);
  if (oneLine.length <= 90 && !oneLine.includes("\n")) return oneLine;
  return `\n${parts.map((part) => `${indent}  ${separator} ${part}`).join("\n")}`;
}

/** Members that would re-associate wrongly need parentheses. */
function parenthesize(member: TypeRef, printed: string, within: "union" | "intersection"): string {
  const needs = within === "union" ? member.kind === "intersection" : member.kind === "union";
  return needs ? `(${printed})` : printed;
}

function printType(ref: TypeRef, names: NameTable, indent: string): string {
  switch (ref.kind) {
    case "ref":
      return names.schema(ref.name);
    case "string":
      return ref.enum
        ? joinMembers(
            ref.enum.map((value) => JSON.stringify(value)),
            "|",
            indent,
          )
        : "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "binary":
      return "Blob";
    case "unknown":
      return "unknown";
    case "array":
      return `Array<${printType(ref.items, names, indent)}>`;
    case "union":
      return joinMembers(
        ref.members.map((m) => parenthesize(m, printType(m, names, indent), "union")),
        "|",
        indent,
      );
    case "intersection":
      return joinMembers(
        ref.members.map((m) => parenthesize(m, printType(m, names, indent), "intersection")),
        "&",
        indent,
      );
    case "object":
      return printObject(ref, names, indent);
  }
}

function printObject(
  ref: Extract<TypeRef, { kind: "object" }>,
  names: NameTable,
  indent: string,
): string {
  const index = ref.additional
    ? `Record<string, ${printType(ref.additional, names, indent)}>`
    : null;
  if (ref.properties.length === 0) return index ?? "Record<string, never>";

  const inner = `${indent}  `;
  const lines: string[] = ["{"];
  for (const prop of ref.properties) {
    const doc = docComment(
      [prop.description, prop.deprecated === true ? "@deprecated" : undefined],
      inner,
    );
    if (doc) lines.push(doc);
    const key = IDENTIFIER.test(prop.name) ? prop.name : JSON.stringify(prop.name);
    lines.push(`${inner}${key}${prop.required ? "" : "?"}: ${printType(prop.type, names, inner)};`);
  }
  lines.push(`${indent}}`);
  const literal = lines.join("\n");
  return index ? `${literal} & ${index}` : literal;
}

/** A JSDoc block, or `null` when there is nothing worth saying. */
function docComment(parts: Array<string | undefined>, indent: string): string | null {
  const blocks = parts.filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  if (blocks.length === 0) return null;
  const lines = blocks
    .join("\n\n")
    .replace(/\*\//g, "*\\/")
    .split("\n")
    .map((line) => line.trimEnd());
  if (lines.length === 1) return `${indent}/** ${lines[0]} */`;
  return [
    `${indent}/**`,
    ...lines.map((line) => (line === "" ? `${indent} *` : `${indent} * ${line}`)),
    `${indent} */`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

function emitSchema(schema: SchemaDef, names: NameTable): string {
  const name = names.schema(schema.name);
  const doc = docComment(
    [schema.description, name === schema.name ? undefined : `Spec schema: \`${schema.name}\`.`],
    "",
  );
  const head = doc ? `${doc}\n` : "";

  // A plain closed object is nicer to consumers as an interface: it shows up by
  // name in editor tooltips and can be extended by hand.
  if (
    schema.type.kind === "object" &&
    schema.type.additional === null &&
    schema.type.properties.length > 0
  ) {
    return `${head}export interface ${name} ${printObject(schema.type, names, "")}\n`;
  }
  return `${head}export type ${name} = ${printType(schema.type, names, "")};\n`;
}

interface Field {
  name: string;
  type: string;
  optional: boolean;
  doc?: string | undefined;
}

function parameterDoc(param: ParameterDef): string | undefined {
  if (param.defaultable) {
    const base = param.description ? `${param.description.replace(/\.$/, "")}. ` : "";
    return `${base}Defaults to the \`orgId\` the client was constructed with.`;
  }
  return param.description;
}

function operationFields(op: OperationDef, names: NameTable, indent: string): Field[] {
  const fields: Field[] = op.parameters.map((param) => ({
    name: param.name,
    type: printType(param.type, names, indent),
    // A defaultable path parameter is required on the wire but optional here —
    // the transport fills it in from client configuration.
    optional: param.defaultable || !param.required,
    doc: parameterDoc(param),
  }));
  if (op.body) {
    fields.push({
      name: "body",
      type: printType(op.body.type, names, indent),
      optional: !op.body.required,
      doc: op.body.encoding === "multipart" ? "Sent as `multipart/form-data`." : undefined,
    });
  }
  return fields;
}

function returnType(op: OperationDef, names: NameTable): string {
  switch (op.response.encoding) {
    case "binary":
      return "Blob";
    case "empty":
      return "void";
    case "json":
      return op.response.type ? printType(op.response.type, names, "  ") : "unknown";
  }
}

function emitOperation(op: OperationDef, names: NameTable): string {
  const indent = "  ";
  const fields = operationFields(op, names, `${indent}  `);
  const allOptional = fields.every((field) => field.optional);
  const access = allOptional ? "params?." : "params.";

  const errorLines = op.errors.map(
    (error) => `@throws {ApiError} \`${error.status}\` — ${error.description ?? "Error"}`,
  );
  const doc = docComment(
    [
      op.summary,
      op.description,
      `\`${op.method.toUpperCase()} ${op.path}\``,
      op.deprecated ? "@deprecated" : undefined,
      ...errorLines,
    ],
    indent,
  );

  const lines: string[] = [];
  if (doc) lines.push(doc);

  const signature: string[] = [];
  if (fields.length > 0) {
    const inner = `${indent}    `;
    const body: string[] = [];
    for (const field of fields) {
      const fieldDoc = docComment([field.doc], inner);
      if (fieldDoc) body.push(fieldDoc);
      body.push(`${inner}${field.name}${field.optional ? "?" : ""}: ${field.type};`);
    }
    signature.push(`${indent}  params${allOptional ? "?" : ""}: {`, ...body, `${indent}  },`);
  }
  signature.push(`${indent}  options?: RequestOptions,`);

  const spec: string[] = [
    `${indent}      method: ${JSON.stringify(op.method.toUpperCase())},`,
    `${indent}      path: ${JSON.stringify(op.path)},`,
  ];
  const pathParams = op.parameters.filter((param) => param.in === "path");
  if (pathParams.length > 0) {
    const entries = pathParams.map((param) => `${param.name}: ${access}${param.name}`).join(", ");
    spec.push(`${indent}      pathParams: { ${entries} },`);
  }
  const queryParams = op.parameters.filter((param) => param.in === "query");
  if (queryParams.length > 0) {
    const entries = queryParams.map((param) => `${param.name}: ${access}${param.name}`).join(", ");
    spec.push(`${indent}      query: { ${entries} },`);
  }
  if (op.body?.encoding === "multipart") {
    // Spread into a fresh object literal on the way out: an `interface` gets no
    // implicit index signature, so `StorageUploadForm` is not assignable to
    // `Record<string, unknown>` while `{ ...form }` is.
    const value = op.body.required
      ? `{ ...${access}body }`
      : `${access}body === undefined ? undefined : { ...${access}body }`;
    spec.push(`${indent}      form: ${value},`);
  } else if (op.body) {
    spec.push(`${indent}      body: ${access}body,`);
  }
  if (op.response.encoding !== "json") {
    spec.push(`${indent}      accept: ${JSON.stringify(op.response.encoding)},`);
  }

  lines.push(
    `${indent}${op.name}(`,
    ...signature,
    `${indent}): Promise<${returnType(op, names)}> {`,
    `${indent}  return this._t.request<${returnType(op, names)}>(`,
    `${indent}    {`,
    ...spec,
    `${indent}    },`,
    `${indent}    options,`,
    `${indent}  );`,
    `${indent}}`,
  );
  return lines.join("\n");
}

/** Emit `node` and every namespace beneath it, children first. */
function emitNamespaces(node: NamespaceDef, names: NameTable): string[] {
  const out: string[] = [];
  for (const child of node.children.values()) out.push(...emitNamespaces(child, names));

  const isRoot = node.path.length === 0;
  const className = names.namespace(node.path);
  const lines: string[] = [];

  if (isRoot) {
    lines.push(
      "/**",
      " * A client for the Infrawrench API.",
      " *",
      " * ```ts",
      ` * const client = new ${CLIENT_CLASS}({ apiKey: process.env.INFRAWRENCH_API_KEY, orgId });`,
      " * const accounts = await client.accounts.list();",
      " * ```",
      " */",
    );
  } else {
    lines.push(`/** \`client.${node.path.join(".")}\` */`);
  }

  lines.push(`export class ${className} {`);

  if (isRoot) {
    lines.push(
      "  /** Shared request plumbing. Reach for this only to inspect the resolved base URL. */",
      "  readonly transport: ApiTransport;",
    );
  } else {
    lines.push("  private readonly _t: ApiTransport;");
  }

  for (const [key, child] of node.children) {
    lines.push(
      `  readonly ${IDENTIFIER.test(key) ? key : JSON.stringify(key)}: ${names.namespace(child.path)};`,
    );
  }

  lines.push("");
  lines.push(
    isRoot
      ? `  constructor(options: ClientOptions = {}) {`
      : `  constructor(transport: ApiTransport) {`,
  );
  const transportExpr = isRoot ? "this.transport" : "transport";
  lines.push(
    isRoot ? "    this.transport = new ApiTransport(options);" : "    this._t = transport;",
  );
  for (const [key, child] of node.children) {
    const prop = IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
    lines.push(`    this${prop} = new ${names.namespace(child.path)}(${transportExpr});`);
  }
  lines.push("  }");

  // Root-level operations reach the transport by its public name.
  const rootPatched = isRoot
    ? node.operations.map((op) =>
        emitOperation(op, names).replace(/this\._t\./g, "this.transport."),
      )
    : node.operations.map((op) => emitOperation(op, names));
  for (const op of rootPatched) {
    lines.push("");
    lines.push(op);
  }

  lines.push("}");
  out.push(lines.join("\n"));
  return out;
}

// ---------------------------------------------------------------------------
// Module assembly
// ---------------------------------------------------------------------------

function banner(ir: SdkIr): string {
  return [
    // A `/*!` block: minifiers and bundlers preserve these, so the notice
    // survives into whatever the consumer ships. That matters more than usual
    // here, because the whole client is one file someone may well inline.
    "/*!",
    ` * ${PACKAGE_NAME} v${ir.apiVersion} | ${LICENSE} | ${COPYRIGHT_NOTICE}`,
    ` * ${REPOSITORY_URL}`,
    " */",
    "/**",
    ` * ${PACKAGE_NAME} — generated from the ${ir.title} OpenAPI 3.1 spec.`,
    " *",
    ` * API version: ${ir.apiVersion}`,
    ` * Default base URL: ${ir.baseUrl}`,
    ` * Operations: ${ir.operations.length}`,
    " *",
    " * DO NOT EDIT. Regenerate with:",
    " *   pnpm --filter @infrawrench/web generate:sdk",
    " *",
    " * Internal routes are absent by construction: the generator consumes the",
    " * same published spec that /openapi.json serves, which drops every",
    " * operation marked x-internal.",
    " */",
    "",
  ].join("\n");
}

async function loadRuntime(ir: SdkIr): Promise<string> {
  const source = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
  const start = source.indexOf(RUNTIME_SENTINEL);
  if (start === -1) {
    throw new Error(`runtime.ts is missing its "${RUNTIME_SENTINEL}" sentinel line`);
  }
  const newline = source.indexOf("\n", start);
  return source
    .slice(newline + 1)
    .replace('"@@BASE_URL@@"', JSON.stringify(ir.baseUrl))
    .replace('"@@SCOPE_PARAM@@"', JSON.stringify(ir.defaultablePathParam))
    .trim();
}

async function buildModule(
  ir: SdkIr,
  names: NameTable,
  log: (message: string) => void,
): Promise<string> {
  const sections: string[] = [banner(ir), await loadRuntime(ir)];

  sections.push(
    [
      "// ---------------------------------------------------------------------------",
      "// Models",
      "// ---------------------------------------------------------------------------",
    ].join("\n"),
  );
  for (const schema of ir.schemas) sections.push(emitSchema(schema, names).trimEnd());

  sections.push(
    [
      "// ---------------------------------------------------------------------------",
      "// Client",
      "// ---------------------------------------------------------------------------",
    ].join("\n"),
  );
  sections.push(...emitNamespaces(ir.root, names));

  for (const { from, to } of names.renamed) {
    log(`  renamed schema ${from} → ${to} (collides with a reserved name)`);
  }

  return `${sections.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  declaration: true,
  // `inlineSources` is what lets us delete index.ts after compiling: the map
  // carries the TypeScript source inside it, so a debugger can still show the
  // original even though the file is gone.
  sourceMap: true,
  inlineSources: true,
  declarationMap: false,
  removeComments: false,
  newLine: ts.NewLineKind.LineFeed,
  skipLibCheck: true,
  forceConsistentCasingInFileNames: true,
};

function compile(entry: string, outDir: string): void {
  const program = ts.createProgram([entry], { ...COMPILER_OPTIONS, rootDir: outDir, outDir });
  const result = program.emit();
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .concat(result.diagnostics)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length === 0) return;

  const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => outDir,
    getNewLine: () => "\n",
  });
  throw new Error(
    `The generated SDK does not compile — this is a bug in the generator, not in the spec.\n\n${formatted}`,
  );
}

// ---------------------------------------------------------------------------
// Package files
// ---------------------------------------------------------------------------

function packageJson(ir: SdkIr): string {
  return `${JSON.stringify(
    {
      name: PACKAGE_NAME,
      version: ir.apiVersion,
      description: `Generated TypeScript client for the ${ir.title} (v${ir.apiVersion}).`,
      keywords: [...KEYWORDS],
      license: LICENSE,
      author: { ...AUTHOR },
      contributors: CONTRIBUTORS.map((contributor) => ({ ...contributor })),
      homepage: HOMEPAGE,
      // No `directory`: that field points at a package's home *inside* the
      // repository, and this one is generated build output that is never
      // committed. The generator's path is in the README instead.
      repository: { type: "git", url: `git+${REPOSITORY_URL}.git` },
      bugs: { url: ISSUES_URL, email: AUTHOR.email },
      type: "module",
      main: "./index.js",
      module: "./index.js",
      types: "./index.d.ts",
      exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
      files: ["index.js", "index.js.map", "index.d.ts", "README.md", "LICENSE"],
      sideEffects: false,
      engines: { node: ">=18" },
      // Deliberately empty: the client uses nothing but global fetch, so the
      // package can be dropped into any project without pulling in a tree.
      dependencies: {},
    },
    null,
    2,
  )}\n`;
}

function readme(ir: SdkIr): string {
  const example = ir.operations.find((op) => op.namespace[0] === "accounts" && op.name === "list");
  const call = example ? `client.${[...example.namespace, example.name].join(".")}()` : "client";
  return `# ${PACKAGE_NAME}

Generated TypeScript client for the ${ir.title} (API version \`${ir.apiVersion}\`).

**Do not edit this package by hand** — it is regenerated from \`openapi.json\` and
is not checked into the repository. Run
\`pnpm --filter @infrawrench/web generate:sdk\` to rebuild it; the generator lives
in [\`${GENERATOR_PATH}\`](${REPOSITORY_URL}/tree/main/${GENERATOR_PATH}).

There is no \`index.ts\` to read: the TypeScript source is compiled away, and
\`index.js.map\` carries it inline so debuggers can still step through it.

## Usage

\`\`\`ts
import { ${CLIENT_CLASS}, ApiError } from "${PACKAGE_NAME}";

const client = new ${CLIENT_CLASS}({
  apiKey: process.env.INFRAWRENCH_API_KEY,
  orgId: process.env.INFRAWRENCH_ORG_ID,
});

try {
  const accounts = await ${call};
} catch (error) {
  if (error instanceof ApiError) console.error(error.status, error.body);
}
\`\`\`

Calls are namespaced to mirror the URL structure, so \`POST /api/org/{orgId}/accounts/{id}/sync\`
is \`client.accounts.sync({ id })\`. Set \`orgId\` once on the client and every
org-scoped call can omit it; pass \`orgId\` on an individual call to override.

Every method takes an optional trailing \`RequestOptions\` (\`signal\`, \`headers\`,
\`timeoutMs\`). Non-2xx responses throw \`ApiError\`, which carries \`status\`,
the parsed \`body\`, and the machine-readable \`code\` when the API sends one.

## Scope

This package covers the published API surface only. Operations marked
\`x-internal\` in the spec — the admin surface, webhook receivers, desktop sync,
push registration, and the browser auth redirects — are not generated.

Requires Node 18+ (or any runtime with global \`fetch\`). No dependencies.

## License

${LICENSE} — see [\`LICENSE\`](./LICENSE). ${COPYRIGHT_NOTICE}.

Note that this client is more permissively licensed than the service it talks
to: the Infrawrench source is BUSL-1.1, but the generated clients are ${LICENSE} so you
can link one into your own software without inheriting those terms.

Issues: <${ISSUES_URL}>
`;
}

// ---------------------------------------------------------------------------

export const typescriptTarget: SdkTarget = {
  id: "typescript",
  displayName: "TypeScript",
  packageName: PACKAGE_NAME,
  artifacts: ["package.json", "index.js", "index.js.map", "index.d.ts", "LICENSE"],

  async generate(ir: SdkIr, ctx: TargetContext): Promise<void> {
    const names = new NameTable();
    for (const schema of ir.schemas) names.registerSchema(schema.name);
    const registerNamespaces = (node: NamespaceDef): void => {
      names.registerNamespace(node.path);
      for (const child of node.children.values()) registerNamespaces(child);
    };
    registerNamespaces(ir.root);

    await ctx.write("index.ts", await buildModule(ir, names, ctx.log));
    await ctx.write("package.json", packageJson(ir));
    await ctx.write("README.md", readme(ir));
    // MIT requires the license text and copyright notice to travel with every
    // copy, so this is an artifact, not a nicety.
    await ctx.write("LICENSE", LICENSE_TEXT);

    ctx.log("  compiling index.ts → index.js + index.js.map + index.d.ts");
    compile(`${ctx.outDir}/index.ts`, ctx.outDir);

    // The TypeScript source was scaffolding. Consumers get `index.d.ts` for
    // types and `index.js.map` (with `inlineSources`) for debugging, so leaving
    // index.ts behind would only invite someone to edit a file that the next
    // run overwrites.
    await rm(`${ctx.outDir}/index.ts`);
  },
};
