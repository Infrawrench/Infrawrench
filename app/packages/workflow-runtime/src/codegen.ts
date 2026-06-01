/**
 * Generates the `infra.d.ts` ambient declaration that powers Monaco
 * IntelliSense and (optionally) editor type-checking for a workflow.
 *
 * The shape it declares mirrors exactly what the prelude builds at runtime,
 * specialized with the org/user's real account names and the workflow's
 * declared metrics so authors get autocomplete on `getByName(...)`, resource
 * type ids, and `infra.metrics`.
 */
import type { MetricDef, MetricValueType, WorkflowPluginInfo } from "./types.js";

/** A valid TS identifier fragment derived from an arbitrary id. */
function ident(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** A double-quoted string literal, escaped. */
function strLit(raw: string): string {
  return JSON.stringify(raw);
}

/**
 * PascalCase a human label, preserving existing internal casing (so "R2 Bucket"
 * → "R2Bucket", "DNS Record" → "DNSRecord"). MUST stay byte-identical to the
 * prelude's `pascal` so the generated method names match what the sandbox builds.
 */
function pascalCase(raw: string): string {
  return raw
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/**
 * A union of the given string literals plus an open `string` fallback, so the
 * literals show up as autocomplete suggestions while any other string still
 * type-checks. The fallback is `(string & {})` rather than a plain `string`
 * because `"a" | "b" | string` collapses to just `string` in TypeScript and
 * loses the literal suggestions, whereas `"a" | "b" | (string & {})` keeps them.
 */
function openStringUnion(values: string[]): string {
  if (values.length === 0) return "string";
  return [...values.map(strLit), "(string & {})"].join(" | ");
}

function metricTsType(type: MetricValueType): string {
  switch (type) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "string":
    default:
      return "string";
  }
}

const STATIC_PREAMBLE = `// AUTO-GENERATED — do not edit. Reflects your connected accounts + metrics.

interface PromptSpec {
  message: string;
  kind?: "text" | "password" | "number" | "boolean" | "select";
  options?: { label: string; value: string }[];
  defaultValue?: string;
}

interface WorkflowResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId?: string;
  fields: Record<string, string | number | boolean>;
  resolvedOutputs: Record<string, string>;
}

interface StorageObject {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
}

interface StorageBody {
  base64: string;
  text(): string;
  json<T = unknown>(): T;
}

/** A storage-capable resource (e.g. a bucket): its data plus object read ops. */
interface StorageResource extends WorkflowResource {
  /** List objects in this bucket at a prefix (delimiter "/"). */
  list(prefix?: string): Promise<StorageObject[]>;
  /** Fetch an object's body by key. */
  get(key: string): Promise<StorageBody>;
}`;

function accountInterfaceName(pluginId: string): string {
  return `Account_${ident(pluginId)}`;
}

function groupInterfaceName(pluginId: string): string {
  return `AccountGroup_${ident(pluginId)}`;
}

/**
 * Per-resource-type camelCase methods on the account, named after each type's
 * (plural) display name: `list<Plural>()`, `get<Singular>(externalId)`, and —
 * only when the plugin supports the op — `create/update/delete<Singular>(...)`.
 * Read-only types still get list + get. Names are de-duped so a display-name
 * collision can't produce a duplicate identifier in the interface.
 */
function renderResourceMethods(plugin: WorkflowPluginInfo): string {
  const lines: string[] = [];
  const used = new Set<string>();
  const add = (name: string, decl: string) => {
    if (used.has(name)) return;
    used.add(name);
    lines.push(decl);
  };
  for (const rt of plugin.resourceTypes) {
    const s = pascalCase(rt.displayName);
    const p = pascalCase(rt.pluralDisplayName);
    // Storage-capable types return resources you can read objects from.
    const ret = rt.storage ? "StorageResource" : "WorkflowResource";
    add(`list${p}`, `  /** List all ${rt.pluralDisplayName}. */\n  list${p}(): Promise<${ret}[]>;`);
    add(
      `get${s}`,
      `  /** Fetch a ${rt.displayName} by its provider id. */\n  get${s}(externalId: string): Promise<${ret}>;`,
    );
    if (rt.supportsCreate)
      add(
        `create${s}`,
        `  /** Create a ${rt.displayName}. */\n  create${s}(fields: Record<string, string>, parentResourceId?: string): Promise<${ret}>;`,
      );
    if (rt.supportsUpdate)
      add(
        `update${s}`,
        `  /** Update a ${rt.displayName}. */\n  update${s}(resourceId: string, fields: Record<string, string>): Promise<${ret}>;`,
      );
    if (rt.supportsDelete)
      add(
        `delete${s}`,
        `  /** Delete a ${rt.displayName}. */\n  delete${s}(resourceId: string): Promise<void>;`,
      );
  }
  return lines.join("\n");
}

function renderAccountInterface(plugin: WorkflowPluginInfo): string {
  const resourceMethods = renderResourceMethods(plugin);
  return `interface ${accountInterfaceName(plugin.pluginId)} {
  readonly id: string;
  readonly pluginId: ${strLit(plugin.pluginId)};
  readonly displayName: string;
${resourceMethods ? `${resourceMethods}\n` : ""}  resolveOutput(typeId: string, resourceId: string, outputKey: string): Promise<string>;
}`;
}

function renderGroupInterface(plugin: WorkflowPluginInfo): string {
  const idUnion = openStringUnion(plugin.accounts.map((a) => a.id));
  const nameUnion = openStringUnion(plugin.accounts.map((a) => a.displayName));
  const acct = accountInterfaceName(plugin.pluginId);
  return `interface ${groupInterfaceName(plugin.pluginId)} {
  /** All ${plugin.displayName} accounts. */
  list(): ${acct}[];
  /** Look an account up by its id. */
  getById(id: ${idUnion}): ${acct};
  /** Look an account up by its display name. */
  getByName(name: ${nameUnion}): ${acct};
}`;
}

function renderMetrics(metrics: MetricDef[]): string {
  if (metrics.length === 0) {
    return `interface InfraMetrics {
  [key: string]: number | string | boolean | null;
}`;
  }
  const props = metrics
    .map((m) => {
      const prop = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(m.key) ? m.key : strLit(m.key);
      return `  /** ${m.label}${m.unit ? ` (${m.unit})` : ""} — read/write; \`null\` until first set. */\n  ${prop}: ${metricTsType(m.type)} | null;`;
    })
    .join("\n");
  return `interface InfraMetrics {
${props}
}`;
}

export interface GenerateInfraDtsInput {
  plugins: WorkflowPluginInfo[];
  metrics: MetricDef[];
  /** When false, prompt() is typed as unavailable (automated triggers). */
  interactive?: boolean;
}

/** Build the full `infra.d.ts` source string. */
export function generateInfraDts(input: GenerateInfraDtsInput): string {
  const plugins = input.plugins;
  const interactive = input.interactive ?? true;

  const accountInterfaces = plugins.map(renderAccountInterface).join("\n\n");
  const groupInterfaces = plugins.map(renderGroupInterface).join("\n\n");

  const accountsProps = plugins
    .map(
      (p) =>
        `  /** ${p.displayName} */\n  readonly ${ident(p.pluginId)}: ${groupInterfaceName(p.pluginId)};`,
    )
    .join("\n");

  const promptDecl = interactive
    ? `  /** Prompt the user for input. Only available for manual runs. */\n  prompt(spec: string | PromptSpec): Promise<string | number | boolean | null>;`
    : `  /** Unavailable for automated triggers. */\n  prompt: never;`;

  return `${STATIC_PREAMBLE}

${accountInterfaces || "// (no accounts connected yet)"}

${groupInterfaces}

interface InfraAccounts {
${accountsProps || "  [pluginId: string]: never;"}
}

${renderMetrics(input.metrics)}

interface InfraApi {
  /** Accounts grouped by provider plugin. */
  readonly accounts: InfraAccounts;
${promptDecl}
  /** Read and write this workflow's declared metrics. */
  readonly metrics: InfraMetrics;
  /** Record a JSON-serializable result for this run. */
  output(value: unknown): Promise<void>;
  /** Append a line to the run log. */
  log(...parts: unknown[]): Promise<void>;
}

declare const infra: InfraApi;
`;
}
