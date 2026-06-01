/**
 * The host adapter contract. Each platform (web server, poller, Electron main)
 * implements {@link WorkflowHost} to give the sandboxed `infra` object real
 * powers: reaching plugin clients, prompting the user, reading storage, and
 * persisting metrics.
 *
 * The sandbox talks to the host through a single async RPC function (see
 * ./sandbox + ./prelude); {@link dispatch} is the router for that RPC.
 */

import type {
  LogLevel,
  MetricValue,
  PromptSpec,
  RunLogEntry,
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

/** One poll of a streaming SSH command. */
export interface SshStreamChunkLite {
  /** Base64 chunk of stdout; absent on the terminal (done) read. */
  dataBase64?: string;
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

  /**
   * Debugger hook: reports the 1-based source line about to execute (instrumented
   * runs only). Implementations highlight the line and may block to pause at a
   * breakpoint. Resolving continues the run; rejecting aborts it (Stop).
   */
  line?(line: number): Promise<void>;
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
