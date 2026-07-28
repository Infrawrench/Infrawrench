/**
 * The host adapter contract. Each platform (web server, poller, Electron main)
 * implements {@link WorkflowHost} to give the sandboxed `infra` object real
 * powers: reaching plugin clients, prompting the user, reading storage, and
 * persisting metrics.
 *
 * The sandbox talks to the host through a single async RPC function (see
 * ./sandbox + ./prelude); {@link dispatch} is the router for that RPC.
 */

import {
  ALLOWED_FETCH_METHODS,
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_PAGE_COOLDOWN_MINUTES,
  DEFAULT_PAGE_KEY,
  FORBIDDEN_FETCH_HEADERS,
  MAX_FETCH_BODY_BYTES,
  MAX_FETCH_HEADER_NAME_LENGTH,
  MAX_FETCH_HEADER_VALUE_LENGTH,
  MAX_FETCH_HEADERS,
  MAX_FETCH_MAX_BYTES,
  MAX_FETCH_TIMEOUT_MS,
} from "./types.js";
import type {
  LogLevel,
  MetricValue,
  PageResult,
  PageSpec,
  PromptSpec,
  RunLogEntry,
  WorkflowCostRow,
  WorkflowCostWriteResult,
  WorkflowFetchRequest,
  WorkflowFetchResponse,
  WorkflowPluginInfo,
} from "./types.js";
import type {
  BuildRequest,
  BuildTarget,
  BuildTargetResource,
  InfrafileHostOps,
  InfrafileRunSink,
  RegistryCredentials,
  RunInImageRequest,
} from "./infrafile/types.js";

/**
 * Identifies a peer plugin reached *through* a parent resource, rather than
 * through an account of its own — the `kubernetes` plugin inside a managed
 * cluster, `postgres` inside a managed database. The sandbox attaches one to
 * every RPC it makes against a sidecar resource so the host knows to build the
 * peer plugin's client (credentials resolved from the parent resource's
 * outputs) instead of the account's own client.
 *
 * `accountId` stays the parent's account throughout: a sidecar borrows its
 * parent's account for credentials and permissions, it is not an account.
 */
export interface SidecarRef {
  /** The peer plugin's id, e.g. "kubernetes". */
  pluginId: string;
  /** Resource id of the parent supplying the peer plugin's credentials. */
  parentResourceId: string;
}

/** Transport-friendly subset of plugin-base's ResourceInstance. */
export interface ResourceInstanceLite {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId?: string;
  fields: Record<string, string | number | boolean>;
  resolvedOutputs: Record<string, string>;
  /**
   * The Infrawrench SSH key (name/id) attached at create time, if any — so
   * `resource.ssh(...)` on a just-created resource can authenticate without the
   * author re-specifying the key. Set only by `createResource`.
   */
  sshKeyRef?: string;
}

export interface StorageObjectLite {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
}

export interface StorageObjectBody {
  /** Base64-encoded raw bytes. */
  base64: string;
  /** Best-effort UTF-8 decode of the bytes (for `.text()` / `.json()`). */
  text: string;
}

/** Identifies the resource to SSH into, plus the command and auth hints. */
export interface SshExecParamsLite {
  accountId: string;
  typeId: string;
  /** Provider/external id of the resource (e.g. a droplet id). */
  resourceId: string;
  command: string;
  /** Org SSH key (id or name) whose private half authenticates. */
  sshKeyId?: string;
  username?: string;
  timeoutMs?: number;
  /** Accept any host key without verifying/pinning it (MITM protection off). */
  skipHostKeyCheck?: boolean;
}

/** Full result of a non-streaming SSH command. Output is base64 (binary-safe). */
export interface SshExecResultLite {
  stdoutBase64: string;
  stderrBase64: string;
  code: number;
}

/** One poll of a streaming SSH command — separate stdout/stderr chunks. */
export interface SshStreamChunkLite {
  /** Base64 chunk of stdout accumulated since the last read (if any). */
  stdoutBase64?: string;
  /** Base64 chunk of stderr accumulated since the last read (if any). */
  stderrBase64?: string;
  done: boolean;
  /** Exit code, present on the terminal read. */
  code?: number;
}

/** Probe whether a resource is SSH-reachable yet (for waitUntilReachable). */
export interface SshProbeParamsLite {
  accountId: string;
  typeId: string;
  resourceId: string;
  port?: number;
  timeoutMs?: number;
}

/** Identifies the resource + SSH auth for an SFTP operation. */
export interface SftpParamsLite {
  accountId: string;
  typeId: string;
  resourceId: string;
  sshKeyId?: string;
  username?: string;
}

/** A directory entry returned by `sftp.list`. */
export interface SftpEntryLite {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
}

