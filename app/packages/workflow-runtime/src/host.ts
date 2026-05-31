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
