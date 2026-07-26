/**
 * Generates the `infra.d.ts` ambient declaration that powers Monaco
 * IntelliSense and (optionally) editor type-checking for a workflow.
 *
 * The shape it declares mirrors exactly what the prelude builds at runtime,
 * specialized with the org/user's real account names and the workflow's
 * declared metrics so authors get autocomplete on `getByName(...)`, resource
 * type ids, and `infra.metrics`.
 */
import type {
  MetricDef,
  MetricValueType,
  WorkflowCreateFieldInfo,
  WorkflowPluginInfo,
  WorkflowResourceTypeInfo,
  WorkflowTriggerKind,
} from "./types.js";

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

/**
 * The TS type for a `create(fields)` / `update(fields)` argument. When the host
 * supplied distilled create fields, emit a typed object literal — required
 * fields un-suffixed, optional fields `?`, and fields with a known option list
 * as an open string union (literal suggestions + open `string`). `ssh-key-picker`
 * fields suggest the caller's Infrawrench SSH key names (a name is resolved to
 * its public key at create time; a raw public key is also accepted). Falls back
 * to the generic `Record<string, string>` when no field schema is available.
 */
function renderCreateFieldsType(
  fields: WorkflowCreateFieldInfo[] | undefined,
  sshKeyNames: string[],
): string {
  if (!fields || fields.length === 0) return "Record<string, string>";
  const props = fields.map((f) => {
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(f.key) ? f.key : strLit(f.key);
    let valueType: string;
    if (f.kind === "ssh-key-picker") {
      valueType = openStringUnion(sshKeyNames);
    } else if (f.options && f.options.length > 0) {
      valueType = openStringUnion(f.options);
    } else {
      valueType = "string";
    }
    const doc = f.description ? `/** ${f.description.replace(/\*\//g, "*\\/")} */ ` : "";
    return `${doc}${key}${f.required ? "" : "?"}: ${valueType}`;
  });
  return `{ ${props.join("; ")} }`;
}

/**
 * The `SshExecOptions` interface, generated so `sshKey` suggests the caller's
 * Infrawrench SSH key names while still accepting any string (id or name).
 */