/** Per-run context the host threads through dispatch. */
export interface WorkflowRunContext {
  /** Whether `infra.prompt` is allowed (manual/interactive runs only). */
  interactive: boolean;
  /** Append a structured log line (also surfaced live to the UI). */
  log(entry: RunLogEntry): void;
  /** Records the value the workflow declared via `infra.output(...)`. */
  setOutput(value: unknown): void;
  /**
   * Present only on an Infrafile run. Collects the stage artifacts (chosen env,
   * plan, rendered Dockerfile, notes) that are pure bookkeeping and therefore
   * identical on every platform — see `infrafile/types.ts`.
   */
  infrafile?: InfrafileRunSink;
}

/**
 * Platform-supplied capabilities. All methods operate within the trust scope
 * the host established (org on web, local user on desktop) — the sandbox can
 * never reach beyond what these expose.
 */
export interface WorkflowHost {
  /** Accounts grouped by plugin, used to build `infra.accounts` at runtime. */
  listPlugins(): Promise<WorkflowPluginInfo[]>;

  /**
   * Every resource operation takes an optional trailing {@link SidecarRef}.
   * When present the operation targets a peer plugin reached through a parent
   * resource (see {@link SidecarRef}) rather than the account's own plugin;
   * hosts that can't resolve peer clients may ignore it, and the peer surface
   * simply won't work for them.
   */
  listResources(
    accountId: string,
    typeId: string,
    sidecar?: SidecarRef,
  ): Promise<ResourceInstanceLite[]>;
  getResource(
    accountId: string,
    typeId: string,
    externalId: string,
    sidecar?: SidecarRef,
  ): Promise<ResourceInstanceLite>;
  resolveOutput(
    accountId: string,
    typeId: string,
    resourceId: string,
    outputKey: string,
    sidecar?: SidecarRef,
  ): Promise<string>;

  createResource?(
    accountId: string,
    typeId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
    sidecar?: SidecarRef,
  ): Promise<ResourceInstanceLite>;
  updateResource?(
    accountId: string,
    typeId: string,
    resourceId: string,
    fields: Record<string, string>,
    sidecar?: SidecarRef,
  ): Promise<ResourceInstanceLite>;
  deleteResource?(
    accountId: string,
    typeId: string,
    resourceId: string,
    sidecar?: SidecarRef,
  ): Promise<void>;

  listStorageObjects(
    accountId: string,
    bucket: string,
    prefix: string,
  ): Promise<StorageObjectLite[]>;
  readStorageObject(accountId: string, bucket: string, key: string): Promise<StorageObjectBody>;

  /** Raise an interactive prompt. Implementations should reject if non-interactive. */
  prompt(spec: PromptSpec): Promise<MetricValue>;

  getMetric(key: string): Promise<MetricValue>;
  setMetric(key: string, value: MetricValue): Promise<void>;
  /**
   * Snapshot of every declared metric's current value, keyed by metric key.
   * Read once at run start to seed `infra.metrics.<key>` for synchronous,
   * typed property access inside the workflow.
   */
  listMetrics(): Promise<Record<string, MetricValue>>;

  /**
   * SSH into a resource and run a command to completion (powers
   * `resource.ssh(cmd)`). Optional — hosts without SSH support omit it and the
   * call surfaces a {@link WorkflowCapabilityError}.
   */
  sshExec?(params: SshExecParamsLite): Promise<SshExecResultLite>;
  /** Begin a streaming SSH command; returns a token for {@link sshStreamRead}. */
  sshStreamStart?(params: SshExecParamsLite): Promise<{ streamId: string }>;
  /** Read the next stdout chunk of a streaming command (resolves when ready or done). */
  sshStreamRead?(streamId: string): Promise<SshStreamChunkLite>;
  /** Tear down a streaming command early (on iterator break/return). */
  sshStreamClose?(streamId: string): Promise<void>;
  /** Poll until the resource accepts TCP on the SSH port, or time out. */
  sshProbe?(params: SshProbeParamsLite): Promise<boolean>;

  /** List a directory over SFTP (powers `resource.sftp.list`). */
  sftpList?(params: SftpParamsLite, path: string): Promise<SftpEntryLite[]>;
  /** Download a file over SFTP, returned as base64. */
  sftpGet?(params: SftpParamsLite, path: string): Promise<{ base64: string }>;
  /** Upload base64 bytes to a path over SFTP. */
  sftpPut?(params: SftpParamsLite, path: string, base64: string): Promise<void>;
  /** Create a directory over SFTP. */
  sftpMkdir?(params: SftpParamsLite, path: string): Promise<void>;
  /** Delete a file or directory over SFTP. */
  sftpDelete?(params: SftpParamsLite, path: string, isDir: boolean): Promise<void>;

  /**
   * Report daily spend into the org's cost store (powers `infra.costs.write`).
   * Cloud-only — the desktop host omits it and the call surfaces a
   * {@link WorkflowCapabilityError}, since cost data lives in ClickHouse.
   */
  writeCosts?(rows: WorkflowCostRow[]): Promise<WorkflowCostWriteResult>;

