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

interface StorageBucket {
  list(prefix?: string): Promise<StorageObject[]>;
  get(key: string): Promise<StorageBody>;
}

interface ResourceHandle {
  /** List all instances of this resource type for the account. */
  list(): Promise<WorkflowResource[]>;
  /** Fetch a single instance by its provider (external) id. */
  get(externalId: string): Promise<WorkflowResource>;
  /** Create an instance (if the plugin supports it). */
  create(fields: Record<string, string>, parentResourceId?: string): Promise<WorkflowResource>;
  /** Update an instance (if the plugin supports it). */
  update(resourceId: string, fields: Record<string, string>): Promise<WorkflowResource>;
  /** Delete an instance (if the plugin supports it). */
  delete(resourceId: string): Promise<void>;
}`;

function accountInterfaceName(pluginId: string): string {
  return `Account_${ident(pluginId)}`;
}

function groupInterfaceName(pluginId: string): string {
  return `AccountGroup_${ident(pluginId)}`;
}

function renderAccountInterface(plugin: WorkflowPluginInfo): string {
  const resourceProps = plugin.resourceTypes
    .map((rt) => `    /** ${rt.pluralDisplayName} */\n    ${strLit(rt.id)}: ResourceHandle;`)
    .join("\n");
  return `interface ${accountInterfaceName(plugin.pluginId)} {
  readonly id: string;
  readonly pluginId: ${strLit(plugin.pluginId)};
  readonly displayName: string;
  readonly resources: {
${resourceProps || "    [resourceTypeId: string]: ResourceHandle;"}
  };
  resolveOutput(typeId: string, resourceId: string, outputKey: string): Promise<string>;
  readonly storage: { bucket(name: string): StorageBucket };
  call<T = unknown>(method: string, args?: Record<string, unknown>): Promise<T>;
}`;
}

function renderGroupInterface(plugin: WorkflowPluginInfo): string {
  const names = plugin.accounts.map((a) => strLit(a.displayName));
  const nameUnion = names.length > 0 ? names.join(" | ") : "string";
  const acct = accountInterfaceName(plugin.pluginId);
  return `interface ${groupInterfaceName(plugin.pluginId)} {
  /** All ${plugin.displayName} accounts. */
  list(): ${acct}[];
  getById(id: string): ${acct};
  /** Look an account up by its display name. */
  getByName(name: ${nameUnion}): ${acct};
}`;
}

function renderMetrics(metrics: MetricDef[]): string {
  if (metrics.length === 0) {
    return `interface InfraMetrics {
  get(key: string): Promise<number | string | boolean | null>;
  set(key: string, value: number | string | boolean): Promise<void>;
}`;
  }
  const getOverloads = metrics
    .map(
      (m) =>
        `  /** ${m.label}${m.unit ? ` (${m.unit})` : ""} */\n  get(key: ${strLit(m.key)}): Promise<${metricTsType(m.type)} | null>;`,
    )
    .join("\n");
  const setOverloads = metrics
    .map((m) => `  set(key: ${strLit(m.key)}, value: ${metricTsType(m.type)}): Promise<void>;`)
    .join("\n");
  return `interface InfraMetrics {
${getOverloads}
${setOverloads}
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
