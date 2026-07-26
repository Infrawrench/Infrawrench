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
}

/**
 * Platform-supplied capabilities. All methods operate within the trust scope
 * the host established (org on web, local user on desktop) — the sandbox can
 * never reach beyond what these expose.
 */
export interface WorkflowHost {
  /** Accounts grouped by plugin, used to build `infra.accounts` at runtime. */
  listPlugins(): Promise<WorkflowPluginInfo[]>;

  listResources(accountId: string, typeId: string): Promise<ResourceInstanceLite[]>;
  getResource(accountId: string, typeId: string, externalId: string): Promise<ResourceInstanceLite>;
  resolveOutput(
    accountId: string,
    typeId: string,
    resourceId: string,
    outputKey: string,
  ): Promise<string>;

  createResource?(
    accountId: string,
    typeId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstanceLite>;
  updateResource?(
    accountId: string,
    typeId: string,
    resourceId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstanceLite>;
  deleteResource?(accountId: string, typeId: string, resourceId: string): Promise<void>;

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
  ): Promise<{ rows: Record<string, unknown>[]; durationMs?: number }>;
  /** List keys in a KV/Redis namespace resource. */
  kvList?(
    accountId: string,
    typeId: string,
    resourceId: string,
    params: { prefix?: string; cursor?: string; limit?: number },
  ): Promise<{ items: { key: string }[]; nextCursor?: string }>;
  /** Read a single KV value. */
  kvGet?(accountId: string, typeId: string, resourceId: string, key: string): Promise<string>;
  /** Write a single KV value. */
  kvPut?(
    accountId: string,
    typeId: string,
    resourceId: string,
    key: string,
    value: string,
  ): Promise<void>;
  /** Delete a single KV key. */
  kvDelete?(accountId: string, typeId: string, resourceId: string, key: string): Promise<void>;
  /** Run a document-store command (Firestore/Mongo/DynamoDB). */
  nosql?(
    accountId: string,
    typeId: string,
    resourceId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown>;
  /** Fetch a resource's recent logs (k8s-style). */
  getLogs?(
    accountId: string,
    typeId: string,
    resourceId: string,
    params: { tailLines?: number; container?: string; previous?: boolean },
  ): Promise<{ text: string; containers: string[]; activeContainer: string }>;
  /** Plain-text "describe" of a resource (k8s-style). */
  describe?(accountId: string, typeId: string, resourceId: string): Promise<string>;
  /** Fetch a resource's full manifest (JSON/YAML text). */
  getManifest?(accountId: string, resourceId: string): Promise<string>;
  /** Apply an updated manifest to a resource. */
  applyManifest?(accountId: string, resourceId: string, manifest: string): Promise<void>;
  /** Apply arbitrary (multi-doc) YAML to an account (kubectl apply -f). */
  importYaml?(accountId: string, yaml: string): Promise<{ applied: number }>;
  /** Publish a message to a pub/sub resource. */
  publish?(
    accountId: string,
    typeId: string,
    resourceId: string,
    payload: { body: string; extras?: Record<string, string | Record<string, string>> },
  ): Promise<{ id?: string; summary?: string }>;
  /** Fetch a resource's provider metric series. */
  metricSeries?(
    accountId: string,
    typeId: string,
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<{ label: string; unit?: string; points: { timestamp: number; value: number }[] }[]>;
}

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
  host: WorkflowHost,
  ctx: WorkflowRunContext,
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case "accounts.list":
      return host.listPlugins();

    case "resource.list":
      return host.listResources(String(args["accountId"]), String(args["typeId"]));

    case "resource.get":
      return host.getResource(
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["externalId"]),
      );

    case "resource.resolveOutput":
      return host.resolveOutput(
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        String(args["outputKey"]),
      );

    case "resource.create":
      return requireMethod(host.createResource, "createResource").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        (args["fields"] as Record<string, string>) ?? {},
        args["parentResourceId"] ? String(args["parentResourceId"]) : undefined,
      );

    case "resource.update":
      return requireMethod(host.updateResource, "updateResource").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        (args["fields"] as Record<string, string>) ?? {},
      );

    case "resource.delete":
      await requireMethod(host.deleteResource, "deleteResource").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
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
      );

    case "kv.list":
      return requireMethod(host.kvList, "kvList").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        (args["params"] as { prefix?: string; cursor?: string; limit?: number }) ?? {},
      );

    case "kv.get":
      return requireMethod(host.kvGet, "kvGet").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        String(args["key"]),
      );

    case "kv.put":
      await requireMethod(host.kvPut, "kvPut").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        String(args["key"]),
        String(args["value"]),
      );
      return null;

    case "kv.delete":
      await requireMethod(host.kvDelete, "kvDelete").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        String(args["key"]),
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
      );

    case "resource.logs":
      return requireMethod(host.getLogs, "getLogs").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        (args["params"] as { tailLines?: number; container?: string; previous?: boolean }) ?? {},
      );

    case "resource.describe":
      return requireMethod(host.describe, "describe").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
      );

    case "resource.getManifest":
      return requireMethod(host.getManifest, "getManifest").call(
        host,
        String(args["accountId"]),
        String(args["resourceId"]),
      );

    case "resource.applyManifest":
      await requireMethod(host.applyManifest, "applyManifest").call(
        host,
        String(args["accountId"]),
        String(args["resourceId"]),
        String(args["manifest"]),
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
      );

    case "resource.metrics":
      return requireMethod(host.metricSeries, "metricSeries").call(
        host,
        String(args["accountId"]),
        String(args["typeId"]),
        String(args["resourceId"]),
        args["timeRange"] as { startMs: number; endMs: number } | undefined,
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

    default:
      throw new Error(`Unknown workflow host method: ${method}`);
  }
}