  /**
   * Raise an alert to the humans who own this workflow (powers `infra.page`).
   * The host owns both delivery (SMS/voice/push on the cloud, a desktop
   * notification locally) and the per-key cooldown, so a workflow that finds
   * the same problem every run pages once rather than every run.
   */
  page?(spec: PageSpec): Promise<PageResult>;
  /**
   * Clear a page key's cooldown so the next `infra.page` under it delivers
   * immediately (powers `infra.page.clear`). Called when a workflow observes
   * that the condition it alerted on has recovered.
   */
  clearPage?(key: string): Promise<void>;

  /**
   * Make one outbound HTTP request on the workflow's behalf (powers the
   * sandbox's global `fetch`). The request is already normalized and validated
   * by {@link dispatch}; what a host adds is *where the request leaves from* —
   * the cloud sends it through an egress proxy that lives outside the Kubernetes
   * cluster, so a workflow can never reach cluster-internal services, while
   * desktop just makes the call from the user's own machine.
   */
  fetch?(request: WorkflowFetchRequest): Promise<WorkflowFetchResponse>;

  /**
   * Debugger hook: reports the 1-based source line about to execute (instrumented
   * runs only). Implementations highlight the line and may block to pause at a
   * breakpoint. Resolving continues the run; rejecting aborts it (Stop).
   */
  line?(line: number): Promise<void>;

  // --- extended resource capabilities (plugin-client passthroughs) ---------
  /** Run a SQL query against a resource (REST query engines, e.g. BigQuery). */
  query?(
    accountId: string,
    resourceId: string,
    sql: string,
    sidecar?: SidecarRef,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs?: number }>;
  /** List keys in a KV/Redis namespace resource. */
  kvList?(
    accountId: string,
    typeId: string,
    resourceId: string,
    params: { prefix?: string; cursor?: string; limit?: number },
    sidecar?: SidecarRef,
  ): Promise<{ items: { key: string }[]; nextCursor?: string }>;
  /** Read a single KV value. */
  kvGet?(
    accountId: string,
    typeId: string,
    resourceId: string,
    key: string,
    sidecar?: SidecarRef,
  ): Promise<string>;
  /** Write a single KV value. */
  kvPut?(
    accountId: string,
    typeId: string,
    resourceId: string,
    key: string,
    value: string,
    sidecar?: SidecarRef,
  ): Promise<void>;
  /** Delete a single KV key. */
  kvDelete?(
    accountId: string,
    typeId: string,
    resourceId: string,
    key: string,
    sidecar?: SidecarRef,
  ): Promise<void>;
  /** Run a document-store command (Firestore/Mongo/DynamoDB). */
  nosql?(
    accountId: string,
    typeId: string,
    resourceId: string,
    command: string,
    args: (string | number)[],
    sidecar?: SidecarRef,
  ): Promise<unknown>;
  /** Fetch a resource's recent logs (k8s-style). */
  getLogs?(
    accountId: string,
    typeId: string,
    resourceId: string,
    params: { tailLines?: number; container?: string; previous?: boolean },
    sidecar?: SidecarRef,
  ): Promise<{ text: string; containers: string[]; activeContainer: string }>;
  /** Plain-text "describe" of a resource (k8s-style). */
  describe?(
    accountId: string,
    typeId: string,
    resourceId: string,
    sidecar?: SidecarRef,
  ): Promise<string>;
  /** Fetch a resource's full manifest (JSON/YAML text). */
  getManifest?(accountId: string, resourceId: string, sidecar?: SidecarRef): Promise<string>;
  /** Apply an updated manifest to a resource. */
  applyManifest?(
    accountId: string,
    resourceId: string,
    manifest: string,
    sidecar?: SidecarRef,
  ): Promise<void>;
  /** Apply arbitrary (multi-doc) YAML to an account (kubectl apply -f). */
  importYaml?(accountId: string, yaml: string): Promise<{ applied: number }>;
  /** Publish a message to a pub/sub resource. */
  publish?(
    accountId: string,
    typeId: string,
    resourceId: string,
    payload: { body: string; extras?: Record<string, string | Record<string, string>> },
    sidecar?: SidecarRef,
  ): Promise<{ id?: string; summary?: string }>;
  /** Fetch a resource's provider metric series. */
  metricSeries?(
    accountId: string,
    typeId: string,
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
    sidecar?: SidecarRef,
  ): Promise<{ label: string; unit?: string; points: { timestamp: number; value: number }[] }[]>;
}

/**
 * A host that can additionally run an Infrafile. The build/push/copy ops are
 * separate from {@link WorkflowHost} because a plain workflow never needs them —
 * only a host driving `runInfrafile` has to implement any of it.
 */
export type InfrafileHost = WorkflowHost & InfrafileHostOps;

