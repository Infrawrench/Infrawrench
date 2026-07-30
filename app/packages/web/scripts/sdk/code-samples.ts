/**
 * Per-operation SDK snippets for the published spec.
 *
 * `/docs` (Scalar) shows a code sample next to every operation. Left alone it
 * shows generic HTTP snippets; this module adds an `x-codeSamples` entry per
 * operation showing the call as each of the nine generated SDKs actually
 * spells it — `client.accounts.sync({ id })`, `client.Accounts.Sync(ctx, …)`,
 * and so on.
 *
 * The names come from `buildSdkIr`, the same lowering the SDK generator
 * consumes, so a rename in the generator renames the docs snippets in the same
 * commit. The per-language surface rules (casing, argument passing, the shape
 * of the client constructor) mirror each target in `./targets/*`; they are
 * asserted against the emitted SDKs in `__tests__/code-samples.test.ts`.
 *
 * Snippets elide request bodies with `…` — the schema panel next to the sample
 * documents the body better than a fabricated literal would. Placeholder
 * values are spelled `"<name>"`; enum-typed parameters use the first value the
 * spec declares so the snippet shows a real plugin or resource-type id.
 */
import { buildSdkIr } from "./ir";
import { camelCase, pascalCase, snakeCase } from "./naming";
import { exported as goExported } from "./targets/go/naming";
import type { OperationDef, ParameterDef, SdkIr, TypeRef } from "./types";

