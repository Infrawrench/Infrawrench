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
  WorkflowSidecarInfo,
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

/** The interface holding a peer plugin's grouped accessors on a resource. */
function sidecarInterfaceName(pluginId: string): string {
  return `Sidecar_${ident(pluginId)}`;
}

/** The resource types that get a group (de-duped by camelCased plural name). */
function dedupedResourceTypes(types: WorkflowResourceTypeInfo[]): WorkflowResourceTypeInfo[] {
  const used = new Set<string>();
  const out: WorkflowResourceTypeInfo[] = [];
  for (const rt of types) {
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
 *
 * Types that expose peer plugins (a managed cluster, a managed database) also
 * get one property per peer — `cluster.kubernetes` — so what lives *inside* the
 * resource is reachable from the resource itself rather than only guessable.
 */
function renderResourceTypeInterface(pluginId: string, rt: WorkflowResourceTypeInfo): string {
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
  for (const sc of rt.sidecars ?? []) {
    if (sc.resourceTypes.length === 0) continue;
    // Keyed by plugin id, exactly as the prelude builds it.
    const prop = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(sc.pluginId) ? sc.pluginId : strLit(sc.pluginId);
    members.push(
      `  /** ${sc.displayName} running inside this ${rt.displayName} (the "${sc.tabLabel}" tab). */\n  readonly ${prop}: ${sidecarInterfaceName(sc.pluginId)};`,
    );
  }
  const name = resourceTypeInterfaceName(pluginId, rt.id);
  return `interface ${name} extends WorkflowResourceBase {${members.length ? `\n${members.join("\n")}\n` : ""}}`;
}

/**
 * A peer plugin's grouped accessors, as reached through a parent resource.
 * Shape-identical to an account's resource groups — the difference is only
 * where the credentials came from, which the runtime handles.
 */
function renderSidecarInterface(
  sc: WorkflowSidecarInfo,
  sshKeyNames: string[],
  readOnly = false,
): string {
  const groups = renderResourceGroups(sc.pluginId, sc.resourceTypes, sshKeyNames);
  const importYaml = readOnly
    ? ""
    : `
  /** Apply arbitrary (multi-document) YAML inside this resource's ${sc.displayName} (kubectl apply -f). */
  importYaml(yaml: string): Promise<{ applied: number }>;`;
  return `/** ${sc.displayName} inside a parent resource. */
interface ${sidecarInterfaceName(sc.pluginId)} {
${groups}${importYaml}
}`;
}

function renderResourceGroups(
  pluginId: string,
  types: WorkflowResourceTypeInfo[],
  sshKeyNames: string[],
): string {
  const blocks: string[] = [];
  for (const rt of dedupedResourceTypes(types)) {
    const group = camelCase(rt.pluralDisplayName);
    const prop = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(group) ? group : strLit(group);
    // Each type's accessors return its own per-type interface.
    const ret = resourceTypeInterfaceName(pluginId, rt.id);
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
      ops.push(
        `    /** The regions a ${rt.displayName} can be created in, with flag/location — hand the list to select() for a country picker; \`--set\` matches the short label. Empty when the type has no region choice. */\n    regions(): Promise<{ id: string; label: string; location?: string; flag?: string }[]>;`,
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
  const resourceGroups = renderResourceGroups(plugin.pluginId, plugin.resourceTypes, sshKeyNames);
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

/**
 * `infra.page` — raising an alert to the humans who own the workflow. The
 * cooldown is enforced by the host and keyed, so a cron that keeps finding the
 * same problem pages once instead of once per run. Mirrors `PageSpec` /
 * `PageResult` in types.ts.
 */
const PAGE_INTERFACE = `interface PageOptions {
  /** Short headline for the notification. Defaults to this workflow's name. */
  title?: string;
  /**
   * Throttle key. Pages sharing a key are suppressed while that key is in
   * cooldown. Use a per-object key (a pod name, a cluster id) to alert once
   * per object; the default single key alerts once for the whole workflow.
   */
  key?: string;
  /**
   * Minutes to suppress repeat pages under the same key. Defaults to 60;
   * \`0\` sends on every call.
   */
  cooldownMinutes?: number;
  /**
   * Also place a voice call to recipients who opted into voice. Off by
   * default — reserve it for things worth waking someone up for.
   */
  voice?: boolean;
}

interface PageSpec extends PageOptions {
  /** The alert text. Becomes the SMS body and the notification body. */
  message: string;
}

interface PageResult {
  /** True when at least one recipient was reached on any transport. */
  readonly delivered: boolean;
  /** True when the key was still in cooldown, so nothing was sent. */
  readonly suppressed: boolean;
  /** Twilio deliveries (SMS + voice) that Twilio accepted. */
  readonly sms: number;
  /** Push notifications accepted by Expo. */
  readonly push: number;
  /** Slack channel posts Slack accepted. */
  readonly slack: number;
  /** Microsoft Teams webhook posts Teams accepted. */
  readonly msTeams: number;
  /** When suppressed, the ISO timestamp at which this key can page again. */
  readonly retryAt?: string;
}

interface InfraPage {
  /** Alert the workflow's owners. Repeat pages under the same key are throttled. */
  (message: string, opts?: PageOptions): Promise<PageResult>;
  /** Alert the workflow's owners, passing every option in one object. */
  (spec: PageSpec): Promise<PageResult>;
  /**
   * Clear a key's cooldown so the next page under it delivers immediately.
   * Call this once the condition you alerted on has recovered.
   */
  clear(key?: string): Promise<void>;
}`;

/**
 * `infra.waitForApproval` — a human gate in the middle of a run. Mirrors
 * `ApprovalSpec` / `ApprovalResult` in types.ts.
 */
const APPROVAL_INTERFACES = `interface ApprovalOptions {
  /** Short headline for the approval card. Defaults to this workflow's name. */
  title?: string;
  /**
   * Minutes to wait for a decision before the request expires and is treated
   * as denied. Defaults to 60; capped at 1440 (24 hours).
   */
  timeoutMinutes?: number;
}

interface ApprovalSpec extends ApprovalOptions {
  /** What the approver is deciding — shown on the approval card. */
  message: string;
}

interface ApprovalResult {
  readonly approved: true;
  /** Display name (or email) of the org member who approved. */
  readonly decidedBy?: string;
  /** ISO timestamp of the decision. */
  readonly decidedAt?: string;
}

interface InfraWaitForApproval {
  /**
   * Pause here until an org member approves or denies. Resolves on approval;
   * a denial or timeout **throws**, so an unhandled deny fails the run.
   */
  (message: string, opts?: ApprovalOptions): Promise<ApprovalResult>;
  /** Pause for approval, passing every option in one object. */
  (spec: ApprovalSpec): Promise<ApprovalResult>;
}`;

/**
 * The global `fetch`. Declared here rather than pulled from `lib.dom` because
 * the sandbox implements a deliberately small subset: a fully-buffered body
 * (so the reader methods can be called more than once), no `Request`/`Headers`
 * constructors, no streaming, no cookies — plus two non-standard options
 * (`timeoutMs`, `maxBytes`) that the host enforces. Mirrors what the prelude
 * builds and what `WorkflowFetchRequest` in types.ts validates.
 */
const FETCH_INTERFACES = `interface FetchInit {
  /** GET (default), HEAD, POST, PUT, PATCH, DELETE, or OPTIONS. */
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  /** Request headers. Hop-by-hop headers (host, content-length, …) are rejected. */
  headers?: Record<string, string>;
  /**
   * Request body. A string or bytes are sent as-is; anything else is
   * JSON-encoded and sent with \`content-type: application/json\` unless you
   * set that header yourself.
   */
  body?: string | Uint8Array | ArrayBuffer | JsonValue;
  /** Give up after this many milliseconds. Default 30000, max 120000. */
  timeoutMs?: number;
  /** Fail if the response body exceeds this many bytes. Default 5 MiB, max 10 MiB. */
  maxBytes?: number;
  /** "follow" (default; up to 5 hops) or "manual" to get the 3xx back. */
  redirect?: "follow" | "manual";
}

/** Response headers. Names are matched case-insensitively. */
interface FetchHeaders {
  get(name: string): string | null;
  has(name: string): boolean;
  keys(): string[];
  entries(): [string, string][];
  forEach(fn: (value: string, name: string) => void): void;
  toJSON(): Record<string, string>;
}

/**
 * A fetched response. The body is already buffered, so \`text()\`/\`json()\`/
 * \`bytes()\` can each be called more than once (unlike a browser Response).
 */
interface FetchResponse {
  /** HTTP status code. A 4xx/5xx resolves normally — check \`ok\` or \`status\`. */
  readonly status: number;
  readonly statusText: string;
  /** True for 2xx. */
  readonly ok: boolean;
  /** Final URL, after any redirects that were followed. */
  readonly url: string;
  readonly redirected: boolean;
  readonly headers: FetchHeaders;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  bytes(): Promise<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
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
   * Whether this host supports human-approval gates (cloud only — approvals
   * are org-level records with notifications). When false,
   * `infra.waitForApproval` is typed `never` so a desktop author sees it's
   * unavailable while editing instead of at run time.
   */
  approvals?: boolean;
  /**
   * Names of the caller's Infrawrench-managed SSH keys. Surfaced as autocomplete
   * for `ssh-key-picker` create fields and `resource.ssh`'s `sshKey` option.
   * Fetched fresh per typings request so newly-added keys appear immediately.
   */
  sshKeyNames?: string[];
  /**
   * Read-plus-SSH surface only (custom graphs): strips create/update/delete,
   * importYaml, publish, and sftp from every type and sidecar, and types
   * `infra.page` as unavailable. The runtime enforces the same boundary — this
   * just makes the editor say so first.
   */
  readOnly?: boolean;
}

/** Strip every mutating accessor for {@link GenerateInfraDtsInput.readOnly}. */
function stripMutations(plugins: WorkflowPluginInfo[]): WorkflowPluginInfo[] {
  const stripTypes = (types: WorkflowResourceTypeInfo[]): WorkflowResourceTypeInfo[] =>
    types.map((rt) => ({
      ...rt,
      supportsCreate: false,
      supportsUpdate: false,
      supportsDelete: false,
      ...(rt.capabilities
        ? { capabilities: { ...rt.capabilities, publish: false, sftp: false } }
        : {}),
      sidecars: (rt.sidecars ?? []).map((sc) => ({
        ...sc,
        resourceTypes: stripTypes(sc.resourceTypes),
      })),
    }));
  return plugins.map((p) => ({
    ...p,
    supportsImportYaml: false,
    resourceTypes: stripTypes(p.resourceTypes),
  }));
}

/**
 * Collect the per-type interfaces for a plugin's resource types, recursing into
 * each type's sidecars.
 *
 * Deduped by interface name because the same peer plugin is reachable from
 * several parents (every managed-cluster type exposes `kubernetes`) and may
 * additionally have an account of its own — and TypeScript rejects a duplicated
 * interface declaration. The declarations are identical when the names collide:
 * both are derived from the same plugin id and type id.
 */
function collectResourceInterfaces(
  pluginId: string,
  types: WorkflowResourceTypeInfo[],
  resourceOut: Map<string, string>,
  sidecarOut: Map<string, string>,
  sshKeyNames: string[],
  readOnly = false,
): void {
  for (const rt of dedupedResourceTypes(types)) {
    const name = resourceTypeInterfaceName(pluginId, rt.id);
    if (!resourceOut.has(name)) resourceOut.set(name, renderResourceTypeInterface(pluginId, rt));
    for (const sc of rt.sidecars ?? []) {
      if (sc.resourceTypes.length === 0) continue;
      const scName = sidecarInterfaceName(sc.pluginId);
      if (!sidecarOut.has(scName)) {
        sidecarOut.set(scName, renderSidecarInterface(sc, sshKeyNames, readOnly));
      }
      collectResourceInterfaces(
        sc.pluginId,
        sc.resourceTypes,
        resourceOut,
        sidecarOut,
        sshKeyNames,
        readOnly,
      );
    }
  }
}

/** Build the full `infra.d.ts` source string. */
export function generateInfraDts(input: GenerateInfraDtsInput): string {
  const readOnly = input.readOnly ?? false;
  const plugins = readOnly ? stripMutations(input.plugins) : input.plugins;
  const interactive = input.interactive ?? true;
  const sshKeyNames = input.sshKeyNames ?? [];

  const resourceByName = new Map<string, string>();
  const sidecarByName = new Map<string, string>();
  for (const plugin of plugins) {
    collectResourceInterfaces(
      plugin.pluginId,
      plugin.resourceTypes,
      resourceByName,
      sidecarByName,
      sshKeyNames,
      readOnly,
    );
  }
  const resourceInterfaces = [...resourceByName.values(), ...sidecarByName.values()].join("\n\n");
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

  const pageDecl = readOnly
    ? `  /** Unavailable here — alerting belongs to workflows, not graphs. */\n  page: never;`
    : `  /**
   * Alert the humans who own this workflow — SMS/voice (Twilio) and mobile
   * push in the cloud, a desktop notification locally. Repeat pages under the
   * same key are throttled, so a monitoring cron can call this every run and
   * only the first occurrence gets through.
   */
  readonly page: InfraPage;`;
  const costsDecl =
    input.costs === false
      ? `  /** Unavailable here — cost reporting needs the cloud's cost store. */\n  costs: never;`
      : `  /** Report spend from a source Infrawrench has no plugin for. */\n  readonly costs: InfraCosts;`;
  const approvalsOff = readOnly || input.approvals === false;
  const approvalsDecl = approvalsOff
    ? `  /** Unavailable here — approval gates need the cloud's approvals surface. */\n  waitForApproval: never;`
    : `  /**
   * Pause the run until an org member approves or denies. The pending request
   * shows on the run view (and notifies the org); a denial or timeout throws,
   * so an unhandled deny fails the run. Timeout defaults to 60 minutes.
   */
  readonly waitForApproval: InfraWaitForApproval;`;

  return `${STATIC_PREAMBLE}

${renderEventType(input.triggerKind ?? "manual")}

${input.costs === false ? "" : COSTS_INTERFACE}

${approvalsOff ? "" : APPROVAL_INTERFACES}

${PAGE_INTERFACE}

${FETCH_INTERFACES}

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
${pageDecl}
${approvalsDecl}
  /** Record a JSON-serializable result for this run. */
  output(value: JsonValue): Promise<void>;
  /** Stream an SSH \`{ stdout, stderr }\` object to the run log live (stderr in red). */
  log(streams: SshStreams): Promise<void>;
  /** Append a line to the run log. Byte buffers (Uint8Array/ArrayBuffer) are decoded as UTF-8 text. */
  log(...parts: unknown[]): Promise<void>;
}

declare const infra: InfraApi;

/**
 * Call an HTTP API. In the cloud the request is made by a proxy that sits
 * outside the Kubernetes cluster the workflow runs in, so only the public
 * internet is reachable — private and cluster-internal addresses are refused.
 * On the desktop app the request comes from your own machine, so your LAN is
 * reachable too.
 */
declare function fetch(url: string, init?: FetchInit): Promise<FetchResponse>;
`;
}