/** Error thrown when a workflow uses a capability unavailable in its context. */
export class WorkflowCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCapabilityError";
  }
}

function requireMethod<T>(fn: T | undefined, name: string): T {
  if (!fn) {
    throw new WorkflowCapabilityError(`This workflow host does not support "${name}".`);
  }
  return fn;
}

/**
 * Marshal the optional `sidecar` RPC arg. Absent (the common case) or missing
 * either half means "the account's own plugin" — a half-specified ref would be
 * unresolvable, so it's treated as absent rather than passed on to fail deeper.
 */
function sidecarRef(raw: unknown): SidecarRef | undefined {
  const spec = raw as Record<string, unknown> | null | undefined;
  if (!spec) return undefined;
  const pluginId = String(spec["pluginId"] ?? "");
  const parentResourceId = String(spec["parentResourceId"] ?? "");
  if (!pluginId || !parentResourceId) return undefined;
  return { pluginId, parentResourceId };
}

/** Marshal the common SFTP RPC args into {@link SftpParamsLite}. */
function sftpParams(args: Record<string, unknown>): SftpParamsLite {
  return {
    accountId: String(args["accountId"]),
    typeId: String(args["typeId"]),
    resourceId: String(args["resourceId"]),
    ...(args["sshKeyId"] ? { sshKeyId: String(args["sshKeyId"]) } : {}),
    ...(args["username"] ? { username: String(args["username"]) } : {}),
  };
}

/** Longest page message we forward; transports truncate further as needed. */
/** Largest rendered Dockerfile we will carry across the bridge. */
const MAX_DOCKERFILE_BYTES = 256 * 1024;

/** Deploy notes are log lines, not essays. */
const MAX_NOTE_LENGTH = 4000;

/**
 * The `infrafile` sink is installed by `runInfrafile`. Reaching one of these
 * RPCs without it means an Infrafile epilogue ran under the plain workflow
 * runner, which is a wiring bug rather than anything the author did.
 */
function requireInfrafileSink(ctx: WorkflowRunContext): InfrafileRunSink {
  if (!ctx.infrafile) {
    throw new Error("Infrafile stage RPC used outside an Infrafile run.");
  }
  return ctx.infrafile;
}

/**
 * Where to build, read off the plan's reserved `buildOn` key. A resource handle
 * arrives here as its plain identifying fields — `JSON.stringify` dropped the
 * methods the prelude mixed on, which is exactly what we want to send onward.
 *
 * Returning `undefined` lets the host apply its own default (local for the CLI).
 */
function buildTarget(raw: unknown): BuildTarget | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    if (raw === "local") return { kind: "local" };
    throw new Error(
      `plan().buildOn must be a resource or the string "local", not ${JSON.stringify(raw)}.`,
    );
  }
  if (typeof raw !== "object") {
    throw new Error('plan().buildOn must be a resource or the string "local".');
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r["id"] === "string" ? r["id"] : "";
  const accountId = typeof r["accountId"] === "string" ? r["accountId"] : "";
  const resourceTypeId = typeof r["resourceTypeId"] === "string" ? r["resourceTypeId"] : "";
  if (!id || !accountId || !resourceTypeId) {
    throw new Error(
      "plan().buildOn looks like an object but is not a resource — expected one from " +
        "infra.accounts.<plugin>.<group>.list()/get().",
    );
  }
  const resource: BuildTargetResource = { id, accountId, resourceTypeId };
  if (typeof r["displayName"] === "string") resource.displayName = r["displayName"];
  return { kind: "resource", resource };
}

/** Registry credentials off the plan's reserved `registry` key, if present. */
function registryCredentials(raw: unknown): RegistryCredentials | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") throw new Error("plan().registry must be an object.");
  const r = raw as Record<string, unknown>;
  const host = String(r["host"] ?? "").trim();
  const username = String(r["username"] ?? "");
  const password = String(r["password"] ?? "");
  if (!host || !username || !password) {
    throw new Error("plan().registry needs host, username and password.");
  }
  return { host, username, password };
}

/**
 * Assemble the build request from the rendered Dockerfile plus the plan's
 * reserved keys. Validation lives here so every host — local Docker on the CLI,
 * SSH on the server — receives an identical, already-checked request.
 */
