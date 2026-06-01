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
 * camelCase a human label: the first word is fully lowercased (so leading
 * acronyms read naturally — "DNS Records" → "dnsRecords", "IP Addresses" →
 * "ipAddresses", "R2 Buckets" → "r2Buckets"), and each following word is
 * capitalized with its internal casing kept. MUST stay byte-identical to the
 * prelude's `camel` so generated group names match what the sandbox builds.
 */
function camelCase(raw: string): string {
  const words = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const head = words[0];
  if (!head) return "";
  const tail = words
    .slice(1)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return head.toLowerCase() + tail;
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
  kind?: "text" | "password" | "number" | "boolean" | "select" | "code";
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
 * One grouped accessor per resource type, named after the type's (camelCased,
 * plural) display name — `account.<group>.list()/get(id)`, plus
 * `create/update/delete(...)` only for the ops that provider supports
 * (read-only types get just list + get). Groups are de-duped so a display-name
 * collision can't produce a duplicate property.
 */
function renderResourceGroups(plugin: WorkflowPluginInfo): string {
  const blocks: string[] = [];
  const used = new Set<string>();
  for (const rt of plugin.resourceTypes) {
    const group = camelCase(rt.pluralDisplayName);
    if (!group || used.has(group)) continue;
    used.add(group);
    const prop = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(group) ? group : strLit(group);
    // Storage-capable types return resources you can read objects from.
    const ret = rt.storage ? "StorageResource" : "WorkflowResource";
    const ops: string[] = [];
    ops.push(`    /** List all ${rt.pluralDisplayName}. */\n    list(): Promise<${ret}[]>;`);
    ops.push(
      `    /** Fetch a ${rt.displayName} by its provider id. */\n    get(externalId: string): Promise<${ret}>;`,
    );
    if (rt.supportsCreate)
      ops.push(
        `    /** Create a ${rt.displayName}. */\n    create(fields: Record<string, string>, parentResourceId?: string): Promise<${ret}>;`,
      );
    if (rt.supportsUpdate)
      ops.push(
        `    /** Update a ${rt.displayName}. */\n    update(resourceId: string, fields: Record<string, string>): Promise<${ret}>;`,
      );
    if (rt.supportsDelete)
      ops.push(
        `    /** Delete a ${rt.displayName}. */\n    delete(resourceId: string): Promise<void>;`,
      );
    blocks.push(`  /** ${rt.pluralDisplayName} */\n  readonly ${prop}: {\n${ops.join("\n")}\n  };`);
  }
  return blocks.join("\n");
}

function renderAccountInterface(plugin: WorkflowPluginInfo): string {
  const resourceGroups = renderResourceGroups(plugin);
  return `interface ${accountInterfaceName(plugin.pluginId)} {
  readonly id: string;
  readonly pluginId: ${strLit(plugin.pluginId)};
  readonly displayName: string;
${resourceGroups ? `${resourceGroups}\n` : ""}  resolveOutput(typeId: string, resourceId: string, outputKey: string): Promise<string>;
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