function renderSshExecOptions(sshKeyNames: string[]): string {
  return `interface SshExecOptions {
  /** Infrawrench SSH key (by name or id) whose private half authenticates the connection. */
  sshKey?: ${openStringUnion(sshKeyNames)};
  /** Login user (defaults to the resource type's SSH endpoint default, e.g. "root"). */
  username?: string;
  /** "utf8" (default) decodes output to a string; "binary" returns raw bytes. */
  encoding?: "utf8" | "binary";
  /** Connection/command timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Skip SSH host-key verification (accept whatever key the host presents and
   * don't pin it). Use for ephemeral/recreated hosts whose key changes; it
   * disables MITM protection, so only set it when you trust the network path.
   */
  skipHostKeyCheck?: boolean;
}`;
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

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface PromptSpec {
  message: string;
  kind?: "text" | "password" | "number" | "boolean" | "select" | "code";
  options?: { label: string; value: string }[];
  defaultValue?: string;
}

/** A readable byte stream — async-iterable, with a WHATWG-style reader. */
interface SshReadable extends AsyncIterable<Uint8Array> {
  getReader(): {
    read(): Promise<{ value?: Uint8Array; done: boolean }>;
    releaseLock(): void;
    cancel(): Promise<void>;
  };
}

/**
 * The result of a streaming \`ssh(cmd, { stream: true })\`: separate \`stdout\`
 * and \`stderr\` byte streams. The object is itself async-iterable over stdout
 * (so \`for await (const chunk of streams)\` still works). Pass the whole object
 * to \`infra.log(...)\` to stream both to the run log live — stderr in red.
 */
interface SshStreams extends AsyncIterable<Uint8Array> {
  stdout: SshReadable;
  stderr: SshReadable;
}

/** Common data carried by every resource. Per-type interfaces add the
 * capability methods (ssh/query/kv/…) that resource type actually supports. */
interface WorkflowResourceBase {
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

/** A directory entry returned by \`resource.sftp.list(...)\`. */
interface SftpEntry {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
}`;

/**
 * Capability method snippets, emitted into a resource type's interface only when
 * that type supports the capability (see WorkflowResourceTypeInfo.capabilities).
 */
const CAP_MEMBERS = {
  ssh: `  /** Stream the command's output as { stdout, stderr } byte streams (pass to infra.log to tail). */
  ssh(command: string, opts: SshExecOptions & { stream: true }): SshStreams;
  /** Run a command over SSH and resolve its full stdout as raw bytes. */
  ssh(command: string, opts: SshExecOptions & { encoding: "binary" }): Promise<Uint8Array>;
  /** Run a command over SSH and resolve its full stdout as a string. */
  ssh(command: string, opts?: SshExecOptions): Promise<string>;
  /** Resolve once the resource accepts SSH connections (or reject on timeout). */
  waitUntilReachable(opts?: { timeoutMs?: number; port?: number }): Promise<void>;`,
  delete: `  /** Delete this resource. */
  delete(): Promise<void>;`,
  sftp: `  /** SFTP file operations over this resource's SSH endpoint. */
  readonly sftp: {
    /** List a remote directory. */
    list(path: string, opts?: SshExecOptions): Promise<SftpEntry[]>;
    /** Download a remote file decoded to a UTF-8 string. */
    get(path: string, opts: SshExecOptions & { encoding: "utf8" }): Promise<string>;
    /** Download a remote file's bytes. */
    get(path: string, opts?: SshExecOptions): Promise<Uint8Array>;
    /** Upload bytes (or a string) to a remote path. */
    put(path: string, data: Uint8Array | string, opts?: SshExecOptions): Promise<void>;
    /** Create a remote directory. */
    mkdir(path: string, opts?: SshExecOptions): Promise<void>;
    /** Delete a remote file (or directory with { recursive: true }). */
    delete(path: string, opts?: SshExecOptions & { recursive?: boolean }): Promise<void>;
  };`,
  storage: `  /** List objects in this bucket at a prefix (delimiter "/"). */
  list(prefix?: string): Promise<StorageObject[]>;
  /** Fetch an object's body by key. */
  get(key: string): Promise<StorageBody>;`,
  sql: `  /** Run a SQL query against this resource. */
  query(sql: string): Promise<{ rows: Record<string, unknown>[]; durationMs?: number }>;`,
  kv: `  /** Key-value operations on this namespace. */
  readonly kv: {
    list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ items: { key: string }[]; nextCursor?: string }>;
    get(key: string): Promise<string>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };`,
  nosql: `  /** Run a document-store command (Firestore/MongoDB/DynamoDB). */
  nosql(command: string, args?: (string | number)[]): Promise<unknown>;`,
  logs: `  /** Fetch recent logs; returns text + available containers. */
  logs(opts?: { tailLines?: number; container?: string; previous?: boolean }): Promise<{ text: string; containers: string[]; activeContainer: string }>;`,
  describe: `  /** Plain-text "describe" of this resource. */
  describe(): Promise<string>;`,
  manifest: `  /** Fetch this resource's full manifest as JSON/YAML text. */
  getManifest(): Promise<string>;
  /** Apply an updated manifest to this resource. */
  applyManifest(manifest: string): Promise<void>;`,
  publish: `  /** Publish a message to this pub/sub resource. */
  publish(message: string | { body: string; extras?: Record<string, string | Record<string, string>> }): Promise<{ id?: string; summary?: string }>;`,
  metrics: `  /** Fetch this resource's provider metric series. */
  metrics(timeRange?: { startMs: number; endMs: number }): Promise<{ label: string; unit?: string; points: { timestamp: number; value: number }[] }[]>;`,
};

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
function resourceTypeInterfaceName(pluginId: string, typeId: string): string {
  return `Resource_${ident(pluginId)}_${ident(typeId)}`;
}

/** The resource types that get a group (de-duped by camelCased plural name). */
function dedupedResourceTypes(plugin: WorkflowPluginInfo): WorkflowResourceTypeInfo[] {
  const used = new Set<string>();
  const out: WorkflowResourceTypeInfo[] = [];
  for (const rt of plugin.resourceTypes) {
    const group = camelCase(rt.pluralDisplayName);
    if (!group || used.has(group)) continue;
    used.add(group);
    out.push(rt);
  }
  return out;
}

/**
 * Per-type resource interface: the common data (WorkflowResourceBase) plus ONLY
 * the capability methods this resource type actually supports, so a Cloudflare
 * DNS record doesn't advertise `.ssh()` or `.kv`.
 */
function renderResourceTypeInterface(
  plugin: WorkflowPluginInfo,
  rt: WorkflowResourceTypeInfo,
): string {
  const caps = rt.capabilities ?? {};
  const members: string[] = [];
  if (caps.ssh) members.push(CAP_MEMBERS.ssh);
  if (caps.sftp) members.push(CAP_MEMBERS.sftp);
  if (rt.storage) members.push(CAP_MEMBERS.storage);
  if (caps.sql) members.push(CAP_MEMBERS.sql);
  if (caps.kv) members.push(CAP_MEMBERS.kv);
  if (caps.nosql) members.push(CAP_MEMBERS.nosql);
  if (caps.logs) members.push(CAP_MEMBERS.logs);
  if (caps.describe) members.push(CAP_MEMBERS.describe);
  if (caps.manifest) members.push(CAP_MEMBERS.manifest);
  if (caps.publish) members.push(CAP_MEMBERS.publish);
  if (caps.metrics) members.push(CAP_MEMBERS.metrics);
  if (rt.supportsDelete) members.push(CAP_MEMBERS.delete);
  const name = resourceTypeInterfaceName(plugin.pluginId, rt.id);
  return `interface ${name} extends WorkflowResourceBase {${members.length ? `\n${members.join("\n")}\n` : ""}}`;
}

/** All per-type resource interfaces for a plugin (one per deduped group). */
function renderResourceTypeInterfaces(plugin: WorkflowPluginInfo): string {
  return dedupedResourceTypes(plugin)
    .map((rt) => renderResourceTypeInterface(plugin, rt))
    .join("\n\n");
}

function renderResourceGroups(plugin: WorkflowPluginInfo, sshKeyNames: string[]): string {
  const blocks: string[] = [];
  for (const rt of dedupedResourceTypes(plugin)) {
    const group = camelCase(rt.pluralDisplayName);
    const prop = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(group) ? group : strLit(group);
    // Each type's accessors return its own per-type interface.
    const ret = resourceTypeInterfaceName(plugin.pluginId, rt.id);
    const ops: string[] = [];
    ops.push(`    /** List all ${rt.pluralDisplayName}. */\n    list(): Promise<${ret}[]>;`);
    ops.push(
      `    /** Fetch a ${rt.displayName} by its provider id. */\n    get(externalId: string): Promise<${ret}>;`,
    );
    if (rt.supportsCreate) {
      const createFieldsType = renderCreateFieldsType(rt.createFields, sshKeyNames);
      ops.push(
        `    /** Create a ${rt.displayName}. */\n    create(fields: ${createFieldsType}, parentResourceId?: string): Promise<${ret}>;`,
      );
    }
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

function renderAccountInterface(plugin: WorkflowPluginInfo, sshKeyNames: string[]): string {
  const resourceGroups = renderResourceGroups(plugin, sshKeyNames);
  const importYaml = plugin.supportsImportYaml
    ? `\n  /** Apply arbitrary (multi-document) YAML to this account (kubectl apply -f). */\n  importYaml(yaml: string): Promise<{ applied: number }>;`
    : "";
  return `interface ${accountInterfaceName(plugin.pluginId)} {
  readonly id: string;
  readonly pluginId: ${strLit(plugin.pluginId)};
  readonly displayName: string;
${resourceGroups ? `${resourceGroups}\n` : ""}  resolveOutput(typeId: string, resourceId: string, outputKey: string): Promise<string>;${importYaml}
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

/**
 * The `infra.event` type for this workflow's trigger. Budget triggers carry a
 * payload (which budget, which threshold, what the spend actually was) so the
 * body can act on the numbers; the other kinds only report how they were
 * invoked. Mirrors `WorkflowEvent` in types.ts.
 */
function renderEventType(kind: WorkflowTriggerKind): string {
  if (kind !== "budget") {
    return `/** What started this run. */
interface WorkflowEvent {
  readonly kind: "manual" | "cron" | "git" | "api";
}`;
  }
  return `/**
 * The budget crossing that started this run. Amounts are in the budget
 * currency's minor unit (cents).
 */
interface WorkflowEvent {
  readonly kind: "budget";
  readonly budgetId: string;
  readonly budgetName: string;
  /** Calendar month the crossing was observed in, \`YYYY-MM\`. */
  readonly month: string;
  /** ISO-4217 code of every amount below. */
  readonly currency: string;
  /** The budget's monthly limit. */
  readonly amountCents: number;
  /** Which measure crossed the threshold. */
  readonly metric: "actual" | "forecast";
  /** The threshold that fired, as a percentage of \`amountCents\`. */
  readonly percent: number;
  /** Value of \`metric\` when it crossed. */
  readonly observedCents: number;
  /** Month-to-date spend. */
  readonly actualCents: number;
  /** Projected month-end spend; \`null\` when there wasn't enough data. */
  readonly forecastCents: number | null;
}`;
}

/**
 * `infra.costs` — reporting spend from sources that have no provider plugin
 * (a SaaS invoice, an internal chargeback, a colo bill). Rows land in the same
 * store the provider collectors write to, so they show up in cost graphs,
 * dimension filters, and budgets alongside everything else. Mirrors
 * `WorkflowCostRow` in types.ts.
 */
const COSTS_INTERFACE = `interface CostRowInput {
  /** UTC day the spend belongs to, \`YYYY-MM-DD\`. */
  date: string;
  /** ISO-4217 currency code, e.g. "USD". Rows are never merged across currencies. */
  currency: string;
  /** Money for this day/dimension combination. Negative for credits. */
  amount: number;
  /** Free-form service name, e.g. "Snowflake Compute" — a group/filter value. */
  service?: string;
  region?: string;
  /** Opaque id of the thing being billed; groups the "resource" dimension. */
  resourceId?: string;
  /** Cost-allocation tags. Keys starting with \`infrawrench:\` are reserved. */
  tags?: Record<string, string>;
  /** Units consumed, for unit-cost reporting. */
  usageAmount?: number;
  usageUnit?: string;
  /**
   * Attribute this row to one of your connected accounts (an account id from
   * \`infra.accounts\`). Omit to attribute it to this workflow.
   */
  accountId?: string;
}

interface InfraCosts {
  /**
   * Write daily spend rows. Re-writing the same day + service + region +
   * resource + tags + currency **replaces** the previous value rather than
   * adding to it, so a cron that re-reports a trailing window is safe to run
   * repeatedly. Rows always carry this workflow's id as a reserved tag and
   * report "Workflow" as their provider, so they can never overwrite spend
   * collected from a provider's billing API.
   */
  write(rows: CostRowInput | CostRowInput[]): Promise<{ written: number }>;
}`;

export interface GenerateInfraDtsInput {
  plugins: WorkflowPluginInfo[];
  metrics: MetricDef[];
  /** When false, prompt() is typed as unavailable (automated triggers). */
  interactive?: boolean;
  /**
   * The workflow's trigger kind. Narrows `infra.event` — a budget-triggered
   * workflow gets the full crossing payload typed, everything else gets the
   * bare `{ kind }` discriminant.
   */
  triggerKind?: WorkflowTriggerKind;
  /**
   * Whether this host can store cost data (cloud only — costs live in
   * ClickHouse). When false, `infra.costs` is typed `never` so a desktop
   * author sees it's unavailable while editing instead of at run time.
   */
  costs?: boolean;
  /**
   * Names of the caller's Infrawrench-managed SSH keys. Surfaced as autocomplete
   * for `ssh-key-picker` create fields and `resource.ssh`'s `sshKey` option.
   * Fetched fresh per typings request so newly-added keys appear immediately.
   */
  sshKeyNames?: string[];
}

/** Build the full `infra.d.ts` source string. */
export function generateInfraDts(input: GenerateInfraDtsInput): string {
  const plugins = input.plugins;
  const interactive = input.interactive ?? true;
  const sshKeyNames = input.sshKeyNames ?? [];

  const resourceInterfaces = plugins.map(renderResourceTypeInterfaces).filter(Boolean).join("\n\n");
  const accountInterfaces = plugins.map((p) => renderAccountInterface(p, sshKeyNames)).join("\n\n");
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

  const costsDecl =
    input.costs === false
      ? `  /** Unavailable here — cost reporting needs the cloud's cost store. */\n  costs: never;`
      : `  /** Report spend from a source Infrawrench has no plugin for. */\n  readonly costs: InfraCosts;`;

  return `${STATIC_PREAMBLE}

${renderEventType(input.triggerKind ?? "manual")}

${input.costs === false ? "" : COSTS_INTERFACE}

${renderSshExecOptions(sshKeyNames)}

${resourceInterfaces}

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
  /** What started this run. Frozen. */
  readonly event: WorkflowEvent;
${costsDecl}
  /** Record a JSON-serializable result for this run. */
  output(value: JsonValue): Promise<void>;
  /** Stream an SSH \`{ stdout, stderr }\` object to the run log live (stderr in red). */
  log(streams: SshStreams): Promise<void>;
  /** Append a line to the run log. Byte buffers (Uint8Array/ArrayBuffer) are decoded as UTF-8 text. */
  log(...parts: unknown[]): Promise<void>;
}

declare const infra: InfraApi;
`;
}