function buildRequest(args: Record<string, unknown>): BuildRequest {
  const dockerfile = String(args["dockerfile"] ?? "");
  if (!dockerfile.trim()) throw new Error("dockerfile() produced no content.");
  if (dockerfile.length > MAX_DOCKERFILE_BYTES) {
    throw new Error(`Rendered Dockerfile exceeds ${MAX_DOCKERFILE_BYTES} bytes.`);
  }
  const plan = (args["plan"] ?? {}) as Record<string, unknown>;
  const target = buildTarget(plan["buildOn"]);
  const registry = registryCredentials(plan["registry"]);

  const buildArgs: Record<string, string> = {};
  const rawArgs = plan["buildArgs"];
  if (rawArgs && typeof rawArgs === "object") {
    for (const [k, v] of Object.entries(rawArgs as Record<string, unknown>)) {
      if (v !== undefined && v !== null) buildArgs[k] = String(v);
    }
  }

  const request: BuildRequest = { env: String(args["env"] ?? ""), dockerfile };
  if (target) request.target = target;
  if (registry) request.registry = registry;
  if (typeof plan["tag"] === "string" && plan["tag"]) request.tag = plan["tag"];
  if (Object.keys(buildArgs).length > 0) request.args = buildArgs;
  return request;
}

/** Command line length accepted by `run(...)`. Generous, but not unbounded. */
const MAX_RUN_COMMAND = 16 * 1024;

/** Environment variables per `run(...)` call. */
const MAX_RUN_ENV_VARS = 200;

/**
 * Marshal + validate a `run(command, opts)` call. Normalizing here means the
 * local Docker path and the SSH path receive an identical request, and it is
 * the single place that bounds what the guest can ask for.
 */
function runInImageRequest(args: Record<string, unknown>): RunInImageRequest {
  const image = String(args["image"] ?? "").trim();
  if (!image) throw new Error("run(): no image to run — was the build skipped?");
  const command = String(args["command"] ?? "").trim();
  if (!command) throw new Error("run(command): command must be a non-empty string.");
  if (command.length > MAX_RUN_COMMAND) {
    throw new Error(`run(): command exceeds ${MAX_RUN_COMMAND} characters.`);
  }

  const request: RunInImageRequest = { image, command };

  const rawEnv = args["env"];
  if (rawEnv !== undefined && rawEnv !== null) {
    if (typeof rawEnv !== "object") throw new Error("run(): `env` must be an object.");
    const entries = Object.entries(rawEnv as Record<string, unknown>);
    if (entries.length > MAX_RUN_ENV_VARS) {
      throw new Error(`run(): at most ${MAX_RUN_ENV_VARS} environment variables.`);
    }
    const env: Record<string, string> = {};
    for (const [key, value] of entries) {
      // A newline in a name or value lets a caller forge extra variables
      // wherever the host writes these as `KEY=value` lines (an env-file, a
      // shell export). Refuse rather than sanitize.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`run(): ${JSON.stringify(key)} is not a valid environment variable name.`);
      }
      const text = String(value ?? "");
      if (text.includes("\n") || text.includes("\0")) {
        throw new Error(`run(): the value of ${key} may not contain newlines.`);
      }
      env[key] = text;
    }
    request.env = env;
  }

  // Default `sh` rather than leaving it unset: see RunInImageRequest.entrypoint
  // for why the image's own ENTRYPOINT must not be in play here.
  const entrypoint = args["entrypoint"];
  request.entrypoint = typeof entrypoint === "string" ? entrypoint : "sh";
  if (request.entrypoint.includes("\n")) {
    throw new Error("run(): `entrypoint` may not contain newlines.");
  }
  if (typeof args["workdir"] === "string" && args["workdir"]) {
    request.workdir = args["workdir"];
  }
  if (args["mountSource"] === false) request.mountSource = false;
  if (args["allowFailure"] === true) request.allowFailure = true;
  return request;
}

const MAX_PAGE_MESSAGE = 1000;

/**
 * Marshal + validate the `infra.page(...)` argument. Defaults are applied here
 * rather than in the prelude so every host sees the same normalized spec, and a
 * blank message is rejected outright — an empty page is a page nobody can act on.
 */
function pageSpec(raw: unknown): PageSpec {
  const spec = (raw ?? {}) as Record<string, unknown>;
  const message = String(spec["message"] ?? "").trim();
  if (!message) throw new Error("infra.page() needs a message describing the alert.");
  const cooldown = Number(spec["cooldownMinutes"] ?? DEFAULT_PAGE_COOLDOWN_MINUTES);
  return {
    message: message.slice(0, MAX_PAGE_MESSAGE),
    ...(spec["title"] ? { title: String(spec["title"]).slice(0, 120) } : {}),
    key: String(spec["key"] || DEFAULT_PAGE_KEY).slice(0, 200),
    cooldownMinutes: Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 0,
    ...(spec["voice"] ? { voice: true } : {}),
  };
}