export interface CodeSample {
  lang: string;
  label: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Call-site shape
// ---------------------------------------------------------------------------

/** What a sample needs to know about one argument. */
interface Arg {
  /** Wire name, e.g. `pluginId`. */
  name: string;
  required: boolean;
  value:
    | { kind: "enum"; value: string; typeName: string | null }
    | { kind: "placeholder" } // a string the caller supplies; rendered `"<name>"`
    | { kind: "number" }
    | { kind: "boolean" };
}

interface CallSite {
  /** Dotted namespace path in the IR's camelCase, e.g. `["resources", "secretVersions"]`. */
  ns: string[];
  /** Method name in the IR's camelCase, e.g. `add`. */
  name: string;
  /** Path and query parameters in declaration order, without the defaultable org id. */
  args: Arg[];
  hasBody: boolean;
  /** Whether the operation takes the client-level org id at all. */
  orgScoped: boolean;
}

function resolveRef(type: TypeRef, schemas: Map<string, TypeRef>): TypeRef {
  let current = type;
  for (let hops = 0; current.kind === "ref" && hops < 4; hops++) {
    const next = schemas.get(current.name);
    if (!next) break;
    current = next;
  }
  return current;
}

function toArg(param: ParameterDef, schemas: Map<string, TypeRef>): Arg {
  const refName = param.type.kind === "ref" ? param.type.name : null;
  const resolved = resolveRef(param.type, schemas);
  let value: Arg["value"];
  if (resolved.kind === "string" && resolved.enum && resolved.enum.length > 0) {
    value = { kind: "enum", value: resolved.enum[0]!, typeName: refName };
  } else if (resolved.kind === "number") {
    value = { kind: "number" };
  } else if (resolved.kind === "boolean") {
    value = { kind: "boolean" };
  } else {
    value = { kind: "placeholder" };
  }
  return { name: param.name, required: param.required, value };
}

function toCallSite(op: OperationDef, schemas: Map<string, TypeRef>): CallSite {
  const visible = op.parameters.filter((p) => !p.defaultable);
  return {
    ns: op.namespace,
    name: op.name,
    args: visible.map((p) => toArg(p, schemas)),
    hasBody: op.body !== null,
    orgScoped: op.parameters.some((p) => p.defaultable),
  };
}

// ---------------------------------------------------------------------------
// Per-language value spelling
// ---------------------------------------------------------------------------

type Quote = '"' | "'";

/** The default spelling: enums as their literal value, strings as `"<name>"`. */
function literal(arg: Arg, quote: Quote): string {
  switch (arg.value.kind) {
    case "enum":
      return `${quote}${arg.value.value}${quote}`;
    case "number":
      return "1";
    case "boolean":
      return "true";
    case "placeholder":
      return `${quote}<${arg.name}>${quote}`;
  }
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

interface Language {
  lang: string;
  label: string;
  render(call: CallSite): string;
}

const BODY_ELLIPSIS = "…";

function requiredArgs(call: CallSite): Arg[] {
  return call.args.filter((a) => a.required);
}

/**
 * `a, b, c` on one line, or one per line when the list is long. No trailing
 * comma: Java, C#, and Swift reject one in an argument list.
 */
function argList(parts: string[], indent: string, multilineAt = 3): string {
  if (parts.length === 0) return "";
  if (parts.length < multilineAt) return parts.join(", ");
  return `\n${indent}${parts.join(`,\n${indent}`)}\n`;
}

const typescript: Language = {
  lang: "typescript",
  label: "TypeScript",
  render(call) {
    const fields = requiredArgs(call).map((a) => `${a.name}: ${literal(a, '"')}`);
    if (call.hasBody) fields.push(`body: { /* ${BODY_ELLIPSIS} */ }`);
    const dotted = ["client", ...call.ns, call.name].join(".");
    const params =
      fields.length === 0
        ? ""
        : fields.length < 3
          ? `{ ${fields.join(", ")} }`
          : `{\n  ${fields.join(",\n  ")},\n}`;
    const init = call.orgScoped
      ? `const client = new APIV1Client({ apiKey: "<api-key>", orgId: "<org-id>" });`
      : `const client = new APIV1Client({ apiKey: "<api-key>" });`;
    return `${init}\n\nconst result = await ${dotted}(${params});`;
  },
};

const python: Language = {
  lang: "python",
  label: "Python",
  render(call) {
    const fields = requiredArgs(call).map((a) => `${snakeCase(a.name)}=${pyLiteral(a)}`);
    if (call.hasBody) fields.push("body={...}");
    const dotted = ["client", ...call.ns.map(snakeCase), snakeCase(call.name)].join(".");
    const init = call.orgScoped
      ? `client = APIV1Client(api_key="<api-key>", org_id="<org-id>")`
      : `client = APIV1Client(api_key="<api-key>")`;
    return `${init}\n\nresult = ${dotted}(${argList(fields, "    ")})`;
  },
};

function pyLiteral(arg: Arg): string {
  return arg.value.kind === "boolean" ? "True" : literal(arg, '"');
}

const ruby: Language = {
  lang: "ruby",
  label: "Ruby",
  render(call) {
    const fields = requiredArgs(call).map((a) => `${snakeCase(a.name)}: ${literal(a, '"')}`);
    if (call.hasBody) fields.push("body: {...}");
    const dotted = ["client", ...call.ns.map(snakeCase), snakeCase(call.name)].join(".");
    const callExpr = fields.length > 0 ? `${dotted}(${argList(fields, "  ")})` : dotted;
    const init = call.orgScoped
      ? `client = Infrawrench::APIV1Client.new(api_key: "<api-key>", org_id: "<org-id>")`
      : `client = Infrawrench::APIV1Client.new(api_key: "<api-key>")`;
    return `${init}\n\nresult = ${callExpr}`;
  },
};

const go: Language = {
  lang: "go",
  label: "Go",
  render(call) {
    const dotted = ["client", ...call.ns.map(goExported), goExported(call.name)].join(".");
    const init = call.orgScoped
      ? `client := infrawrench.NewAPIV1Client(infrawrench.WithAPIKey("<api-key>"), infrawrench.WithOrgID("<org-id>"))`
      : `client := infrawrench.NewAPIV1Client(infrawrench.WithAPIKey("<api-key>"))`;

    // Mirrors the Go target: no parameters at all → no params argument;
    // everything optional → a nil pointer; otherwise a struct literal.
    let params: string;
    if (call.args.length === 0 && !call.hasBody && !call.orgScoped) {
      params = "";
    } else if (requiredArgs(call).length === 0 && !call.hasBody) {
      params = ", nil";
    } else {
      const structName = `infrawrench.${goExported([...call.ns, call.name].join(" "))}Params`;
      const fields = requiredArgs(call).map((a) => `${goExported(a.name)}: ${literal(a, '"')}`);
      if (call.hasBody) fields.push(`Body: ${BODY_ELLIPSIS}`);
      params =
        fields.length < 3
          ? `, ${structName}{${fields.join(", ")}}`
          : `, ${structName}{\n\t${fields.join(",\n\t")},\n}`;
    }
    return `${init}\n\nresult, err := ${dotted}(ctx${params})`;
  },
};

const java: Language = {
  lang: "java",
  label: "Java",
  render(call) {
    // The Java target generates no optional-parameter overloads: every
    // parameter is in the signature and `null` means "leave it out".
    const parts = call.args.map((a) => (a.required ? literal(a, '"') : "null"));
    if (call.hasBody) parts.push(BODY_ELLIPSIS);
    const dotted = [
      "client",
      ...call.ns.map((n) => `${n}()`),
      `${call.name}(${argList(parts, "    ")})`,
    ].join(".");
    const init = call.orgScoped
      ? `APIV1Client client = APIV1Client.builder().apiKey("<api-key>").orgId("<org-id>").build();`
      : `APIV1Client client = APIV1Client.builder().apiKey("<api-key>").build();`;
    return `${init}\n\nvar result = ${dotted};`;
  },
};

const csharp: Language = {
  lang: "csharp",
  label: "C#",
  render(call) {
    const parts = requiredArgs(call).map((a) => literal(a, '"'));
    if (call.hasBody) parts.push(BODY_ELLIPSIS);
    const dotted = [
      "client",
      ...call.ns.map(pascalCase),
      `${pascalCase(call.name)}Async(${argList(parts, "    ")})`,
    ].join(".");
    const init = call.orgScoped
      ? `using var client = new APIV1Client(new ClientOptions { ApiKey = "<api-key>", OrgId = "<org-id>" });`
      : `using var client = new APIV1Client(new ClientOptions { ApiKey = "<api-key>" });`;
    return `${init}\n\nvar result = await ${dotted};`;
  },
};

const php: Language = {
  lang: "php",
  label: "PHP",
  render(call) {
    const fields = requiredArgs(call).map((a) => `${a.name}: ${literal(a, "'")}`);
    if (call.hasBody) fields.push("body: [...]");
    const dotted = ["$client", ...call.ns, `${call.name}(${argList(fields, "    ")})`].join("->");
    const init = call.orgScoped
      ? `$client = new APIV1Client(apiKey: '<api-key>', orgId: '<org-id>');`
      : `$client = new APIV1Client(apiKey: '<api-key>');`;
    return `${init}\n\n$result = ${dotted};`;
  },
};

const swift: Language = {
  lang: "swift",
  label: "Swift",
  render(call) {
    const fields = requiredArgs(call).map((a) => `${a.name}: ${swiftLiteral(a)}`);
    if (call.hasBody) fields.push(`body: ${BODY_ELLIPSIS}`);
    const dotted = ["client", ...call.ns, `${call.name}(${argList(fields, "    ")})`].join(".");
    const init = call.orgScoped
      ? `let client = APIV1Client(apiKey: "<api-key>", orgId: "<org-id>")`
      : `let client = APIV1Client(apiKey: "<api-key>")`;
    return `${init}\n\nlet result = try await ${dotted}`;
  },
};

function swiftLiteral(arg: Arg): string {
  // A named string enum is a Swift enum whose cases are the camelCased values.
  if (arg.value.kind === "enum" && arg.value.typeName) return `.${camelCase(arg.value.value)}`;
  return literal(arg, '"');
}

const rust: Language = {
  lang: "rust",
  label: "Rust",
  render(call) {
    const dotted = ["client", ...call.ns.map((n) => `${snakeCase(n)}()`)].join(".");
    const method = snakeCase(call.name);

    // Mirrors the Rust target: no parameters at all → no params argument;
    // otherwise one `…Params` struct whose `new` takes the required values.
    let params = "";
    if (call.args.length > 0 || call.hasBody || call.orgScoped) {
      const structName = `${pascalCase([...call.ns, call.name].join(" "))}Params`;
      const parts = requiredArgs(call).map(rustLiteral);
      if (call.hasBody) parts.push(BODY_ELLIPSIS);
      params = `${structName}::new(${argList(parts, "    ")})`;
    }
    const init = call.orgScoped
      ? `let client = APIV1Client::new(ClientConfig::new().api_key("<api-key>").org_id("<org-id>"))?;`
      : `let client = APIV1Client::new(ClientConfig::new().api_key("<api-key>"))?;`;
    return `${init}\n\nlet result = ${dotted}.${method}(${params}).await?;`;
  },
};

function rustLiteral(arg: Arg): string {
  // A named string enum is a Rust enum whose variants are the PascalCased values.
  if (arg.value.kind === "enum" && arg.value.typeName)
    return `${arg.value.typeName}::${pascalCase(arg.value.value)}`;
  return literal(arg, '"');
}

/** Ordered as the client-SDKs docs table orders them. */
const LANGUAGES: Language[] = [typescript, python, ruby, go, java, csharp, php, swift, rust];

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Render the nine SDK samples for one lowered operation. */
export function renderCodeSamples(op: OperationDef, ir: SdkIr): CodeSample[] {
  const schemas = new Map(ir.schemas.map((s) => [s.name, s.type]));
  const call = toCallSite(op, schemas);
  return LANGUAGES.map((language) => ({
    lang: language.lang,
    label: language.label,
    source: language.render(call),
  }));
}

/**
 * Attach `x-codeSamples` to every published operation of `doc`, in place.
 *
 * Runs on the *served* document only (`/openapi.json`, `/docs`) — the
 * committed `openapi.json` stays snippet-free so spec diffs show surface
 * changes, not re-rendered examples. Internal operations get no samples
 * because `buildSdkIr` never sees them.
 */
export function injectSdkCodeSamples(doc: object): void {
  const ir = buildSdkIr(doc);
  const paths = (doc as { paths?: Record<string, Record<string, unknown> | undefined> }).paths;
  for (const op of ir.operations) {
    const target = paths?.[op.path]?.[op.method] as Record<string, unknown> | undefined;
    if (!target) continue;
    target["x-codeSamples"] = renderCodeSamples(op, ir);
  }
}