/** Bytes a base64 string decodes to, without decoding it. */
function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Clamp a caller-supplied number into a range, falling back when unusable. */
function clamp(raw: unknown, fallback: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

/** RFC 7230 token, which is what a header name is allowed to be. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Marshal + validate the sandbox's `fetch(...)` arguments.
 *
 * Everything a host could be tricked by is settled here, once, so no host has
 * to re-derive it: the URL must be absolute `http`/`https` (no `file:`, no
 * `data:`), the method must be one a workflow is allowed to send, hop-by-hop
 * headers are dropped, and the sizes are bounded on both directions. Where the
 * request physically leaves from is the host's business (see `WorkflowHost.fetch`).
 */
function fetchRequest(raw: unknown): WorkflowFetchRequest {
  const args = (raw ?? {}) as Record<string, unknown>;

  const rawUrl = String(args["url"] ?? "").trim();
  if (!rawUrl) throw new Error("fetch() needs a URL.");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`fetch() needs an absolute URL, got ${JSON.stringify(rawUrl)}.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`fetch() only supports http and https URLs, not ${url.protocol}`);
  }

  const method = String(args["method"] ?? "GET").toUpperCase();
  if (!(ALLOWED_FETCH_METHODS as readonly string[]).includes(method)) {
    throw new Error(
      `fetch() does not support the ${method} method (allowed: ${ALLOWED_FETCH_METHODS.join(", ")}).`,
    );
  }

  const headers: Record<string, string> = {};
  const rawHeaders = (args["headers"] ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (value === undefined || value === null) continue;
    const lower = name.toLowerCase();
    if (FORBIDDEN_FETCH_HEADERS.has(lower)) {
      throw new Error(`fetch() cannot set the ${lower} header.`);
    }
    if (!HEADER_NAME_RE.test(lower) || lower.length > MAX_FETCH_HEADER_NAME_LENGTH) {
      throw new Error(`fetch() got an invalid header name: ${JSON.stringify(name)}`);
    }
    const text = String(value);
    if (text.length > MAX_FETCH_HEADER_VALUE_LENGTH) {
      throw new Error(`fetch() header ${lower} is longer than ${MAX_FETCH_HEADER_VALUE_LENGTH}.`);
    }
    // A newline in a value would let a caller inject extra headers downstream.
    if (/[\r\n]/.test(text)) {
      throw new Error(`fetch() header ${lower} may not contain a newline.`);
    }
    headers[lower] = text;
    if (Object.keys(headers).length > MAX_FETCH_HEADERS) {
      throw new Error(`fetch() may send at most ${MAX_FETCH_HEADERS} headers.`);
    }
  }

  const bodyBase64 = args["bodyBase64"] === undefined ? undefined : String(args["bodyBase64"]);
  if (bodyBase64 !== undefined) {
    if (method === "GET" || method === "HEAD") {
      throw new Error(`fetch() cannot send a body with ${method}.`);
    }
    if (base64ByteLength(bodyBase64) > MAX_FETCH_BODY_BYTES) {
      throw new Error(`fetch() request bodies are limited to ${MAX_FETCH_BODY_BYTES} bytes.`);
    }
  }

  return {
    url: url.toString(),
    method,
    headers,
    ...(bodyBase64 !== undefined ? { bodyBase64 } : {}),
    timeoutMs: clamp(args["timeoutMs"], DEFAULT_FETCH_TIMEOUT_MS, MAX_FETCH_TIMEOUT_MS),
    maxBytes: clamp(args["maxBytes"], DEFAULT_FETCH_MAX_BYTES, MAX_FETCH_MAX_BYTES),
    redirect: args["redirect"] === "manual" ? "manual" : "follow",
  };
}

/** Marshal the common SSH RPC args into {@link SshExecParamsLite}. */
function sshParams(args: Record<string, unknown>): SshExecParamsLite {
  return {
    accountId: String(args["accountId"]),
    typeId: String(args["typeId"]),
    resourceId: String(args["resourceId"]),
    command: String(args["command"] ?? ""),
    ...(args["sshKeyId"] ? { sshKeyId: String(args["sshKeyId"]) } : {}),
    ...(args["username"] ? { username: String(args["username"]) } : {}),
    ...(args["timeoutMs"] !== undefined ? { timeoutMs: Number(args["timeoutMs"]) } : {}),
    ...(args["skipHostKeyCheck"] ? { skipHostKeyCheck: true } : {}),
  };
}

/**
 * Routes a single `__host(method, args)` RPC from the sandbox to the host.
 * Always returns a JSON-serializable value (or void). Throwing here surfaces
 * as a thrown error inside the workflow.
 */
export async function dispatch(
  host: InfrafileHost,
  ctx: WorkflowRunContext,
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Present only on operations against a sidecar resource (see SidecarRef);
  // every other RPC leaves it undefined and targets the account's own plugin.
  const sidecar = sidecarRef(args["sidecar"]);

  switch (method) {
    case "accounts.list":
      return host.listPlugins();

    case "resource.list":
      return host.listResources(String(args["accountId"]), String(args["typeId"]), sidecar);

    case "resource.get":
      return host.getResource(
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["externalId"]),
        sidecar,
      );

    case "resource.resolveOutput":
      return host.resolveOutput(
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        String(args["outputKey"]),
        sidecar,
      );

    case "resource.create":
      return requireMethod(host.createResource, "createResource").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        (args["fields"] as Record<string, string>) ?? {},
        args["parentResourceId"] ? String(args["parentResourceId"]) : undefined,
        sidecar,
      );

    case "resource.update":
      return requireMethod(host.updateResource, "updateResource").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        (args["fields"] as Record<string, string>) ?? {},
        sidecar,
      );

    case "resource.delete":
      await requireMethod(host.deleteResource, "deleteResource").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        sidecar,
      );
      return null;

    case "storage.list":
      return host.listStorageObjects(
        String(args["accountId"]),
        String(args["bucket"]),
        String(args["prefix"] ?? ""),
      );

    case "storage.get":
      return host.readStorageObject(
        String(args["accountId"]),
        String(args["bucket"]),
        String(args["key"]),
      );

    case "prompt": {
      if (!ctx.interactive) {
        throw new WorkflowCapabilityError(
          "infra.prompt() is only available for manual (interactive) runs, not automated triggers.",
        );
      }
      return host.prompt(args["spec"] as PromptSpec);
    }

    case "ssh.exec":
      return requireMethod(host.sshExec, "sshExec").call(host, sshParams(args));

    case "ssh.streamStart":
      return requireMethod(host.sshStreamStart, "sshStreamStart").call(host, sshParams(args));

    case "ssh.streamRead":
      return requireMethod(host.sshStreamRead, "sshStreamRead").call(
        host,
        String(args["streamId"]),
      );

    case "ssh.streamClose":
      await requireMethod(host.sshStreamClose, "sshStreamClose").call(
        host,
        String(args["streamId"]),
      );
      return null;

    case "sftp.list":
      return requireMethod(host.sftpList, "sftpList").call(
        host,
        sftpParams(args),
        String(args["path"] ?? "."),
      );

    case "sftp.get":
      return requireMethod(host.sftpGet, "sftpGet").call(
        host,
        sftpParams(args),
        String(args["path"]),
      );

    case "sftp.put":
      await requireMethod(host.sftpPut, "sftpPut").call(
        host,
        sftpParams(args),
        String(args["path"]),
        String(args["base64"] ?? ""),
      );
      return null;

    case "sftp.mkdir":
      await requireMethod(host.sftpMkdir, "sftpMkdir").call(
        host,
        sftpParams(args),
        String(args["path"]),
      );
      return null;

    case "sftp.delete":
      await requireMethod(host.sftpDelete, "sftpDelete").call(
        host,
        sftpParams(args),
        String(args["path"]),
        Boolean(args["isDir"]),
      );
      return null;

    case "ssh.probe":
      return requireMethod(host.sshProbe, "sshProbe").call(host, {
        accountId: String(args["accountId"]),
        typeId: String(args["typeId"]),
        resourceId: String(args["resourceId"]),
        ...(args["port"] !== undefined ? { port: Number(args["port"]) } : {}),
        ...(args["timeoutMs"] !== undefined ? { timeoutMs: Number(args["timeoutMs"]) } : {}),
      });

    case "line":
      await host.line?.(Number(args["line"]));
      return null;

    case "resource.query":
      return requireMethod(host.query, "query").call(
        host,
        String(args["accountId"]),
        String(args["resourceId"]),
        String(args["sql"]),
        sidecar,
      );

    case "kv.list":
      return requireMethod(host.kvList, "kvList").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        (args["params"] as { prefix?: string; cursor?: string; limit?: number }) ?? {},
        sidecar,
      );

    case "kv.get":
      return requireMethod(host.kvGet, "kvGet").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        String(args["key"]),
        sidecar,
      );

    case "kv.put":
      await requireMethod(host.kvPut, "kvPut").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        String(args["key"]),
        String(args["value"]),
        sidecar,
      );
      return null;

    case "kv.delete":
      await requireMethod(host.kvDelete, "kvDelete").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        String(args["key"]),
        sidecar,
      );
      return null;

    case "resource.nosql":
      return requireMethod(host.nosql, "nosql").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        String(args["command"]),
        (args["args"] as (string | number)[]) ?? [],
        sidecar,
      );

    case "resource.logs":
      return requireMethod(host.getLogs, "getLogs").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        (args["params"] as { tailLines?: number; container?: string; previous?: boolean }) ?? {},
        sidecar,
      );

    case "resource.describe":
      return requireMethod(host.describe, "describe").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        sidecar,
      );

    case "resource.getManifest":
      return requireMethod(host.getManifest, "getManifest").call(
        host,
        String(args["accountId"]),
        String(args["resourceId"]),
        sidecar,
      );

    case "resource.applyManifest":
      await requireMethod(host.applyManifest, "applyManifest").call(
        host,
        String(args["accountId"]),
        String(args["resourceId"]),
        String(args["manifest"]),
        sidecar,
      );
      return null;

    case "account.importYaml":
      return requireMethod(host.importYaml, "importYaml").call(
        host,
        String(args["accountId"]),
        String(args["yaml"]),
      );

    case "resource.publish":
      return requireMethod(host.publish, "publish").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        args["payload"] as {
          body: string;
          extras?: Record<string, string | Record<string, string>>;
        },
        sidecar,
      );

    case "resource.metrics":
      return requireMethod(host.metricSeries, "metricSeries").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        args["timeRange"] as { startMs: number; endMs: number } | undefined,
        sidecar,
      );

    case "costs.write":
      return requireMethod(host.writeCosts, "writeCosts").call(
        host,
        (args["rows"] as WorkflowCostRow[]) ?? [],
      );

    case "fetch":
      return requireMethod(host.fetch, "fetch").call(host, fetchRequest(args["request"]));

    case "page":
      return requireMethod(host.page, "page").call(host, pageSpec(args["spec"]));

    case "page.clear":
      await requireMethod(host.clearPage, "clearPage").call(
        host,
        String(args["key"] || DEFAULT_PAGE_KEY),
      );
      return null;

    case "metric.get":
      return host.getMetric(String(args["key"]));

    case "metric.set":
      await host.setMetric(String(args["key"]), args["value"] as MetricValue);
      return null;

    case "log":
      ctx.log({
        at: Date.now(),
        level: (args["level"] as LogLevel) ?? "info",
        message: String(args["message"] ?? ""),
      });
      return null;

    case "output":
      ctx.setOutput(args["value"]);
      return null;

    // ---- Infrafile stage boundaries -------------------------------------
    // Bookkeeping goes to the run's sink; only the genuinely platform-specific
    // work (build, push, copy, pre-supplied answers) reaches the host.

    case "infrafile.envs":
      return requireInfrafileSink(ctx).chooseEnv((args["envs"] as string[]) ?? []);

    case "infrafile.plan":
      return { proceed: requireInfrafileSink(ctx).recordPlan(args["plan"]) };

    case "infrafile.dockerfile":
      requireInfrafileSink(ctx).recordDockerfile(String(args["dockerfile"] ?? ""));
      return null;

    case "infrafile.select": {
      const key = String(args["key"] ?? "");
      const options = (args["options"] ?? []) as { label: string; value: string }[];
      // A pre-supplied answer (`--set key=value`) is what lets the same
      // Infrafile run unattended in CI, so it is checked before interactivity.
      const preset = await host.infrafileAnswer?.(key);
      if (preset !== undefined && preset !== null) return preset;
      if (!ctx.interactive) {
        throw new WorkflowCapabilityError(
          `select(${JSON.stringify(key)}, …) has no answer and this run is not interactive. ` +
            `Pass --set ${key}=<value>, where <value> is one of: ` +
            `${options.map((o) => o.value).join(", ")}.`,
        );
      }
      return host.prompt({
        message: String(args["label"] ?? key),
        kind: "select",
        options,
      });
    }

    case "infrafile.build": {
      ctx.infrafile?.stage("build");
      return requireMethod(host.infrafileBuild, "infrafileBuild").call(host, buildRequest(args));
    }

    case "infrafile.push": {
      const image = String(args["image"] ?? "").trim();
      // Matches the guard on run(): an empty image would otherwise surface as
      // `docker push ""` from a driver rather than as something an author can act on.
      if (!image) throw new Error("push(): no image to push — was the build skipped?");
      await requireMethod(host.infrafilePush, "infrafilePush").call(
        host,
        image,
        registryCredentials(args["registry"]),
      );
      return null;
    }

    case "infrafile.run": {
      const request = runInImageRequest(args);
      const result = await requireMethod(host.infrafileRun, "infrafileRun").call(host, request);
      // A non-zero exit is a failed deploy unless the author opted in to
      // handling it — the alternative is `wrangler deploy` failing silently
      // and the run reporting success.
      if (!request.allowFailure && result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout || "")
          .trim()
          .split("\n")
          .slice(-20)
          .join("\n");
        throw new Error(
          `run(${JSON.stringify(request.command)}) exited with code ${result.exitCode}` +
            (detail ? `:\n${detail}` : "."),
        );
      }
      return result;
    }

    case "infrafile.copyTo": {
      const target = buildTarget(args["target"]);
      if (!target || target.kind !== "resource") {
        throw new Error("copyTo(target, remotePath): target must be a resource to copy onto.");
      }
      await requireMethod(host.infrafileCopyTo, "infrafileCopyTo").call(
        host,
        target.resource,
        String(args["remotePath"] ?? ""),
      );
      return null;
    }

    case "infrafile.note":
      requireInfrafileSink(ctx).recordNote(String(args["text"] ?? "").slice(0, MAX_NOTE_LENGTH));
      return null;

    default:
      throw new Error(`Unknown workflow host method: ${method}`);
  }
}
